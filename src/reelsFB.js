const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("@ffmpeg-installer/ffmpeg").path;
const ffprobePath = require("@ffprobe-installer/ffprobe").path;
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { getDuration, reverseVideo, mergeVideo } = require("./utility/utility");

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

// --------------------------------------------------------------------- paths

const INPUT_DIR = path.join(__dirname, "input");
const INTRO_DIR = path.join(__dirname, "intro");
const ASSETS_DIR = path.join(__dirname, "assets");
const AUDIO_DIR = path.join(__dirname, "audio");
const PART_DIR = path.join(__dirname, "output/parts");
const PART_OUTPUT_DIR = path.join(__dirname, "output/partOutput/reelsFB");

// Unique per process so two runs never collide on temp or output names.
const RUN_ID = `${Date.now().toString(36)}-${process.pid}`;

// ------------------------------------------------------------------ features
// Toggles for the optional layers. Flip these instead of editing the filter
// graph — each one gates both its input and its chain, so a disabled layer is
// never opened, never decoded, and never referenced by the graph.
//
//   intro    — prepend the first clip in intro/ before the main video
//   logo     — burn assets/logo.png into the corner
//   overlay  — splice own-footage.* / own-image.* inserts into the timeline
//   captions — burn assets/captions.srt if present
//
// The brand and CTA drawtext are not optional; they are baked into the main
// chain. Add a flag here if you need to kill those too.

const FEATURES = {
  intro: true,
  logo: true,
  overlay: false,
  captions: true,
};

// -------------------------------------------------------------------- config

const VIDEO = {
  width: 1080,
  height: 1920,
  fps: 30,
  fgHeight: 1080,
  crf: "23",
  preset: "fast",
  // 1 = untouched timeline. Anything else rewrites PTS *and* pitch-corrects
  // audio, which reads as tampering rather than editing.
  speed: 1,
  blur: 8,
  // Light grade only. Saturation is kept near source on purpose.
  grade: "eq=contrast=1.04:brightness=0.01:saturation=0.96",
};

// Reels chrome covers roughly the top 180px and the bottom 420px of a
// 1080x1920 frame: username, caption, CTA row, audio bar. Anything drawn
// inside those bands is invisible in-feed, so all burned-in text lives
// between them.
const SAFE = {
  top: 180,
  bottom: 420,
};

const OVERLAY = {
  duration: 3,
  minGap: 12,
  maxGap: 26,
  leadIn: 5,
  tailOut: 3,
  // 1 = fully opaque. Do not drop this to watermark territory (0.1) — a
  // translucent film over the whole runtime reads as a veil, not as content.
  // These are short inserts, so they should look like real cuts.
  opacity: 0.85,
  // Cross-fade seconds at each end. Clamped to duration/2 at use site.
  fade: 0.25,
};

const AUDIO = {
  bedVolume: 0.22,
  targetLufs: -14,
  truePeak: -1.5,
  lra: 11,
};

const FONTS = {
  brandSize: 90,
  ctaSize: 42,
  captionSize: 64,
  captionMarginV: 340,
};

const MIN_PART_SECONDS = 30;
const MIN_INPUT_SECONDS = 30;

// Kill a render that has made no progress for this long. Guards against a
// hung ffmpeg holding the batch open forever.
const STALL_TIMEOUT_MS = 10 * 60 * 1000;
const PROGRESS_LOG_STEP = 1;

const VIDEO_EXT = new Set([".mp4", ".mov", ".mkv", ".webm"]);
const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp"]);

// ------------------------------------------------------------------- helpers

function probeMedia(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        reject(new Error(`ffprobe failed for ${filePath}: ${err.message}`));
        return;
      }
      const streams = metadata?.streams || [];
      resolve({
        duration: Number(metadata?.format?.duration) || 0,
        hasVideo: streams.some((s) => s.codec_type === "video"),
        hasAudio: streams.some((s) => s.codec_type === "audio"),
      });
    });
  });
}

function timemarkToSeconds(timemark) {
  if (!timemark) return null;
  const parts = timemark.split(":").map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null;
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

function escapeDrawtext(text) {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/%/g, "\\%");
}

function escapeFilterPath(filePath) {
  return filePath.replace(/\\/g, "\\\\").replace(/:/g, "\\:");
}

// libass wants forward slashes and an escaped drive colon, wrapped in quotes.
function escapeSubtitlesPath(filePath) {
  const normalized = filePath.replace(/\\/g, "/").replace(/:/g, "\\:");
  return `'${normalized}'`;
}

function fileSha256Hex(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("error", reject);
    hash.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.pipe(hash, { end: true });
  });
}

function safeUnlink(filePath, label = "temp") {
  try {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log(`Removed ${label} file: ${filePath}`);
    }
  } catch (error) {
    console.warn(`Could not remove ${label} file ${filePath}: ${error.message}`);
  }
}

function atempoFilters(factor) {
  let remaining = Number(factor) || 1;
  if (Math.abs(remaining - 1) < 1e-6) return null;
  if (remaining >= 0.5 && remaining <= 2) {
    return `atempo=${remaining.toFixed(6)}`;
  }

  const filters = [];
  while (remaining > 2) {
    filters.push("atempo=2.0");
    remaining /= 2;
  }
  while (remaining < 0.5) {
    filters.push("atempo=0.5");
    remaining *= 2;
  }
  filters.push(`atempo=${remaining.toFixed(6)}`);
  return filters.join(",");
}

function listFiles(dir, filter) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter(filter)
    .sort()
    .map((file) => path.join(dir, file));
}

function firstFile(dir, filter) {
  return listFiles(dir, filter)[0] || null;
}

function assertExists(filePath, label) {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error(`${label} not found at ${filePath}`);
  }
  return filePath;
}

function addInput(command, asset) {
  if (asset.type === "image") {
    const hold = Number.isFinite(asset.holdFor)
      ? asset.holdFor
      : OVERLAY.duration + 2;
    command
      .input(asset.path)
      .inputOptions(["-loop", "1", "-t", hold.toFixed(3)]);
    return;
  }

  if (asset.loop && Number.isFinite(asset.loopFor)) {
    command
      .input(asset.path)
      .inputOptions(["-stream_loop", "-1", "-t", asset.loopFor.toFixed(3)]);
    return;
  }

  command.input(asset.path);
}

function getOverlayAssets(assetsDir) {
  const files = fs.existsSync(assetsDir) ? fs.readdirSync(assetsDir) : [];

  const videos = files
    .filter((f) => /^own-footage\./i.test(f))
    .filter((f) => VIDEO_EXT.has(path.extname(f).toLowerCase()))
    .sort()
    .map((f) => ({ path: path.join(assetsDir, f), type: "video" }));

  if (videos.length > 0) return videos;

  return files
    .filter((f) => /^own-image\./i.test(f))
    .filter((f) => IMAGE_EXT.has(path.extname(f).toLowerCase()))
    .sort()
    .map((f) => ({ path: path.join(assetsDir, f), type: "image" }));
}

function buildOverlayPlan(mainDuration, assetCount) {
  const plan = [];
  if (assetCount <= 0) return plan;

  let cursor = OVERLAY.leadIn;
  let lastAssetIndex = -1;
  const limit = mainDuration - OVERLAY.tailOut;

  while (cursor + OVERLAY.duration <= limit) {
    let assetIndex = Math.floor(Math.random() * assetCount);

    // Never place the same asset back to back. Two adjacent slots running the
    // same clip reads as a glitch and wastes a slot.
    if (assetCount > 1 && assetIndex === lastAssetIndex) {
      assetIndex = (assetIndex + 1) % assetCount;
    }
    lastAssetIndex = assetIndex;

    plan.push({
      start: Number(cursor.toFixed(3)),
      end: Number((cursor + OVERLAY.duration).toFixed(3)),
      assetIndex,
    });

    const gap =
      OVERLAY.minGap + Math.random() * (OVERLAY.maxGap - OVERLAY.minGap);
    cursor += OVERLAY.duration + gap;
  }

  return plan;
}

function planSegments(totalDuration, partSeconds, minPartSeconds) {
  const segments = [];
  let start = 0;

  while (start < totalDuration - 0.001) {
    const duration = Math.min(partSeconds, totalDuration - start);

    if (duration >= minPartSeconds) {
      segments.push({ start, duration });
      start += duration;
      continue;
    }

    if (segments.length === 0) break;

    // Trailing sliver: fold it into the previous part instead of dropping it.
    segments[segments.length - 1].duration += duration;
    console.log(
      `Merged trailing ${duration.toFixed(2)}s into part ${segments.length} (under ${minPartSeconds}s)`,
    );
    break;
  }

  return segments;
}

// ------------------------------------------------------------ single render

async function videoProcessor({
  videoPath,
  outputDir,
  introDir,
  assetsDir,
  audioDir,
}) {
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });

  assertExists(videoPath, "Input video");

  const overlayAssets = FEATURES.overlay ? getOverlayAssets(assetsDir) : [];
  if (FEATURES.overlay && overlayAssets.length === 0) {
    throw new Error(
      "No overlay asset found. Add own-footage.* or own-image.* to assets/",
    );
  }

  const logoPath = FEATURES.logo
    ? assertExists(path.join(assetsDir, "logo.png"), "Logo")
    : null;

  // Drawtext needs the font regardless of the logo/overlay toggles.
  const drawtextFont = escapeFilterPath(
    assertExists(path.join(assetsDir, "RacingSansOne-Regular.ttf"), "Font"),
  );

  // Optional: drop assets/captions.srt and it gets burned in. Captions are
  // the single cheapest retention lever on Reels.
  const captionsPath = path.join(assetsDir, "captions.srt");
  const useCaptions = FEATURES.captions && fs.existsSync(captionsPath);

  const bedAudio = firstFile(audioDir, (f) =>
    VIDEO_EXT.has(path.extname(f).toLowerCase()),
  );
  const introVideo = FEATURES.intro
    ? firstFile(introDir, (f) =>
        VIDEO_EXT.has(path.extname(f).toLowerCase()),
      )
    : null;

  const mainProbe = await probeMedia(videoPath);
  if (!mainProbe.hasVideo) {
    throw new Error(`No video stream in ${videoPath}`);
  }
  if (mainProbe.duration <= 0) {
    throw new Error(`Could not determine duration for ${videoPath}`);
  }

  const introProbe =
    introVideo && fs.existsSync(introVideo) ? await probeMedia(introVideo) : null;
  const useIntro = Boolean(introProbe && introProbe.hasVideo);

  const mainDuration = mainProbe.duration / VIDEO.speed;
  const introDuration = useIntro ? introProbe.duration : 0;
  const totalDuration = introDuration + mainDuration;

  // Overlays are planned against the main clip, but the filter graph sees the
  // concatenated timeline. Every overlay timestamp has to be shifted past the
  // intro or the enable windows fire introDuration too early.
  const timelineOffset = introDuration;

  const overlays = FEATURES.overlay
    ? buildOverlayPlan(mainDuration, overlayAssets.length)
    : [];

  if (FEATURES.overlay) {
    console.log(`Using ${overlayAssets.length} overlay asset(s)`);
    console.log(`Inserting ${overlays.length} overlay segment(s)`);
  } else {
    console.log("Overlays disabled");
  }
  if (FEATURES.logo) console.log(`Logo: ${path.basename(logoPath)}`);
  if (useIntro) {
    console.log(
      `Intro: ${path.basename(introVideo)} (${introDuration.toFixed(2)}s)`,
    );
  }
  if (bedAudio) console.log(`Bed audio: ${path.basename(bedAudio)}`);
  if (useCaptions) console.log("Captions: captions.srt");

  // --- inputs ---------------------------------------------------------------
  // Indices are resolved by key so nothing depends on hardcoded positions, and
  // a disabled feature simply never registers a key.

  const inputs = [];
  const idx = {};
  const push = (key, asset) => {
    idx[key] = inputs.length;
    inputs.push(asset);
  };

  push("main", { path: videoPath, type: "video" });
  if (bedAudio) {
    push("bed", {
      path: bedAudio,
      type: "audio",
      loop: true,
      loopFor: totalDuration,
    });
  }
  overlayAssets.forEach((asset, i) =>
    push(`ov${i}`, {
      ...asset,
      loop: true,
      loopFor: OVERLAY.duration + 2,
    }),
  );
  if (logoPath) {
    push("logo", { path: logoPath, type: "image", holdFor: totalDuration });
  }
  if (useIntro) push("intro", { path: introVideo, type: "video" });

  const command = ffmpeg();
  inputs.forEach((asset) => addInput(command, asset));

  // --- video graph ----------------------------------------------------------

  const fc = [];
  const halfW = Math.floor(VIDEO.width / 2);
  const halfH = Math.floor(VIDEO.height / 2);

  // Blurred full-frame fill behind, sharp band in front. No mirror, no crop
  // games — the frame stays the frame, it is just reframed for 9:16.
  fc.push(`[${idx.main}:v]setpts=PTS/${VIDEO.speed},split=2[mainA][mainB]`);
  fc.push(
    `[mainA]scale=${halfW}:${halfH}:force_original_aspect_ratio=increase,` +
      `crop=${halfW}:${halfH},boxblur=${VIDEO.blur},` +
      `scale=${VIDEO.width}:${VIDEO.height},${VIDEO.grade},setsar=1[mainbg]`,
  );
  fc.push(
    `[mainB]scale=${VIDEO.width}:${VIDEO.fgHeight}:force_original_aspect_ratio=increase,` +
      `crop=${VIDEO.width}:${VIDEO.fgHeight},${VIDEO.grade},setsar=1[mainfg]`,
  );
  fc.push(`[mainbg][mainfg]overlay=(W-w)/2:(H-h)/2[mainbase]`);

  // Overlay inserts. Each slot is a real cut, not a veil:
  //   trim       — take only the slot's worth of frames
  //   setpts      — shift those frames so they land ON the timeline
  //   fade        — short alpha ramp in/out so the cut is not a hard pop
  //   colorchannelmixer — opacity, kept high so this reads as content
  //
  // Two things a naive graph gets wrong: without the setpts shift the overlay
  // frames sit at t=0 and are gone long before enable='between(...)' fires,
  // and one input stream cannot feed two overlay filters — repeated use of the
  // same asset needs a split.
  let current = "[mainbase]";

  if (FEATURES.overlay && overlays.length > 0) {
    const overlayUseCount = overlayAssets.map(() => 0);
    overlays.forEach((overlay) => {
      overlayUseCount[overlay.assetIndex] += 1;
    });

    overlayAssets.forEach((_, assetIndex) => {
      const count = overlayUseCount[assetIndex];
      if (count <= 1) return;
      const branches = Array.from(
        { length: count },
        (_, n) => `[ovsrc${assetIndex}_${n}]`,
      ).join("");
      fc.push(`[${idx[`ov${assetIndex}`]}:v]split=${count}${branches}`);
    });

    const overlayUseIndex = overlayAssets.map(() => 0);
    const overlayFade = Math.min(OVERLAY.fade, OVERLAY.duration / 2);
    const overlayFadeOutStart = Math.max(0, OVERLAY.duration - overlayFade);

    overlays.forEach((overlay, i) => {
      const { assetIndex, start } = overlay;
      const useIndex = overlayUseIndex[assetIndex];
      overlayUseIndex[assetIndex] += 1;

      const srcLabel =
        overlayUseCount[assetIndex] > 1
          ? `[ovsrc${assetIndex}_${useIndex}]`
          : `[${idx[`ov${assetIndex}`]}:v]`;

      const ovLabel = `[ov${i}]`;
      const outLabel = `[mlayer${i}]`;

      const slotStart = start + timelineOffset;
      const slotEnd = overlay.end + timelineOffset;

      fc.push(
        `${srcLabel}trim=duration=${OVERLAY.duration},` +
          `setpts=PTS-STARTPTS+${slotStart.toFixed(3)}/TB,` +
          `scale=${VIDEO.width}:${VIDEO.height}:force_original_aspect_ratio=increase,` +
          `crop=${VIDEO.width}:${VIDEO.height},setsar=1,format=rgba,` +
          `fade=t=in:st=${slotStart.toFixed(3)}:d=${overlayFade}:alpha=1,` +
          `fade=t=out:st=${(slotStart + overlayFadeOutStart).toFixed(3)}:` +
          `d=${overlayFade}:alpha=1,` +
          `colorchannelmixer=aa=${OVERLAY.opacity}${ovLabel}`,
      );
      fc.push(
        `${current}${ovLabel}overlay=0:0:eof_action=pass:` +
          `enable='between(t,${slotStart.toFixed(3)},${slotEnd.toFixed(3)})'${outLabel}`,
      );
      current = outLabel;
    });
  }
  // --- text overlays --------------------------------------------------------
  const brandText = escapeDrawtext("Nhrepon.com");
  const ctaText = escapeDrawtext("Like, Comment and Share for more videos!");

  fc.push(
    `${current}drawtext=text='${brandText}':fontfile='${drawtextFont}':` +
      `fontcolor=white:fontsize=${FONTS.brandSize}:borderw=2:bordercolor=black:` +
      `x=40:y=40:fix_bounds=true[maintoptext]`,
  );
  fc.push(
    `[maintoptext]drawtext=text='${ctaText}':fontfile='${drawtextFont}':` +
      `fontcolor=white:fontsize=${FONTS.ctaSize}:borderw=2:bordercolor=black:` +
      `x=(w-text_w)/2:y=h-text_h-40:fix_bounds=true,setsar=1[maintexted]`,
  );

  let preLogo = "[maintexted]";
  if (useCaptions) {
    const subPath = escapeSubtitlesPath(captionsPath);
    const style =
      `Fontname=Racing Sans One,Fontsize=${FONTS.captionSize},` +
      `PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,` +
      `Outline=3,Shadow=0,MarginV=${FONTS.captionMarginV},Alignment=2`;
    fc.push(
      `[maintexted]subtitles=filename=${subPath}:force_style='${style}'[maincaption]`,
    );
    preLogo = "[maincaption]";
  }

  if (logoPath) {
    fc.push(`[${idx.logo}:v]scale=150:-1,setsar=1,format=rgba[mainlogo]`);
    fc.push(`${preLogo}[mainlogo]overlay=W-w-10:20[mainv]`);
  } else {
    fc.push(`${preLogo}null[mainv]`);
  }

  fc.push(`[mainv]fps=${VIDEO.fps},setsar=1,format=yuv420p[mainvnorm]`);

  if (useIntro) {
    fc.push(
      `[${idx.intro}:v]scale=${VIDEO.width}:${VIDEO.height}:` +
        `force_original_aspect_ratio=increase,crop=${VIDEO.width}:${VIDEO.height},` +
        `fps=${VIDEO.fps},setsar=1,format=yuv420p[introv]`,
    );
    fc.push(`[introv][mainvnorm]concat=n=2:v=1:a=0[vout]`);
  } else {
    fc.push(`[mainvnorm]null[vout]`);
  }

  // --- audio graph ----------------------------------------------------------

  const speedAudio = atempoFilters(VIDEO.speed);
  const toStereo48 =
    "aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo";

  if (mainProbe.hasAudio) {
    const mainChain = [speedAudio, toStereo48].filter(Boolean).join(",");
    fc.push(`[${idx.main}:a]${mainChain}[mainorig]`);
  } else {
    console.log("Main source has no audio stream — generating silent bed");
    fc.push(
      `anullsrc=channel_layout=stereo:sample_rate=48000,` +
        `atrim=duration=${mainDuration.toFixed(3)},asetpts=PTS-STARTPTS[mainorig]`,
    );
  }

  const mixLabels = ["[mainorig]"];
  if (bedAudio) {
    fc.push(
      `[${idx.bed}:a]${toStereo48},volume=${AUDIO.bedVolume},` +
        `atrim=duration=${mainDuration.toFixed(3)},asetpts=PTS-STARTPTS[mainbed]`,
    );
    mixLabels.push("[mainbed]");
  }

  if (mixLabels.length > 1) {
    fc.push(
      `${mixLabels.join("")}amix=inputs=${mixLabels.length}:` +
        `duration=first:dropout_transition=2:normalize=0[mixed]`,
    );
  } else {
    fc.push(`[mainorig]anull[mixed]`);
  }

  fc.push(
    `[mixed]loudnorm=I=${AUDIO.targetLufs}:TP=${AUDIO.truePeak}:LRA=${AUDIO.lra},` +
      `${toStereo48}[maina]`,
  );

  let audioOut = "[maina]";
  if (useIntro) {
    if (introProbe.hasAudio) {
      fc.push(`[${idx.intro}:a]${toStereo48}[introa]`);
    } else {
      fc.push(
        `anullsrc=channel_layout=stereo:sample_rate=48000,` +
          `atrim=duration=${introDuration.toFixed(3)},asetpts=PTS-STARTPTS[introa]`,
      );
    }
    fc.push(`[introa][maina]concat=n=2:v=0:a=1[aout]`);
    audioOut = "[aout]";
  }

  // --- encode ---------------------------------------------------------------

  const randomId = Math.floor(Math.random() * 99999) + 1;
  const fileBaseName = path.parse(videoPath).name;
  const outputFileName =
    `${fileBaseName}-${RUN_ID}-${randomId}-by-nhrepon.mp4`.replace(/\s+/g, "-");
  const outputVideo = path.join(outputDir, outputFileName);

  let lastLoggedPercent = -1;
  let stallTimer = null;

  return new Promise((resolve, reject) => {
    const armStallWatchdog = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        console.error(
          `No ffmpeg progress for ${STALL_TIMEOUT_MS / 1000}s — killing render`,
        );
        command.kill("SIGKILL");
      }, STALL_TIMEOUT_MS);
    };

    const clearStallWatchdog = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = null;
    };

    const fail = (error, stderr) => {
      clearStallWatchdog();
      // A killed or crashed ffmpeg leaves a truncated mp4 behind. Drop it so
      // it never gets picked up as a finished render.
      safeUnlink(outputVideo, "partial output");
      if (stderr) console.error(stderr);
      reject(error);
    };

    command
      .complexFilter(fc.join(";"))
      .outputOptions([
        "-map", "[vout]",
        "-map", audioOut,
        "-c:v", "libx264",
        "-crf", VIDEO.crf,
        "-preset", VIDEO.preset,
        "-profile:v", "high",
        "-level", "4.1",
        "-pix_fmt", "yuv420p",
        "-r", String(VIDEO.fps),
        "-fps_mode", "cfr",
        "-g", String(VIDEO.fps * 2),
        "-keyint_min", String(VIDEO.fps),
        "-sc_threshold", "0",
        "-threads", "0",
        "-max_muxing_queue_size", "1024",
        "-c:a", "aac",
        "-b:a", "192k",
        "-ar", "48000",
        "-ac", "2",
        "-movflags", "+faststart",
        "-map_metadata", "-1",
        "-y",
      ])
      .output(outputVideo)
      .on("start", (cmdline) => {
        console.log("FFmpeg started:", cmdline);
        armStallWatchdog();
      })
      .on("progress", (progress) => {
        armStallWatchdog();
        const elapsed = timemarkToSeconds(progress.timemark);
        if (elapsed === null || totalDuration <= 0) return;
        const safeTotal = Math.max(totalDuration, elapsed, 0.001);
        const percent = Math.min((elapsed / safeTotal) * 100, 99.4);
        const rounded = Math.floor(percent);
        if (rounded < lastLoggedPercent + PROGRESS_LOG_STEP) return;
        lastLoggedPercent = rounded;
        console.log(`Progress: ${percent.toFixed(1)}%`);
      })
      .on("end", async () => {
        clearStallWatchdog();
        try {
          // Verify the file ffmpeg just claimed to write actually landed.
          const outProbe = await probeMedia(outputVideo);
          if (!outProbe.hasVideo || outProbe.duration <= 0) {
            safeUnlink(outputVideo, "invalid output");
            throw new Error(
              `Output failed verification: ${outputVideo} (duration ${outProbe.duration}, video ${outProbe.hasVideo})`,
            );
          }

          const drift = Math.abs(outProbe.duration - totalDuration);
          if (drift > 2) {
            console.warn(
              `Output duration ${outProbe.duration.toFixed(2)}s drifts ${drift.toFixed(2)}s from expected ${totalDuration.toFixed(2)}s`,
            );
          }

          const hash = await fileSha256Hex(outputVideo);
          console.log("Progress: 100.0%");
          console.log(
            `Output: ${outputVideo} (${VIDEO.width}x${VIDEO.height}, ${outProbe.duration.toFixed(2)}s)`,
          );
          console.log(`SHA256: ${hash}`);
          resolve(outputVideo);
        } catch (err) {
          fail(err);
        }
      })
      .on("error", (err, _stdout, stderr) => fail(err, stderr))
      .run();
  });
}

// ----------------------------------------------------------------- splitting

async function extendVideoToMinimumDuration({
  sourcePath,
  outputPath,
  tempPartsDir,
  registerCleanup,
}) {
  const baseName = path.parse(sourcePath).name;
  const reversedTarget = path.join(
    tempPartsDir,
    `${baseName}-${RUN_ID}-reversed.mp4`,
  );
  const mergedTarget = path.join(
    tempPartsDir,
    `${baseName}-${RUN_ID}-merged.mp4`,
  );

  const reversedFile =
    (await reverseVideo(sourcePath, reversedTarget)) || reversedTarget;
  registerCleanup(reversedFile);

  const mergedFile =
    (await mergeVideo(sourcePath, reversedFile, mergedTarget)) || mergedTarget;
  registerCleanup(mergedFile);

  const mergedDuration = Math.max(await getDuration(mergedFile), 0.001);
  const loopCount = Math.max(
    0,
    Math.ceil(MIN_INPUT_SECONDS / mergedDuration) - 1,
  );

  await new Promise((resolve, reject) => {
    ffmpeg()
      .input(mergedFile)
      .inputOptions(["-stream_loop", String(loopCount)])
      .outputOptions([
        "-c:v", "libx264",
        "-preset", "fast",
        "-crf", "23",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-b:a", "192k",
        "-movflags", "+faststart",
        "-y",
      ])
      .output(outputPath)
      .on("end", resolve)
      .on("error", reject)
      .run();
  });

  const extendedDuration = await getDuration(outputPath);
  console.log(
    `Extended ${path.basename(sourcePath)} -> ${extendedDuration.toFixed(2)}s`,
  );

  return outputPath;
}

function cutPart({ sourcePath, startSeconds, durationSeconds, outputPath }) {
  return new Promise((resolve, reject) => {
    ffmpeg(sourcePath)
      .setStartTime(startSeconds)
      .duration(durationSeconds)
      .outputOptions([
        "-c:v", "libx264",
        "-preset", "fast",
        "-crf", "23",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-b:a", "192k",
        "-ar", "48000",
        "-movflags", "+faststart",
        "-map_metadata", "-1",
        "-y",
      ])
      .output(outputPath)
      .on("end", resolve)
      .on("error", reject)
      .run();
  });
}

async function splitVideo({
  inputVideo,
  tempPartsDir,
  processedOutputDir,
  introDir,
  assetsDir,
  audioDir,
  partSeconds = 50,
}) {
  fs.mkdirSync(tempPartsDir, { recursive: true });
  fs.mkdirSync(processedOutputDir, { recursive: true });

  const cleanup = [];
  const registerCleanup = (file) => {
    if (file && !cleanup.includes(file)) cleanup.push(file);
  };

  let sourceVideo = inputVideo;
  let totalDuration = await getDuration(inputVideo);

  if (!Number.isFinite(totalDuration) || totalDuration <= 0) {
    throw new Error(`Could not determine duration for ${inputVideo}`);
  }

  if (totalDuration < MIN_INPUT_SECONDS) {
    const extendedPath = path.join(
      tempPartsDir,
      `${path.parse(inputVideo).name}-${RUN_ID}-extended.mp4`,
    );

    console.log(
      `Input is ${totalDuration.toFixed(2)}s — looping past ${MIN_INPUT_SECONDS}s before processing`,
    );

    await extendVideoToMinimumDuration({
      sourcePath: inputVideo,
      outputPath: extendedPath,
      tempPartsDir,
      registerCleanup,
    });

    sourceVideo = extendedPath;
    registerCleanup(extendedPath);
    totalDuration = await getDuration(sourceVideo);
  }

  const segments = planSegments(totalDuration, partSeconds, MIN_PART_SECONDS);
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
        `Splitting part ${index + 1}/${segments.length}: ${segment.duration.toFixed(2)}s`,
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
        });

        processedFiles.push({ part: index + 1, output: processedOutput });
      } catch (error) {
        // One bad part must not take the whole batch down. Record it, keep
        // going, report at the end.
        console.error(
          `Part ${index + 1}/${segments.length} failed: ${error.message || error}`,
        );
        failures.push({ part: index + 1, error: error.message || String(error) });
        safeUnlink(splitPartPath, "failed part");
      }
    }
  } finally {
    for (const file of cleanup) {
      safeUnlink(file);
    }
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
  const inputFiles = listFiles(INPUT_DIR, (file) =>
    VIDEO_EXT.has(path.extname(file).toLowerCase()),
  );

  if (inputFiles.length === 0) {
    throw new Error(`No video found in input dir: ${INPUT_DIR}`);
  }

  console.log(`Run ${RUN_ID} — ${inputFiles.length} input file(s)`);
  console.log(
    `Features: ${Object.entries(FEATURES)
      .filter(([, on]) => on)
      .map(([name]) => name)
      .join(", ") || "none"}`,
  );

  let failedInputs = 0;

  for (const inputVideo of inputFiles) {
    try {
      const results = await splitVideo({
        inputVideo,
        tempPartsDir: PART_DIR,
        processedOutputDir: PART_OUTPUT_DIR,
        introDir: INTRO_DIR,
        assetsDir: ASSETS_DIR,
        audioDir: AUDIO_DIR,
        partSeconds: 50,
      });

      console.log(
        `Finished ${path.basename(inputVideo)} — ${results.length} part(s)`,
      );
    } catch (error) {
      failedInputs += 1;
      console.error(
        `Failed ${path.basename(inputVideo)}: ${error.message || error}`,
      );
    }
  }

  if (failedInputs > 0) {
    console.error(`${failedInputs}/${inputFiles.length} input file(s) failed`);
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});