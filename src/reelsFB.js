const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("@ffmpeg-installer/ffmpeg").path;
const ffprobePath = require("@ffprobe-installer/ffprobe").path;
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { getDuration, reverseVideo, mergeVideo } = require("./utility/utility");

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

function videoProcessor(videoPath, outputDir, introDir, assetsDir, audioDir) {
  const SPEED_FACTOR = 1.05;
  const OUTPUT_WIDTH = 1080;
  const OUTPUT_HEIGHT = 1920;
  const HALF_WIDTH = Math.floor(OUTPUT_WIDTH / 2);
  const HALF_HEIGHT = Math.floor(OUTPUT_HEIGHT / 2);
  const OUTPUT_FPS = 30;
  const X264_PRESET = "fast";
  const CRF = "24";
  const OVERLAY_OPACITY = 0.1;
  const OVERLAY_DURATION = 1.0;
  const OVERLAY_MIN_GAP = 9;
  const OVERLAY_MAX_GAP = 22;
  const BLUR_STRENGTH = 6;
  const VOICE_PITCH = 0.91;
  const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".mkv", ".webm"]);
  const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

  const fileName = path.basename(videoPath);
  const fileExt = path.extname(fileName);
  const fileBaseName = path.basename(fileName, fileExt);
  const assetPath = (file) => path.join(assetsDir, file);
  const drawtextFont = assetPath("RacingSansOne-Regular.ttf")
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:");
  const logoPath = assetPath("logo.png");

  function timemarkToSeconds(timemark) {
    if (!timemark) return null;
    const parts = timemark.split(":").map(Number);
    if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
      return null;
    }
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }

  function getMediaDuration(filePath) {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(filePath, (err, metadata) => {
        if (err) {
          reject(new Error(`ffprobe failed for ${filePath}: ${err.message}`));
          return;
        }

        const duration = Number(metadata?.format?.duration);
        if (!Number.isFinite(duration)) {
          reject(new Error(`Could not determine duration for ${filePath}`));
          return;
        }

        resolve(duration);
      });
    });
  }

  function getOverlayAssets() {
    if (!fs.existsSync(assetsDir)) return [];

    const files = fs.readdirSync(assetsDir);
    const videoAssets = files
      .filter((file) => /^own-footage\./i.test(file))
      .filter((file) => VIDEO_EXTENSIONS.has(path.extname(file).toLowerCase()))
      .map((file) => ({ path: assetPath(file), type: "video" }));

    if (videoAssets.length > 0) return videoAssets;

    return files
      .filter((file) => /^own-image\./i.test(file))
      .filter((file) => IMAGE_EXTENSIONS.has(path.extname(file).toLowerCase()))
      .map((file) => ({ path: assetPath(file), type: "image" }));
  }

  function buildOverlayPlan(mainDuration, assetCount) {
    const overlays = [];
    let current = 5;
    const duration = Math.max(0, Number(mainDuration) || 0);

    while (true) {
      const gap =
        OVERLAY_MIN_GAP + Math.random() * (OVERLAY_MAX_GAP - OVERLAY_MIN_GAP);
      current += gap;

      if (current + OVERLAY_DURATION > duration - 3) break;

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
      const stream = fs.createReadStream(filePath);
      stream.on("error", reject);
      hash.on("error", reject);
      stream.on("end", () => resolve(hash.digest("hex")));
      stream.pipe(hash, { end: true });
    });
  }

  function atempoFilters(factor) {
    let remaining = Number(factor) || 1;
    if (remaining >= 0.5 && remaining <= 2.0) {
      return `atempo=${remaining}`;
    }

    const filters = [];
    while (remaining > 2.0) {
      filters.push("atempo=2.0");
      remaining /= 2.0;
    }
    while (remaining < 0.5) {
      filters.push("atempo=0.5");
      remaining *= 2.0;
    }
    filters.push(`atempo=${remaining.toFixed(6)}`);
    return filters.join(",");
  }

  function addInput(command, asset) {
    if (asset.type === "image") {
      command
        .input(asset.path)
        .inputOptions(["-loop", "1", "-t", String(OVERLAY_DURATION + 2)]);
      return;
    }

    command.input(asset.path);
  }

  return new Promise(async (resolve, reject) => {
    try {
      fs.mkdirSync(assetsDir, { recursive: true });
      fs.mkdirSync(outputDir, { recursive: true });
      fs.mkdirSync(audioDir, { recursive: true });

      const inputVideo = videoPath;
      const introVideo = fs
        .readdirSync(introDir)
        .map((file) => path.join(introDir, file))[0];
      const extraAudio = fs
        .readdirSync(audioDir)
        .map((file) => path.join(audioDir, file))[0];
      const randomId = Math.floor(Math.random() * 99999) + 1;
      const outputFileName =
        `${fileBaseName}-${randomId}-by-nhrepon.mp4`.replace(/\s+/g, "-");
      const outputVideo = path.join(outputDir, outputFileName);

      if (!fs.existsSync(inputVideo)) {
        throw new Error(`Input video not found at ${inputVideo}`);
      }
      if (!extraAudio || !fs.existsSync(extraAudio)) {
        throw new Error(`Audio file not found in ${audioDir}`);
      }

      const overlayAssets = getOverlayAssets();
      if (overlayAssets.length === 0) {
        throw new Error(
          "No overlay asset found. Add own-footage.* or own-image.* to assets/",
        );
      }

      const mainOrigDur = await getMediaDuration(inputVideo);

      const mainDuration = mainOrigDur / SPEED_FACTOR;
      const totalDuration = mainDuration;
      const overlays = buildOverlayPlan(mainDuration, overlayAssets.length);

      console.log(`Using ${overlayAssets.length} overlay asset(s)`);
      console.log(`Inserting ${overlays.length} random overlay segment(s)`);

      const inputs = [
        { path: inputVideo, type: "video" },
        { path: extraAudio, type: "audio" },
        ...overlayAssets,
        { path: logoPath, type: "image" },
      ];

      const command = ffmpeg();
      inputs.forEach((input) => addInput(command, input));

      const fc = [];
      const gradeFilter = "hue=s=0.28,eq=contrast=1.04:brightness=0.01";

      fc.push(`[0:v]setpts=PTS/${SPEED_FACTOR},split=2[mainA][mainB]`);
      fc.push(
        `[mainA]scale=${HALF_WIDTH}:${HALF_HEIGHT}:force_original_aspect_ratio=increase,crop=${HALF_WIDTH}:${HALF_HEIGHT},boxblur=${BLUR_STRENGTH},scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT},${gradeFilter}[mainbg]`,
      );
      fc.push(
        `[mainB]hflip,scale=${OUTPUT_WIDTH}:${900}:force_original_aspect_ratio=increase,${gradeFilter}[mainfg]`,
      );
      fc.push(`[mainbg][mainfg]overlay=(W-w)/2:(H-h)/2[mainbase]`);

      let currentMainLabel = "[mainbase]";
      overlays.forEach((overlay, index) => {
        const overallInputIndex = 2 + overlay.assetIndex;
        const overlayLabel = `[ov${index}]`;
        const outLabel = `[mlayer${index}]`;

        fc.push(
          `[${overallInputIndex}:v]scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=increase,crop=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT},format=rgba,colorchannelmixer=aa=${OVERLAY_OPACITY}${overlayLabel}`,
        );
        fc.push(
          `${currentMainLabel}${overlayLabel}overlay=0:0:enable='between(t,${overlay.start},${overlay.end})'${outLabel}`,
        );
        currentMainLabel = outLabel;
      });

      const brandText = escapeDrawtext("Nhrepon.com");
      const bottomText = escapeDrawtext(
        "Like, Comment and Share for more videos!",
      );
      fc.push(
        `${currentMainLabel}drawtext=text='${brandText}':fontfile='${drawtextFont}':fontcolor=white:fontsize=90:borderw=2:bordercolor=black:x=20:y=40:fix_bounds=true:enable='gte(t,0)'[maintoptext]`,
      );
      fc.push(
        `[maintoptext]drawtext=text='${bottomText}':fontfile='${drawtextFont}':fontcolor=white:fontsize=42:borderw=2:bordercolor=black:x=(w-text_w)/2:y=h-text_h-20:fix_bounds=true:enable='gte(t,0)',setsar=1[maintexted]`, //setsar=1[mainv]
      );

      // logo
      fc.push(
        `[${2 + overlayAssets.length}:v]scale=${150}:-1,format=rgba[mainlogo]`,
      );
      fc.push(`[maintexted][mainlogo]overlay=W-w-${10}:${10}[mainv]`);

      fc.push(
        `[0:a?]asetrate=44100*${VOICE_PITCH},aresample=44100,${atempoFilters(SPEED_FACTOR / VOICE_PITCH)},volume=1.0[mainorig]`,
      );
      fc.push(
        `[1:a?]${atempoFilters(SPEED_FACTOR)},atrim=duration=${mainDuration.toFixed(3)},volume=0.2[mainbed]`,
      );
      fc.push(
        `[mainorig][mainbed]amix=inputs=2:duration=longest:dropout_transition=2[maina]`,
      );

      const filterComplex = fc.join(";");
      let lastLoggedPercent = -1;

      command
        .complexFilter(filterComplex)
        .outputOptions([
          "-map",
          "[mainv]",
          "-map",
          "[maina]",
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
          "title=Md. Nur Hossain Repon shorts video",
          "-metadata",
          "comment=Produced by NHRepon",
          "-metadata",
          "artist=Md. Nur Hossain Repon",
        ])
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
          console.log(`Progress: ${percent.toFixed(1)}%`);
        })
        .on("end", async () => {
          try {
            const hash = await fileSha256Hex(outputVideo);
            console.log("Progress: 100.0%");
            console.log(`Output: ${outputVideo} (1080x1350 4:5)`);
            console.log(`SHA256: ${hash}`);
            resolve(outputVideo);
          } catch (err) {
            reject(err);
          }
        })
        .on("error", (err, stdout, stderr) => {
          if (stderr) console.error(stderr);
          reject(err);
        })
        .run();
    } catch (error) {
      reject(error);
    }
  });
}

// async function splitVideo({
//   inputVideo,
//   tempPartsDir,
//   processedOutputDir,
//   introDir,
//   assetsDir,
//   audioDir,
//   partMinutes = 5,
// }) {
//   const PART_SECONDS = partMinutes * 60;
//   const MIN_PART_DURATION = 30;
//   const MIN_INPUT_DURATION = 30;

//   if (!inputVideo || !fs.existsSync(inputVideo)) {
//     throw new Error(`Input video not found: ${inputVideo}`);
//   }

//   fs.mkdirSync(tempPartsDir, { recursive: true });
//   fs.mkdirSync(processedOutputDir, { recursive: true });

//   // ---------- helpers ----------

//   const getDuration = (filePath) =>
//     new Promise((resolve, reject) => {
//       ffmpeg.ffprobe(filePath, (err, metadata) => {
//         if (err) return reject(err);
//         const d = Number(metadata?.format?.duration);
//         if (!Number.isFinite(d)) {
//           return reject(new Error(`Invalid duration: ${filePath}`));
//         }
//         resolve(d);
//       });
//     });

//   const cutPart = ({ source, start, duration, output }) =>
//     new Promise((resolve, reject) => {
//       ffmpeg(source)
//         .setStartTime(start)
//         .duration(duration)
//         .outputOptions([
//           "-c:v libx264",
//           "-preset fast",
//           "-crf 23",
//           "-c:a aac",
//           "-b:a 192k",
//           "-movflags +faststart",
//           "-y",
//         ])
//         .output(output)
//         .on("end", () => resolve(output))
//         .on("error", reject)
//         .run();
//     });

//   const extendToMinDuration = async (sourcePath, outputPath) => {
//     let reversed, merged;

//     try {
//       reversed = await reverseVideo(sourcePath);

//       merged = await mergeVideo(sourcePath, reversed, tempPartsDir);

//       const duration = await getDuration(merged);
//       const safe = Math.max(duration, 0.001);

//       const loops = Math.ceil(MIN_INPUT_DURATION / safe) - 1;

//       return await new Promise((resolve, reject) => {
//         ffmpeg(merged)
//           .inputOptions(["-stream_loop", String(Math.max(loops, 0))])
//           .outputOptions([
//             "-t", String(MIN_INPUT_DURATION), // ✅ force exact duration
//             "-c:v libx264",
//             "-preset fast",
//             "-crf 23",
//             "-c:a aac",
//             "-b:a 192k",
//             "-movflags +faststart",
//             "-y",
//           ])
//           .output(outputPath)
//           .on("end", () => resolve(outputPath))
//           .on("error", reject)
//           .run();
//       });

//     } finally {
//       // cleanup temp files
//       [reversed, merged].forEach((file) => {
//         if (file && fs.existsSync(file)) {
//           try { fs.unlinkSync(file); } catch {}
//         }
//       });
//     }
//   };

//   // ---------- main flow ----------

//   let sourceVideo = inputVideo;
//   let extendedPath = null;

//   let totalDuration = await getDuration(sourceVideo);

//   if (totalDuration < MIN_INPUT_DURATION) {
//     const base = path.basename(inputVideo, path.extname(inputVideo))
//       .replace(/[^\w\-]/g, "_");

//     extendedPath = path.join(
//       tempPartsDir,
//       `${base}-extended.mp4`
//     );

//     console.log(
//       `Extending short video (${totalDuration.toFixed(2)}s → ${MIN_INPUT_DURATION}s)`
//     );

//     sourceVideo = await extendToMinDuration(inputVideo, extendedPath);
//     totalDuration = await getDuration(sourceVideo);
//   }

//   const totalParts = Math.ceil(totalDuration / PART_SECONDS);
//   const baseName = path.basename(sourceVideo, path.extname(sourceVideo))
//     .replace(/[^\w\-]/g, "_");

//   const results = [];

//   try {
//     for (let i = 0; i < totalParts; i++) {
//       const start = i * PART_SECONDS;
//       const duration = Math.min(PART_SECONDS, totalDuration - start);

//       if (duration < MIN_PART_DURATION) {
//         console.log(`Skipping part ${i + 1} (too short: ${duration}s)`);
//         continue;
//       }

//       const partPath = path.join(
//         tempPartsDir,
//         `${baseName}-part-${String(i + 1).padStart(2, "0")}.mp4`
//       );

//       console.log(`Cutting part ${i + 1}/${totalParts} (${duration}s)`);

//       await cutPart({
//         source: sourceVideo,
//         start,
//         duration,
//         output: partPath,
//       });

//       console.log(`Processing: ${partPath}`);

//       const processed = await videoProcessor(
//         partPath,
//         processedOutputDir,
//         introDir,
//         assetsDir,
//         audioDir
//       );

//       results.push({ partPath, processed });
//     }

//   } finally {
//     if (extendedPath && fs.existsSync(extendedPath)) {
//       try {
//         fs.unlinkSync(extendedPath);
//         console.log(`Cleaned: ${extendedPath}`);
//       } catch {}
//     }
//   }

//   return results;
// }

async function splitVideo({
  inputVideo,
  tempPartsDir,
  processedOutputDir,
  introDir,
  assetsDir,
  audioDir,
  partMinutes = 5,
}) {
  const partSeconds = partMinutes * 60;
  const MIN_PART_DURATION_SECONDS = 30;
  const MIN_INPUT_DURATION_SECONDS = 30;
  fs.mkdirSync(tempPartsDir, { recursive: true });
  fs.mkdirSync(processedOutputDir, { recursive: true });
  let sourceVideo = inputVideo;
  let extendedVideoPath = null;
  let totalDuration = await getDuration(inputVideo);
  let cleanUp = [];

  async function extendVideoToMinimumDuration({ sourcePath, outputPath }) {
    let reverseVideoPath;
    let concateVideo;

    try {
      reverseVideoPath = await reverseVideo(sourcePath, outputPath);
      console.log("Reverse video path:", reverseVideoPath);
      cleanUp.push(reverseVideoPath);
      concateVideo = await mergeVideo(
        sourcePath,
        reverseVideoPath,
        outputPath,
      );
      console.log("Concate video path:", concateVideo);
      cleanUp.push(concateVideo);
      const concateDuration = await getDuration(concateVideo);
      console.log("Concate video duration:", concateDuration);
      const safeDuration = Math.max(concateDuration, 0.001);

      const loopCount =
        Math.ceil(MIN_INPUT_DURATION_SECONDS / safeDuration) - 1;

      return await new Promise((resolve, reject) => {
        ffmpeg()
          .input(concateVideo)
          .inputOptions(["-stream_loop", String(Math.max(loopCount, 0))])
          .outputOptions([
            "-c:v libx264",
            "-preset fast",
            "-crf 23",
            "-c:a aac",
            "-b:a 192k",
            "-movflags +faststart",
            "-y",
          ])
          .output(outputPath)
          .on("end", () => resolve((extendedVideoPath = outputPath)))
          .on("error", reject)
          .run();
      });
    } finally {
      console.log("✅ Extend video to minimum duration process completed");
    }
  }

  const cutPart = ({ startSeconds, durationSeconds, outputPath }) =>
    new Promise((resolve, reject) => {
      ffmpeg(extendedVideoPath)
        .setStartTime(startSeconds)
        .duration(durationSeconds)
        .outputOptions([
          "-c:v",
          "libx264",
          "-preset",
          "fast",
          "-crf",
          "23",
          "-c:a",
          "aac",
          "-b:a",
          "192k",
          "-movflags",
          "+faststart",
        ])
        .output(outputPath)
        .on("end", (code) => resolve(code))
        .on("error", reject)
        .run();
    });

  if (!cutPart || !fs.existsSync(tempPartsDir)) {
    throw new Error(`Temp parts directory not found: ${tempPartsDir}`);
  }

  if (totalDuration < MIN_INPUT_DURATION_SECONDS) {
    const inputExt = path.extname(inputVideo) || ".mp4";
    const inputBaseName = path.basename(inputVideo, inputExt);
    const repeatCount = Math.ceil(MIN_INPUT_DURATION_SECONDS / totalDuration);
    extendedVideoPath = path.join(
      tempPartsDir,
      `${inputBaseName}-extended-looped.mp4`,
    );

    console.log(
      `Input is ${totalDuration.toFixed(2)}s, looping ${repeatCount}x so it goes over ${MIN_INPUT_DURATION_SECONDS}s before processing`,
    );

    await extendVideoToMinimumDuration({
      sourcePath: inputVideo,
      sourceDuration: totalDuration,
      outputPath: extendedVideoPath,
    });

    sourceVideo = extendedVideoPath;
    totalDuration = await getDuration(sourceVideo);
  }

  const totalParts = Math.ceil(totalDuration / partSeconds);
  const ext = ".mp4"; //path.extname(inputVideo) ||
  const baseName = path.basename(sourceVideo, ext);
  const processedFiles = [];

  try {
    for (let index = 0; index < totalParts; index += 1) {
      const startSeconds = index * partSeconds;
      const durationSeconds = Math.min(
        partSeconds,
        totalDuration - startSeconds,
      );
      const partNumber = String(index + 1).padStart(2, "0");
      const splitPartPath = path.join(
        tempPartsDir,
        `${baseName}-part-${partNumber}${ext}`,
      );

      console.log(
        `Splitting part ${index + 1}/${totalParts}: ${Math.round(durationSeconds)}s`,
      );
      if (durationSeconds < MIN_PART_DURATION_SECONDS) {
        console.log(
          `Skipping part ${index + 1}/${totalParts}: duration ${durationSeconds.toFixed(2)}s is under ${MIN_PART_DURATION_SECONDS}s`,
        );
        continue;
      }
      await cutPart({
        startSeconds,
        durationSeconds,
        outputPath: splitPartPath,
      });

      console.log(`Processing split part: ${splitPartPath}`);

      const processedOutput = await videoProcessor(
        splitPartPath,
        processedOutputDir,
        introDir,
        assetsDir,
        audioDir,
      );

      processedFiles.push({
        splitPartPath,
        processedOutput,
      });
      cleanUp.push(splitPartPath);
      cleanUp.push(extendedVideoPath)
    }
  } finally {
    cleanUp.forEach((file) => {
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
        console.log(`Removed temp file: ${file}`);
      }
    });
  }

  return processedFiles;
}

const inputDir = path.join(__dirname, "input");
const introDir = path.join(__dirname, "intro");
const assetsDir = path.join(__dirname, "assets");
const audioDir = path.join(__dirname, "audio");
const partDir = path.join(__dirname, "output/parts");
const partOutputDir = path.join(__dirname, "output/partOutput/reelsFB");

async function run() {
  const inputFiles = fs
    .readdirSync(inputDir)
    .filter((file) => /\.(mp4|mov|mkv|webm)$/i.test(file))
    .map((file) => path.join(inputDir, file));

  if (inputFiles.length === 0) {
    throw new Error(`No video found in input dir: ${inputDir}`);
  }

  for (const inputVideo of inputFiles) {
    const results = await splitVideo({
      inputVideo,
      tempPartsDir:partDir,
      processedOutputDir: partOutputDir,
      introDir,
      assetsDir,
      audioDir,
      partMinutes: 0.8,
    });

    console.log(`Finished video processing: ${path.basename(inputVideo)}`);
    // console.log(results);
    console.log(`Total ${results.length} video processed...`);
  }
}

run().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
