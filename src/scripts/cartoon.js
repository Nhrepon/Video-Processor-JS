const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("@ffmpeg-installer/ffmpeg").path;
const ffprobePath = require("@ffprobe-installer/ffprobe").path;
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const {
  getRandomNumber,
  getAudioFiles,
  fileSha256Hex,
  timemarkToSeconds,
} = require("../utility/utility");

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

const INPUT_DIR = path.join(__dirname, "..", "input");
const INTRO_DIR = path.join(__dirname, "..", "intro");
const ASSETS_DIR = path.join(__dirname, "..", "assets");
const AUDIO_DIR = path.join(__dirname, "..", "audio");
const PART_DIR = path.join(__dirname, "..", "output", "tempParts"); // temp cut segments
const OUTPUT_DIR = path.join(__dirname, "..", "output", "cartoon"); // final 1:1 reels

// Unique per process so two runs never collide on temp or output names.
const RUN_ID = `${Date.now().toString(36)}-${process.pid}`;

const features = {
  intro: false,
  text: false,
  overlay: false,
  logo: true,
  partDuration: 200,
  minInputSeconds: 20,
  minPartSeconds: 15,
  speedFactor: 1.03,
  blur: false,
  blurSectionHeight: 100,
  trimStart: 20,
  trimEnd: 80,
};


// ------------------------------------------------------------------ config
const OUTPUT_SIZE = 1080; // 1:1 square frame
const OUTPUT_FPS = 30;
const X264_PRESET = "fast";
const CRF = "18"; // HD-quality (lower = better)
const OVERLAY_OPACITY = 0.18;
const OVERLAY_DURATION = 1.8;
const OVERLAY_MIN_GAP = 6;
const OVERLAY_MAX_GAP = 15;
const BLUR_STRENGTH = 3;
const VOICE_PITCH = 0.82;
const ORIGINAL_AUDIO_VOLUME = 0.8;
const BED_AUDIO_VOLUME = 0.19;
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".mkv", ".webm"]);
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

// ------------------------------------------------------------- small helpers
function getMediaDuration(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(new Error(`ffprobe failed for ${filePath}: ${err.message}`));
      const dur = metadata && metadata.format && Number(metadata.format.duration);
      if (!Number.isFinite(dur)) return reject(new Error(`No duration for ${filePath}`));
      resolve(dur);
    });
  });
}

function safeUnlink(file, label) {
  if (!file) return;
  try {
    fs.unlinkSync(file);
  } catch (e) {
    console.warn(`  (could not remove ${label || "temp"} ${path.basename(file)}: ${e.message})`);
  }
}

function escapeDrawtext(text) {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/%/g, "\\%");
}

function atempoFilters(factor) {
  factor = Number(factor) || 1;
  if (factor >= 0.5 && factor <= 2.0) return `atempo=${factor}`;
  const parts = [];
  let remaining = factor;
  while (remaining > 2.0) {
    parts.push("atempo=2.0");
    remaining /= 2.0;
  }
  while (remaining < 0.5) {
    parts.push("atempo=0.5");
    remaining *= 2.0;
  }
  parts.push(`atempo=${remaining.toFixed(6)}`);
  return parts.join(",");
}

function cutPart({ sourcePath, startSeconds, durationSeconds, outputPath }) {
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(sourcePath)
      .inputOptions(["-ss", String(startSeconds)])
      .outputOptions(["-t", String(durationSeconds), "-c", "copy", "-avoid_negative_ts", "make_zero"])
      .output(outputPath)
      .on("end", () => resolve(outputPath))
      .on("error", (err) => reject(err))
      .run();
  });
}

function extendVideoToMinimumDuration({ sourcePath, outputPath, minSeconds }) {
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(sourcePath)
      .inputOptions(["-stream_loop", "-1"])
      .outputOptions(["-t", String(minSeconds), "-c", "copy", "-avoid_negative_ts", "make_zero"])
      .output(outputPath)
      .on("end", () => resolve(outputPath))
      .on("error", (err) => reject(err))
      .run();
  });
}

// Apply trimStart/trimEnd ONCE to the whole main video (before it is split
// into parts). Parts processed afterwards are already trimmed, so videoProcessor
// must not re-trim them.
function trimMainVideo({ sourcePath, outputPath, trimStart, trimEnd }) {
  return new Promise((resolve, reject) => {
    sourceOptionsSafeDuration(sourcePath).then((total) => {
      // If we can't probe, fall back to a stream-copy trim with -ss/-to.
      if (!Number.isFinite(total) || total <= 0) {
        return ffmpeg()
          .input(sourcePath)
          .inputOptions(["-ss", String(trimStart)])
          .outputOptions(["-t", String(Math.max(0, 1)), "-c", "copy", "-avoid_negative_ts", "make_zero"])
          .output(outputPath)
          .on("end", () => resolve(outputPath))
          .on("error", (err) => reject(err))
          .run();
      }
      const dur = Math.max(0, total - trimEnd - trimStart);
      ffmpeg()
        .input(sourcePath)
        .inputOptions(["-ss", String(trimStart)])
        .outputOptions(["-t", String(dur), "-c", "copy", "-avoid_negative_ts", "make_zero"])
        .output(outputPath)
        .on("end", () => resolve(outputPath))
        .on("error", (err) => reject(err))
        .run();
    }).catch(reject);
  });
}

async function sourceOptionsSafeDuration(sourcePath) {
  try {
    return await getMediaDuration(sourcePath);
  } catch {
    return NaN;
  }
}

function planSegments(totalDuration, partSeconds, minPartSeconds) {
  const segments = [];
  let start = 0;
  const dur = Math.max(0, totalDuration);
  while (start < dur - 0.1) {
    const remaining = dur - start;
    let segDur = Math.min(partSeconds, remaining);
    if (segments.length > 0 && remaining < minPartSeconds) {
      // Fold the short tail into the previous part instead of emitting a stub.
      segments[segments.length - 1].duration += remaining;
      break;
    }
    segments.push({ start, duration: segDur });
    start += segDur;
  }
  return segments;
}

// Sanitize a filename for safe use as an ffmpeg input/output argument.
// Characters like '#' are interpreted by ffmpeg as protocol/segment markers and
// silently corrupt commands (e.g. a trimmed copy collapses to a few seconds).
function safeName(name) {
  return name
    .replace(/[^a-zA-Z0-9._-]/g, "_") // drop #, spaces, etc.
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function getOverlayAssets() {
  if (!fs.existsSync(ASSETS_DIR)) return [];
  const files = fs.readdirSync(ASSETS_DIR);
  const videoAssets = files
    .filter((f) => /^own-footage\./i.test(f))
    .filter((f) => VIDEO_EXTENSIONS.has(path.extname(f).toLowerCase()))
    .map((f) => ({ path: path.join(ASSETS_DIR, f), type: "video", name: f }));

  if (videoAssets.length > 0) return videoAssets;

  const imageAssets = files
    .filter((f) => /^own-image\./i.test(f))
    .filter((f) => IMAGE_EXTENSIONS.has(path.extname(f).toLowerCase()))
    .map((f) => ({ path: path.join(ASSETS_DIR, f), type: "image", name: f }));

  return imageAssets;
}

function buildOverlayPlan(mainDuration, assetCount) {
  const overlays = [];
  let current = 4;
  const dur = Math.max(0, mainDuration);
  const MAX_OVERLAYS = 120;
  while (overlays.length < MAX_OVERLAYS) {
    const gap = OVERLAY_MIN_GAP + Math.random() * (OVERLAY_MAX_GAP - OVERLAY_MIN_GAP);
    current += gap;
    if (current + OVERLAY_DURATION > dur - 2) break;
    overlays.push({
      start: Number(current.toFixed(3)),
      end: Number((current + OVERLAY_DURATION).toFixed(3)),
      assetIndex: Math.floor(Math.random() * assetCount),
    });
    current += OVERLAY_DURATION;
  }
  return overlays;
}

// ------------------------------------------------------ per-part processing
async function videoProcessor({
  videoPath,
  outputDir,
  introDir,
  assetsDir,
  audioDir,
  tempPartDir,
}) {
  ffmpeg.setFfmpegPath(ffmpegPath);
  ffmpeg.setFfprobePath(ffprobePath);

  const SPEED_FACTOR = features.speedFactor;
  const showIntro = features.intro;
  const showOverlay = features.overlay;
  const showLogo = features.logo;
  const showText = features.text;

  const fileName = path.basename(videoPath);
  const fileExt = path.extname(fileName);
  const fileBaseName = path.basename(fileName, fileExt);
  const assetPath = (n) => path.join(assetsDir, n);
  const drawtextFont = assetPath("RacingSansOne-Regular.ttf")
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:");
  const logoPath = assetPath("logo.png");

  const [mainOrigDur, introOrigDur] = await Promise.all([
    getMediaDuration(videoPath),
    showIntro ? getMediaDuration(path.join(introDir, fs.readdirSync(introDir)[0] || "")) : null,
  ]).catch(() => [null, null]);

  if (!Number.isFinite(mainOrigDur) || mainOrigDur <= 0) {
    throw new Error(`Could not determine duration for ${fileName}`);
  }

  // videoProcessor receives parts that are ALREADY trimmed by splitVideo
  // (trimStart/trimEnd applied once to the whole main video before splitting),
  // so no trim is applied here.
  const mainDuration = mainOrigDur / SPEED_FACTOR;

  // Optional intro: only if enabled AND a clip exists.
  const introFiles = showIntro ? fs.readdirSync(introDir) : [];
  const introVideo = introFiles.length > 0 ? path.join(introDir, introFiles[0]) : null;
  const introDuration = introVideo ? introOrigDur || 0 : 0;
  const totalDuration = mainDuration + introDuration;

  // Optional bed audio: skip gracefully if none present.
  const audioFiles = getAudioFiles(audioDir);
  const extraAudio =
    audioFiles.length > 0 ? audioFiles[getRandomNumber(0, audioFiles.length - 1)] : null;
  const hasBed = !!extraAudio && fs.existsSync(extraAudio);

  // Optional overlay assets.
  const overlayAssets = showOverlay ? getOverlayAssets() : [];
  const overlays = showOverlay
    ? buildOverlayPlan(mainDuration, overlayAssets.length)
    : [];
  if (showOverlay && overlayAssets.length === 0) {
    console.log("  (overlay enabled but no own-footage.*/own-image.* found — skipping)");
  }

  const fontPath = assetPath("RacingSansOne-Regular.ttf");
  const hasFont = fs.existsSync(fontPath);
  const hasLogo = showLogo && fs.existsSync(logoPath);

  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(tempPartDir, { recursive: true });

  const randomId = Math.floor(Math.random() * 999) + 1;
  const outputFileName =
    `${fileBaseName}`.trim().replace(/\s+/g, "-").replace(/[^a-zA-Z0-9-]/g, "-").replace(/-+/g, "-").toLowerCase() +
    `-cartoon-${randomId}-by-nhrepon.mp4`;
  const outputVideo = path.join(outputDir, outputFileName);

  console.log(`🎨 Processing ${fileName} -> ${outputFileName}`);
  console.log(`   duration ${mainDuration.toFixed(1)}s, intro ${introDuration.toFixed(1)}s, bed ${hasBed ? "on" : "off"}, logo ${hasLogo ? "on" : "off"}, overlay ${overlays.length}, blur ${features.blur ? `on (${features.blurSectionHeight}px bands)` : "off"}`);

  // Build ffmpeg inputs: [0]=main video, [1]=bed audio (if any), then overlays,
  // then logo (if any), then intro (if any). The part is already trimmed by
  // splitVideo, so no -ss is applied here.
  const command = ffmpeg();
  command.input(videoPath);
  let inputIndex = 1;
  if (hasBed) {
    command.input(extraAudio);
    inputIndex += 1;
  }
  const overlayInputStart = inputIndex;
  for (const a of overlayAssets) {
    if (a.type === "image") {
      command.input(a.path).inputOptions(["-loop", "1", "-t", String(OVERLAY_DURATION + 2)]);
    } else {
      command.input(a.path);
    }
    inputIndex += 1;
  }
  const logoInputIndex = inputIndex;
  if (hasLogo) {
    command.input(logoPath);
    inputIndex += 1;
  }
  const introInputIndex = inputIndex;
  if (introVideo) {
    command.input(introVideo);
    inputIndex += 1;
  }

  const fc = [];

  // Cartoon grade: color shift + contrast/saturation + light sharpen + denoise.
  const cartoonFilter =
    `colorbalance=rs=0.3:gs=0.3:bs=0.3,eq=contrast=1.15:brightness=0.02:saturation=1.2,unsharp=5:5:1.0:3:3:0.3,hqdn3d=2:1:3:2`;

  const showBlur = features.blur;

  // Main video with cartoon effects. When blur is on, split into bg + fg
  // so both branches are connected; when off, a single chain runs to [mainbase].
  if (showBlur) {
    fc.push(
      `[0:v]setpts=PTS/${SPEED_FACTOR},${cartoonFilter},split=2[mainA][mainfg]`,
    );
    fc.push(
      `[mainA]scale=${OUTPUT_SIZE}:${OUTPUT_SIZE}:force_original_aspect_ratio=increase,crop=${OUTPUT_SIZE}:${OUTPUT_SIZE},boxblur=${BLUR_STRENGTH},eq=brightness=0.02:contrast=1.08[mainbg]`,
    );
    fc.push(
      `[mainfg]scale=${OUTPUT_SIZE}:${OUTPUT_SIZE}:force_original_aspect_ratio=decrease,pad=${OUTPUT_SIZE}:${OUTPUT_SIZE}:(ow-iw)/2:(oh-ih)/2:color=black@0,format=rgba,hflip,eq=brightness=0.03:contrast=1.12[mainfgpadded]`,
    );
    fc.push(
      `[mainbg][mainfgpadded]overlay=(W-w)/2:(H-h)/2[mainbase]`,
    );
  } else {
    // No blur: fill the full 1080x1080 frame (cover), no letterboxing.
    fc.push(
      `[0:v]setpts=PTS/${SPEED_FACTOR},${cartoonFilter},scale=${OUTPUT_SIZE}:${OUTPUT_SIZE}:force_original_aspect_ratio=increase,crop=${OUTPUT_SIZE}:${OUTPUT_SIZE},format=rgba,hflip,eq=brightness=0.03:contrast=1.12[mainbase]`,
    );
  }

  let currentMainLabel = "[mainbase]";

  overlays.forEach((ov, idx) => {
    const ovInputIndex = overlayInputStart + ov.assetIndex;
    const overlayLabel = `[ov${idx}]`;
    fc.push(
      `[${ovInputIndex}:v]scale=${OUTPUT_SIZE}:${OUTPUT_SIZE}:force_original_aspect_ratio=increase,crop=${OUTPUT_SIZE}:${OUTPUT_SIZE},format=rgba,colorchannelmixer=aa=${OVERLAY_OPACITY},eq=saturation=1.2${overlayLabel}`,
    );
    const outLabel = `[mlayer${idx}]`;
    fc.push(
      `${currentMainLabel}${overlayLabel}overlay=0:0:enable='between(t,${ov.start},${ov.end})'${outLabel}`,
    );
    currentMainLabel = outLabel;
  });

  // Text (brand + CTA) — only if enabled AND the font exists.
  if (showText && hasFont) {
    const brandText = escapeDrawtext("Nhrepon.com");
    const bottomText = escapeDrawtext("Like, Comment and Share for more videos!");
    fc.push(
      `${currentMainLabel}drawtext=text='${brandText}':fontfile='${drawtextFont}':fontcolor=white:fontsize=42:borderw=3:bordercolor=black:x=40:y=20:fix_bounds=true:enable='gte(t,0)'[maintoptext]`,
    );
    currentMainLabel = "[maintoptext]";
    fc.push(
      `${currentMainLabel}drawtext=text='${bottomText}':fontfile='${drawtextFont}':fontcolor=white:fontsize=60:borderw=2:bordercolor=black:x=(w-text_w)/2:y=h-text_h-10:fix_bounds=true:enable='gte(t,0)',setsar=1[mainv]`,
    );
    currentMainLabel = "[mainv]";
  }
  if (currentMainLabel !== "[mainv]") {
    fc.push(`${currentMainLabel}setsar=1[mainv]`);
  }

  if (hasLogo) {
    fc.push(`[${logoInputIndex}:v]scale=${150}:-1,format=rgba[mainlogo]`);
    fc.push(`[mainv][mainlogo]overlay=W-w-10:10[mainvwithlogo]`);
  }

  if (introVideo) {
    fc.push(
      `[${introInputIndex}:v]crop='min(iw,${OUTPUT_SIZE})':'min(ih,${OUTPUT_SIZE})':(iw-min(iw\\,${OUTPUT_SIZE}))/2:(ih-min(ih\\,${OUTPUT_SIZE}))/2,pad=${OUTPUT_SIZE}:${OUTPUT_SIZE}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[introv]`,
    );
  }

  // ---- audio chain
  fc.push(
    `[0:a]asetrate=44100*${VOICE_PITCH},aresample=44100,highpass=f=100,lowpass=f=6000,afftdn=nf=-20,${atempoFilters(SPEED_FACTOR / VOICE_PITCH)},volume=${ORIGINAL_AUDIO_VOLUME}[mainorig]`,
  );
  if (hasBed) {
    const bedIdx = 1;
    fc.push(`[${bedIdx}:a]${atempoFilters(SPEED_FACTOR)}[extraamain]`);
  }
  if (hasBed) {
    fc.push(
      `[extraamain]atrim=duration=${mainDuration.toFixed(3)},volume=${BED_AUDIO_VOLUME}[mainbed]`,
    );
    fc.push(`[mainorig][mainbed]amix=inputs=2:duration=first:dropout_transition=2[maina]`);
  } else {
    fc.push(`[mainorig]anull[maina]`);
  }

  fc.push(
    `[${hasLogo ? "mainvwithlogo" : "mainv"}]trim=duration=${mainDuration.toFixed(3)}[finalv]`,
  );
  fc.push(`[maina]atrim=duration=${mainDuration.toFixed(3)}[finala]`);

  fc.push(
    `[finalv][finala]${introVideo ? "[introv][1:a]" : ""}concat=n=${introVideo ? 2 : 1}:v=1:a=1[outv][outa]`,
  );

  const outputOptions = [
    "-map", "[outv]",
    "-map", "[outa]",
    "-c:v", "libx264",
    "-crf", CRF,
    "-preset", X264_PRESET,
    "-threads", "0",
    "-c:a", "aac",
    "-b:a", "192k",
    "-r", String(OUTPUT_FPS),
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    "-map_metadata", "-1",
  ];

  return new Promise((resolve, reject) => {
    command
      .complexFilter(fc.join(";"))
      .outputOptions(...outputOptions)
      .output(outputVideo)
      .on("start", (cmdline) => console.log("🎨 FFmpeg started"))
      .on("progress", (progress) => {
        const elapsed = timemarkToSeconds(progress.timemark);
        if (elapsed === null || totalDuration <= 0) return;
        const safeTotal = Math.max(totalDuration, elapsed, 0.001);
        const percent = Math.min((elapsed / safeTotal) * 100, 99.4);
        console.log(`🎨 ${percent.toFixed(1)}% (${elapsed.toFixed(1)}/${totalDuration.toFixed(1)}s)`);
      })
      .on("end", async () => {
        try {
          const hash = await fileSha256Hex(outputVideo);
          console.log(`✅ ${outputVideo} (sha256 ${hash.slice(0, 12)}…)`);
          resolve(outputVideo);
        } catch (err) {
          reject(err);
        }
      })
      .on("error", (err) => {
        console.error("Error:", err && err.message ? err.message : err);
        reject(err);
      })
      .run();
  });
}

// --------------------------------------------------------- split orchestrator
async function splitVideo({
  inputVideo,
  tempPartsDir,
  processedOutputDir,
  introDir,
  assetsDir,
  audioDir,
  partSeconds = features.partDuration,
}) {
  fs.mkdirSync(tempPartsDir, { recursive: true });
  fs.mkdirSync(processedOutputDir, { recursive: true });

  const cleanup = [];
  const registerCleanup = (file) => {
    if (file && !cleanup.includes(file)) cleanup.push(file);
  };

  let sourceVideo = inputVideo;
  let totalDuration = await getMediaDuration(inputVideo);
  if (!Number.isFinite(totalDuration) || totalDuration <= 0) {
    throw new Error(`Could not determine duration for ${inputVideo}`);
  }

  // Sanitized base name for all temp artifacts. The input filename may contain
  // chars (e.g. '#') that ffmpeg misinterprets, so never reuse it verbatim.
  const safeBase = safeName(path.parse(inputVideo).name);

  // Apply trimStart/trimEnd ONCE to the whole main video, before splitting it
  // into parts. (Previously the trim was re-applied to every part, eating 20s
  // off the head and 80s off the tail of each segment.) Parts derived from the
  // trimmed copy must NOT be re-trimmed downstream.
  const trimStart = features.trimStart || 0;
  const trimEnd = features.trimEnd || 0;
  if (trimStart > 0 || trimEnd > 0) {
    const trimmedPath = path.join(
      tempPartsDir,
      `${safeBase}-${RUN_ID}-trimmed.mp4`,
    );
    await trimMainVideo({
      sourcePath: inputVideo,
      outputPath: trimmedPath,
      trimStart,
      trimEnd,
    });
    sourceVideo = trimmedPath;
    registerCleanup(trimmedPath);
    totalDuration = await getMediaDuration(sourceVideo);
  }

  // Loop short inputs up to the minimum so a split always has enough to cut.
  if (totalDuration < features.minInputSeconds) {
    const extendedPath = path.join(
      tempPartsDir,
      `${safeBase}-${RUN_ID}-extended.mp4`,
    );
    console.log(
      `Input ${totalDuration.toFixed(1)}s < ${features.minInputSeconds}s — looping to minimum before split`,
    );
    await extendVideoToMinimumDuration({
      sourcePath: sourceVideo,
      outputPath: extendedPath,
      minSeconds: features.minInputSeconds,
    });
    sourceVideo = extendedPath;
    registerCleanup(extendedPath);
    totalDuration = await getMediaDuration(sourceVideo);
  }

  const segments = planSegments(totalDuration, partSeconds, features.minPartSeconds);
  const baseName = path.parse(sourceVideo).name;
  const processedFiles = [];
  const failures = [];

  try {
    for (const [index, segment] of segments.entries()) {
      const partNumber = String(index + 1).padStart(2, "0");
      const splitPartPath = path.join(
        tempPartsDir,
        `${baseName}-${RUN_ID}-part-${partNumber}.mp4`,
      );
      console.log(
        `Splitting part ${index + 1}/${segments.length}: ${segment.start.toFixed(1)}s + ${segment.duration.toFixed(1)}s`,
      );
      try {
        await cutPart({
          sourcePath: sourceVideo,
          startSeconds: segment.start,
          durationSeconds: segment.duration,
          outputPath: splitPartPath,
        });
        registerCleanup(splitPartPath);

        const processedOutput = await videoProcessor({
          videoPath: splitPartPath,
          outputDir: processedOutputDir,
          introDir,
          assetsDir,
          audioDir,
          tempPartDir: tempPartsDir,
        });
        processedFiles.push({ part: index + 1, output: processedOutput });
      } catch (error) {
        // One bad part must not take the whole batch down.
        console.error(`Part ${index + 1}/${segments.length} failed: ${error.message || error}`);
        failures.push({ part: index + 1, error: error.message || String(error) });
        safeUnlink(splitPartPath, "failed part");
      }
    }
  } finally {
    for (const file of cleanup) safeUnlink(file);
  }

  if (failures.length > 0) {
    console.warn(
      `${failures.length}/${segments.length} part(s) failed: ` +
        failures.map((f) => `#${f.part}`).join(", "),
    );
  }
  return processedFiles;
}

// ---------------------------------------------------------------------- run
async function run() {
  const inputFiles = fs
    .readdirSync(INPUT_DIR)
    .map((file) => path.join(INPUT_DIR, file))
    .filter((f) => VIDEO_EXTENSIONS.has(path.extname(f).toLowerCase()));

  if (inputFiles.length === 0) {
    throw new Error(`No video found in input dir: ${INPUT_DIR}`);
  }

  let failedInputs = 0;
  const allOutputs = [];
  for (const inputVideo of inputFiles) {
    try {
      const results = await splitVideo({
        inputVideo,
        tempPartsDir: PART_DIR,
        processedOutputDir: OUTPUT_DIR,
        introDir: INTRO_DIR,
        assetsDir: ASSETS_DIR,
        audioDir: AUDIO_DIR,
        partSeconds: features.partDuration,
      });
      console.log(`✅ ${path.basename(inputVideo)} -> ${results.length} part(s)`);
      allOutputs.push(...results.map((r) => r.output));
    } catch (error) {
      failedInputs += 1;
      console.error(`Failed ${path.basename(inputVideo)}: ${error.message || error}`);
    }
  }

  console.log(`\n🎉 Done. ${allOutputs.length} file(s) written to ${OUTPUT_DIR}`);
  if (failedInputs > 0) {
    console.error(`${failedInputs}/${inputFiles.length} input file(s) failed`);
    process.exitCode = 1;
  }
}

module.exports = { videoProcessor, splitVideo, run, features };

// Run directly (node src/scripts/cartoon.js), not when required by a test.
if (require.main === module) {
  run().catch(console.error);
}
