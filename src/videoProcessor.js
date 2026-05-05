/**
 * Optimized video processor
 * - Faster x264 preset (fast), CRF 24, threads=0
 * - Uses ffprobe installer
 * - Limits image input duration (-t) to avoid infinite loops
 * - Applies blur at half resolution to reduce cost
 * - Pre-scales overlays in-filter once
 * - Safe atempo chaining for SPEED_FACTOR outside 0.5-2.0
 * - Streamed SHA256 hashing (avoids reading whole file into memory)
 *
 * Save as src/videoprocessor.js and run with: node src/videoprocessor.js
 */

const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("@ffmpeg-installer/ffmpeg").path;
const ffprobePath = require("@ffprobe-installer/ffprobe").path;
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { getRandomNumber, getAudioFiles } = require("./utility/utility");
const { splitVideo } = require("./utility/splitVideo");
ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

function videoProcessor(
  videoPath,
  outputDir,
  introDir,
  assetsDir,
  audioDir,
  tempPartDir,
) {
  ffmpeg.setFfmpegPath(ffmpegPath);
  ffmpeg.setFfprobePath(ffprobePath);

  const SPEED_FACTOR = 1.05;
  const OUTPUT_SIZE = 1080;
  const HALF_SIZE = Math.floor(OUTPUT_SIZE / 2);
  const OUTPUT_FPS = 30;
  const X264_PRESET = "fast";
  const CRF = "24";
  const OVERLAY_OPACITY = 0.06;
  const OVERLAY_DURATION = 1.5;
  const OVERLAY_MIN_GAP = 8;
  const OVERLAY_MAX_GAP = 20;
  const BLUR_STRENGTH = 5;
  const VOICE_PITCH = 0.84;
  const ORIGINAL_AUDIO_VOLUME = 0.95;
  const BED_AUDIO_VOLUME = 0.2;
  const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".mkv", ".webm"]);
  const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
  // Trim settings - remove seconds from start and end
  const TRIM_START_SECONDS = 1; // Remove 10 seconds from start
  const TRIM_END_SECONDS = 1; // Remove 20 seconds from end
  const showTopText = false;
  const showBottomText = true;
  const showIntro = false;
  const hueShift = 0.48;

  let fileName = path.basename(videoPath); // adjust if you run from repo root
  const fileExt = path.extname(fileName);
  const fileBaseName = path.basename(fileName, fileExt);
  const assetPath = (fileName) => path.join(assetsDir, fileName);
  const drawtextFont = assetPath("RacingSansOne-Regular.ttf")
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:");
  const logoPath = assetPath("logo.png");

  function timemarkToSeconds(timemark) {
    if (!timemark) return null;
    const parts = timemark.split(":").map(Number);
    if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n)))
      return null;
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }

  function getMediaDuration(filePath) {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(filePath, (err, metadata) => {
        if (err)
          return reject(
            new Error(`ffprobe failed for ${filePath}: ${err.message}`),
          );
        const dur =
          metadata && metadata.format && Number(metadata.format.duration);
        if (!Number.isFinite(dur))
          return reject(
            new Error(`Could not determine duration for ${filePath}`),
          );
        resolve(dur);
      });
    });
  }

  function getOverlayAssets() {
    if (!fs.existsSync(assetsDir)) return [];
    const files = fs.readdirSync(assetsDir);
    const videoAssets = files
      .filter((f) => /^own-footage\./i.test(f))
      .filter((f) => VIDEO_EXTENSIONS.has(path.extname(f).toLowerCase()))
      .map((f) => ({ path: assetPath(f), type: "video", name: f }));

    if (videoAssets.length > 0) return videoAssets;

    const imageAssets = files
      .filter((f) => /^own-image\./i.test(f))
      .filter((f) => IMAGE_EXTENSIONS.has(path.extname(f).toLowerCase()))
      .map((f) => ({
        path: assetPath(f),
        type: "image",
        name: f,
        label: `overlay_${f}`,
      }));

    return imageAssets;
  }

  function buildOverlayPlan(mainDuration, assetCount) {
    const overlays = [];
    let current = 5;
    const dur = Math.max(0, Number(mainDuration) || 0);
    const MAX_OVERLAYS = 100; // Increased overlay count

    while (overlays.length < MAX_OVERLAYS) {
      const gap =
        OVERLAY_MIN_GAP + Math.random() * (OVERLAY_MAX_GAP - OVERLAY_MIN_GAP);
      current += gap;
      if (current + OVERLAY_DURATION > dur - 3) break;
      overlays.push({
        start: Number(current.toFixed(3)),
        end: Number((current + OVERLAY_DURATION).toFixed(3)),
        assetIndex: Math.floor(Math.random() * assetCount),
      });
      current += OVERLAY_DURATION;
    }
    return overlays;
  }

  function escapeDrawtext(text) {
    return text
      .replace(/\\/g, "\\\\")
      .replace(/:/g, "\\:")
      .replace(/'/g, "\\'")
      .replace(/%/g, "\\%");
  }

  async function fileSha256Hex(filePath) {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash("sha256");
      const rs = fs.createReadStream(filePath);
      rs.on("error", reject);
      hash.on("error", reject);
      rs.on("end", () => resolve(hash.digest("hex")));
      rs.pipe(hash, { end: true });
    });
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

  function addInput(command, asset) {
    if (asset.type === "image") {
      // loop image but limit duration to avoid infinite streams
      command
        .input(asset.path)
        .inputOptions(["-loop", "1", "-t", String(OVERLAY_DURATION + 2)]);
    } else if (asset.trimStart !== undefined || asset.trimEnd !== undefined) {
      // Apply trimming for main video
      command.input(asset.path);
      if (asset.trimStart && asset.trimStart > 0) {
        command.inputOptions([`-ss`, String(asset.trimStart)]);
      }
      if (asset.trimEnd && asset.trimEnd > 0 && asset.trimmedDuration) {
        command.inputOptions([`-t`, String(asset.trimmedDuration)]);
      }
    } else {
      command.input(asset.path);
    }
  }

  async function processVideo() {
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.mkdirSync(outputDir, { recursive: true });
    fs.mkdirSync(inputDir, { recursive: true });

    const inputVideo = videoPath;
    const introVideo = fs
      .readdirSync(introDir)
      .map((file) => path.join(introDir, file))[0];
    const audioFiles = getAudioFiles(audioDir);
    const extraAudio =
      audioFiles.length > 0
        ? audioFiles[getRandomNumber(0, audioFiles.length - 1)]
        : audioFiles[0];
    const randomId = Math.floor(Math.random() * 999) + 1;
    const outputFileName =
      `${fileBaseName}`
        .trim()
        .replace(/\s+/g, "-")
        .replace(/[^a-zA-Z0-9-]/g, "-")
        .replace(/-+/g, "-")
        .toLowerCase() + `-${randomId}-by-nhrepon.mp4`;
    const outputVideo = path.join(tempPartDir, outputFileName);

    if (!fs.existsSync(inputVideo))
      throw new Error(`input.mp4 not found at ${inputVideo}`);
    if (!fs.existsSync(introVideo))
      throw new Error(`intro.mp4 not found at ${introVideo}`);
    if (!fs.existsSync(extraAudio))
      throw new Error(`audio.mp4 not found at ${extraAudio}`);

    const overlayAssets = getOverlayAssets();
    if (overlayAssets.length === 0)
      throw new Error(
        "No overlay asset found. Add own-footage.* or own-image.* to assets/",
      );

    const [mainOrigDur, introOrigDur] = await Promise.all([
      getMediaDuration(inputVideo),
      showIntro && getMediaDuration(introVideo),
    ]);

    // Apply trimming to main video duration
    const trimmedMainDur = mainOrigDur - TRIM_START_SECONDS - TRIM_END_SECONDS;
    const mainDuration = trimmedMainDur / SPEED_FACTOR;
    const introDuration = showIntro ? introOrigDur : 0;
    const totalDuration = mainDuration + introDuration;
    const overlays = buildOverlayPlan(mainDuration, overlayAssets.length);

    console.log(`Original video duration: ${mainOrigDur.toFixed(2)}s`);
    console.log(
      `Trimming: -${TRIM_START_SECONDS}s from start, -${TRIM_END_SECONDS}s from end`,
    );
    console.log(`Trimmed duration: ${trimmedMainDur.toFixed(2)}s`);
    console.log(`Using ${overlayAssets.length} overlay asset(s)`);
    console.log(`Inserting ${overlays.length} random overlay segment(s)`);

    const inputs = [
      {
        path: inputVideo,
        type: "video",
        label: "main",
        trimStart: TRIM_START_SECONDS,
        trimEnd: TRIM_END_SECONDS,
        trimmedDuration: trimmedMainDur,
      },
      { path: extraAudio, type: "audio", label: "audio" },
      ...overlayAssets.map((a) => ({ ...a })),
    ];
    const hasLogo = fs.existsSync(logoPath);
    if (hasLogo) {
      inputs.push({ path: logoPath, type: "image", label: "logo" });
    }
    if (showIntro) {
      inputs.push({ path: introVideo, type: "video", label: "intro" });
    }

    // Debug: Log input order
    console.log("Input order:");
    inputs.forEach((inp, idx) => {
      console.log(`  ${idx}: ${inp.label} (${inp.type}) - ${inp.path}`);
    });

    const command = ffmpeg();
    inputs.forEach((inp) => addInput(command, inp));

    const fc = [];
    // const gradeFilter = "hue=s=0.58,eq=contrast=1.04:brightness=0.01";
    const gradeFilter = `hue=s=${hueShift},eq=contrast=1.12:brightness=0.02:saturation=1.15,unsharp=7:7:1.5:5:5:0.8,eq=brightness=0.02:contrast=1.05:gamma=1.05`;

    // Main: apply blur on half-res background, foreground at full res
    fc.push(`[0:v]setpts=PTS/${SPEED_FACTOR},split=2[mainA][mainB]`);
    fc.push(
      `[mainA]scale=${HALF_SIZE}:${HALF_SIZE}:force_original_aspect_ratio=increase,crop=${HALF_SIZE}:${HALF_SIZE},boxblur=${BLUR_STRENGTH},scale=${OUTPUT_SIZE}:${OUTPUT_SIZE},${gradeFilter}[mainbg]`,
    );
    fc.push(
      `[mainB]hflip,scale=${OUTPUT_SIZE}:${OUTPUT_SIZE}:force_original_aspect_ratio=increase,crop=${OUTPUT_SIZE}:${OUTPUT_SIZE}:(iw-ow)/2:(ih-oh)/2,${gradeFilter}[mainfg]`, // `[mainB]hflip,scale=${OUTPUT_SIZE - 180}:${OUTPUT_SIZE - 180}:force_original_aspect_ratio=increase,${gradeFilter}[mainfg]`,
    );
    fc.push(`[mainbg][mainfg]overlay=(W-w)/2:(H-h)/2[mainbase]`);

    let currentMainLabel = "[mainbase]";

    overlays.forEach((ov, idx) => {
      const overallInputIndex = 2 + ov.assetIndex + (showIntro ? 1 : 0); // 0 main,1 intro(if enabled),2 audio, overlays start after that
      const overlayLabel = `[ov${idx}]`;

      // scaled once; for image we already looped with -t but treat same in filter
      fc.push(
        `[${overallInputIndex}:v]scale=${OUTPUT_SIZE}:${OUTPUT_SIZE}:force_original_aspect_ratio=increase,crop=${OUTPUT_SIZE}:${OUTPUT_SIZE},format=rgba,colorchannelmixer=aa=${OVERLAY_OPACITY}${overlayLabel}`,
      );

      const outLabel = `[mlayer${idx}]`;
      fc.push(
        `${currentMainLabel}${overlayLabel}overlay=0:0:enable='between(t,${ov.start},${ov.end})'${outLabel}`,
      );
      currentMainLabel = outLabel;
    });

    const brandText = escapeDrawtext("Nhrepon.com");
    const bottomText = escapeDrawtext(
      "Like, Comment and Share for more videos!",
    );
    if (showTopText) {
      fc.push(
        `${currentMainLabel}drawtext=text='${brandText}':fontfile='${drawtextFont}':fontcolor=white:fontsize=42:borderw=3:bordercolor=black:x=40:y=20:fix_bounds=true:enable='gte(t,0)'[maintoptext]`, //box=1:boxcolor=black@0.55:boxborderw=18:
      );
    }

    if (showBottomText) {
      fc.push(
        `${showTopText ? "[maintoptext]" : currentMainLabel}drawtext=text='${brandText}':fontfile='${drawtextFont}':fontcolor=white:fontsize=60:borderw=2:bordercolor=black:x=(w-text_w)/2:y=h-text_h-10:fix_bounds=true:enable='gte(t,0)',setsar=1[mainv]`,
      );
    }
    // logo
    if (hasLogo) {
      // Logo input index calculation:
      // Base inputs: main(0) + intro(if enabled) + audio(1) + overlays
      const logoInputIndex = 2 + overlayAssets.length + (showIntro ? 1 : 0);
      fc.push(`[${logoInputIndex}:v]scale=${150}:-1,format=rgba[mainlogo]`);
      fc.push(`[mainv][mainlogo]overlay=W-w-10:10[mainvwithlogo]`);
    }

    // Keep intro at original size: center-crop if too large, pad if too small.
    if (showIntro) {
      fc.push(
        `[1:v]crop='min(iw,${OUTPUT_SIZE})':'min(ih,${OUTPUT_SIZE})':(iw-min(iw\\,${OUTPUT_SIZE}))/2:(ih-min(ih\\,${OUTPUT_SIZE}))/2,pad=${OUTPUT_SIZE}:${OUTPUT_SIZE}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[introv]`,
      );
    }

    // Audio
    // fc.push(`[0:a]${atempoFilters(SPEED_FACTOR)},volume=1.0[mainorig]`);
    fc.push(
      `[0:a]asetrate=44100*${VOICE_PITCH},aresample=44100,${atempoFilters(SPEED_FACTOR / VOICE_PITCH)},volume=${ORIGINAL_AUDIO_VOLUME}[mainorig]`,
    );

    if (showIntro) {
      fc.push(`[1:a]volume=0.3[introa]`);
      fc.push(`[2:a]${atempoFilters(SPEED_FACTOR)}[extraamain]`);
    } else {
      fc.push(`[1:a]${atempoFilters(SPEED_FACTOR)}[extraamain]`);
    }
    fc.push(
      `[extraamain]atrim=duration=${trimmedMainDur.toFixed(3)},volume=${BED_AUDIO_VOLUME}[mainbed]`,
    );
    fc.push(
      `[mainorig][mainbed]amix=inputs=2:duration=first:dropout_transition=2[maina]`,
    );

    // Ensure final video matches trimmed duration
    fc.push(
      `[${hasLogo ? "mainvwithlogo" : "mainv"}]trim=duration=${trimmedMainDur.toFixed(3)}[finalv]`,
    );
    fc.push(`[maina]atrim=duration=${trimmedMainDur.toFixed(3)}[finala]`);

    // concat
    fc.push(
      `[finalv][finala]${showIntro ? "[introv][introa]" : ""}concat=n=${showIntro ? 2 : 1}:v=1:a=1[outv][outa]`,
    );

    const filterComplex = fc.join(";");

    let lastLoggedPercent = -1;
    const outputOptions = [
      "-map",
      "[outv]",
      "-map",
      "[outa]",
      "-c:v",
      "libx264",
      "-crf",
      CRF,
      "-preset",
      X264_PRESET,
      "-threads",
      "0",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-r",
      String(OUTPUT_FPS),
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      "-map_metadata",
      "-1",
      "-metadata",
      `title=${fileBaseName} | short video`,
      "-metadata",
      "description=Short video clip featuring cinematic scenes, cartoon animations, or video game moments curated for social media and short-form content.",
      "-metadata",
      "comment=Produced by NHRepon",
      "-metadata",
      "artist=Md. Nur Hossain Repon",
      "-metadata",
      "album_artist=Md. Nur Hossain Repon",
      "-metadata",
      "publisher=NHRepon",
      "-metadata",
      "genre=Short Video Content",
      "-metadata",
      "language=en",
      "-metadata",
      "encoder=Lavf/NHRepon Video Processor",
      "-metadata",
      "composer=NHRepon",
      "-metadata",
      "album=Movie Clip & Animation Collection",
      "-metadata",
      "track=1",
      "-metadata",
      "network=NHRepon",
      "-metadata",
      "synopsis=Cinematic movie clip, cartoon animation, or video game scene created for social sharing and short-form video publishing.",
      "-metadata",
      `keywords=${[
        "movie clip",
        "film scene",
        "cinematic",
        "viral clip",
        "short video",
        "entertainment",
        "movie highlights",
        "animation clip",
        "cartoon clip",
        "tom and jerry clip",
        "nhrepon",
      ].join(",")}`,
      "-metadata",
      `date=${new Date().toISOString().slice(0, 10)}`,
      "-metadata",
      "copyright=NHRepon",
    ];

    return new Promise((resolve, reject) => {
      command
        .complexFilter(filterComplex)
        .outputOptions(...outputOptions)
        .output(outputVideo)
        .on("start", (cmdline) => console.log("FFmpeg started:", cmdline))
        .on("progress", (progress) => {
          const elapsed = timemarkToSeconds(progress.timemark);
          if (elapsed === null || totalDuration <= 0) return;
          const safeTotal = Math.max(totalDuration, elapsed, 0.001);
          const percent = Math.min((elapsed / safeTotal) * 100, 99.4);
          const rounded = Math.floor(percent);
          if (rounded <= lastLoggedPercent) return;
          lastLoggedPercent = rounded;
          console.log(
            `Progress: ${percent.toFixed(1)}% ✅ ${elapsed.toFixed(1)}s done of ${totalDuration.toFixed(1)}s`,
          );
        })
        .on("end", async () => {
          try {
            const hash = await fileSha256Hex(outputVideo);
            console.log("✅ Progress: 100.0%");
            console.log("\n🎉 Done!");
            console.log(`✅ Output: ${outputVideo}`);
            console.log(`✅ SHA256: ${hash}`);
            // Split the processed video into parts
            const results = await splitVideo({
              inputVideo: outputVideo,
              outputDir: outputDir,
              partMinutes: 2,
            });
            console.log(`Split into ${results.length} parts`);
            resolve(outputVideo);
          } catch (err) {
            reject(err);
          }
        })
        .on("error", (err, stdout, stderr) => {
          console.error("Error:", err && err.message ? err.message : err);
          if (stderr) console.error(stderr);
          reject(err);
        })
        .run();
    });
  }

  return processVideo();
}

const inputDir = path.join(__dirname, "input");
const outputDir = path.join(__dirname, "output");
const introDir = path.join(__dirname, "intro");
const assetsDir = path.join(__dirname, "assets");
const audioDir = path.join(__dirname, "audio");
const partDir = path.join(__dirname, "output/parts");
async function run() {
  const inputFiles = fs
    .readdirSync(inputDir)
    .map((file) => path.join(inputDir, file));
  if (inputFiles.length === 0) {
    throw new Error(`No video found in input dir: ${inputDir}`);
  }
  // await Promise.all(inputFiles.map((videoPath) => videoProcessor(videoPath)));
  // for (const videoPath of inputFiles) {
  //   await videoProcessor(videoPath, outputDir, introDir, assetsDir, audioDir);
  // }
  for (const inputVideo of inputFiles) {
    const results = await videoProcessor(
      inputVideo,
      outputDir,
      introDir,
      assetsDir,
      audioDir,
      partDir,
    );

    console.log(`Finished ${inputVideo}`);
    console.log(`Total ${results.length} video processed...`);
  }
}
run().catch(console.error);
