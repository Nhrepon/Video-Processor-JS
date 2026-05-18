const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("@ffmpeg-installer/ffmpeg").path;
const ffprobePath = require("@ffprobe-installer/ffprobe").path;
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const {
  getRandomNumber,
  getAudioFiles,
  removeFile,
} = require("./utility/utility");

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

function videoProcessor(
  videoPath,
  outputDir,
  tempPartDir,
  assetsDir,
  audioDir,
) {
  ffmpeg.setFfmpegPath(ffmpegPath);
  ffmpeg.setFfprobePath(ffprobePath);

  const SPEED_FACTOR = 1.05;
  const OUTPUT_WIDTH = 1080;
  const OUTPUT_HEIGHT = 1920;
  const SCALE_HEIGHT = 1550;
  const ENABLE_OBJECT_TRACKING = true; // Set to true to enable object tracking
  const TRACKING_SENSITIVITY = 0.7; // 0.1 to 1.0, higher = more sensitive
  const HALF_WIDTH = Math.floor(OUTPUT_WIDTH / 2);
  const HALF_HEIGHT = Math.floor(OUTPUT_HEIGHT / 2);
  const OUTPUT_FPS = 30;
  const X264_PRESET = "fast";
  const CRF = "24";
  const OVERLAY_OPACITY = 0.06;
  const OVERLAY_DURATION = 1.0;
  const OVERLAY_MIN_GAP = 9;
  const OVERLAY_MAX_GAP = 22;
  const BLUR_STRENGTH = 8;
  const VOICE_PITCH = 0.84;
  const ORIGINAL_AUDIO_VOLUME = 0.9;
  const BED_AUDIO_VOLUME = 0.21;
  const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".mkv", ".webm"]);
  const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

  const brandText = escapeDrawtext("Nhrepon.com");
  const bottomText = escapeDrawtext("Like, Comment and Share for more videos!");
  const showTopText = false;
  const showBottomText = true;

  const fileName = path.basename(videoPath);
  const fileExt = path.extname(fileName);
  const fileBaseName = path.basename(fileName, fileExt);
  const assetPath = (file) => path.join(assetsDir, file);
  const drawtextFont = assetPath("RacingSansOne-Regular.ttf")
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:");
  const logoPath = assetPath("logo.png");
  const metadataTitle = `${fileBaseName} | Cartoon Clip`;
  const metadataDescription =
    "Cartoon clip edit featuring engaging moments curated for social video audiences.";
  const metadataKeywords = [
    "cartoon clip",
    "cartoon scene",
    "cartoon cinematic",
    "cartoon viral clip",
    "cartoon short video",
    "cartoon entertainment",
    "cartoon highlights",
    "viral video",
    "short video",
    "entertainment",
    "viral shorts",
    "scene edit",
    "nhrepon",
  ].join(",");

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
      const audioFiles = getAudioFiles(audioDir);
      const extraAudio =
        audioFiles.length > 0
          ? audioFiles[getRandomNumber(0, audioFiles.length - 1)]
          : audioFiles[0];
      const randomId = Math.floor(Math.random() * 99999) + 1;
      const outputFileName =
        `${fileBaseName}-${randomId}-by-nhrepon.mp4`.replace(/\s+/g, "-");
      const outputVideo = path.join(tempPartDir, outputFileName);

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

      if (ENABLE_OBJECT_TRACKING) {
        console.log(
          `Object tracking ENABLED with sensitivity: ${TRACKING_SENSITIVITY}`,
        );
      } else {
        console.log(`Object tracking DISABLED`);
      }

      const inputs = [
        { path: inputVideo, type: "video" },
        { path: extraAudio, type: "audio" },
        ...overlayAssets,
        { path: logoPath, type: "image" },
      ];

      const command = ffmpeg();
      inputs.forEach((input) => addInput(command, input));

      const fc = [];
      const gradeFilter = "hue=s=0.58,eq=contrast=1.04:brightness=0.01";

      if (ENABLE_OBJECT_TRACKING) {
        // Object tracking with crop to keep object centered
        fc.push(`[0:v]setpts=PTS/${SPEED_FACTOR},split=2[mainA][mainB]`);
        fc.push(
          `[mainA]scale=${HALF_WIDTH}:${HALF_HEIGHT}:force_original_aspect_ratio=increase,crop=${HALF_WIDTH}:${HALF_HEIGHT},boxblur=${BLUR_STRENGTH},scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT},${gradeFilter}[mainbg]`,
        );

        // Scale to fill frame completely, then crop to exact dimensions
        fc.push(
          `[mainB]scale=${OUTPUT_WIDTH}:${SCALE_HEIGHT}:force_original_aspect_ratio=increase,${gradeFilter},crop=${OUTPUT_WIDTH}:${SCALE_HEIGHT},cropdetect=${Math.floor(TRACKING_SENSITIVITY * 20)}:${Math.floor(TRACKING_SENSITIVITY * 20)}:reset=1,drawbox=enable='between(t,0,999)':color=red@0.3:thickness=1[mainfg]`,
        );

        fc.push(`[mainbg][mainfg]overlay=(W-w)/2:(H-h)/2[mainbase]`);
      } else {
        // Original processing without tracking
        fc.push(`[0:v]setpts=PTS/${SPEED_FACTOR},split=2[mainA][mainB]`);
        fc.push(
          `[mainA]scale=${HALF_WIDTH}:${HALF_HEIGHT}:force_original_aspect_ratio=increase,crop=${HALF_WIDTH}:${HALF_HEIGHT},boxblur=${BLUR_STRENGTH},scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT},${gradeFilter}[mainbg]`,
        );
        fc.push(
          `[mainB]hflip,scale=${OUTPUT_WIDTH}:${SCALE_HEIGHT}:force_original_aspect_ratio=increase,${gradeFilter}[mainfg]`,
        );
        fc.push(`[mainbg][mainfg]overlay=(W-w)/2:(H-h)/2[mainbase]`);
      }

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

      if (showTopText) {
        fc.push(
          `${currentMainLabel}drawtext=text='${brandText}':fontfile='${drawtextFont}':fontcolor=white:fontsize=90:borderw=3:bordercolor=black:x=20:y=40:fix_bounds=true:enable='gte(t,0)'[maintoptext]`,
        );
      }

      if (showBottomText) {
        fc.push(
          `${showTopText ? "[maintoptext]" : currentMainLabel}drawtext=text='${brandText}':fontfile='${drawtextFont}':fontcolor=white:fontsize=72:borderw=2:bordercolor=black:x=(w-text_w)/2:y=h-text_h-20:fix_bounds=true:enable='gte(t,0)',setsar=1[maintexted]`, //setsar=1[mainv]
        );
      }

      // logo
      fc.push(
        `[${2 + overlayAssets.length}:v]scale=${150}:-1,format=rgba[mainlogo]`,
      );
      fc.push(`[maintexted][mainlogo]overlay=W-w-${10}:${10}[mainv]`);

      fc.push(
        `[0:a]asetrate=44100*${VOICE_PITCH},aresample=44100,${atempoFilters(SPEED_FACTOR / VOICE_PITCH)},volume=${ORIGINAL_AUDIO_VOLUME}[mainorig]`,
      );
      fc.push(
        `[1:a]${atempoFilters(SPEED_FACTOR)},atrim=duration=${mainDuration.toFixed(3)},volume=${BED_AUDIO_VOLUME}[mainbed]`,
      );
      fc.push(
        `[mainorig][mainbed]amix=inputs=2:duration=first:dropout_transition=2[maina]`,
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
          `title=${metadataTitle}`,
          "-metadata",
          `description=${metadataDescription}`,
          "-metadata",
          "comment=Produced by NHRepon",
          "-metadata",
          "artist=Md. Nur Hossain Repon",
          "-metadata",
          "album_artist=Md. Nur Hossain Repon",
          "-metadata",
          "publisher=NHRepon",
          "-metadata",
          "genre=Cartoon",
          "-metadata",
          "language=en",
          "-metadata",
          "encoder=Lavf/NHRepon Video Processor",
          "-metadata",
          "composer=NHRepon",
          "-metadata",
          "album=Cartoon",
          "-metadata",
          "track=1",
          "-metadata",
          "network=NHRepon",
          "-metadata",
          "synopsis=Cartoon clip created for social sharing and short-form video publishing.",
          "-metadata",
          `keywords=${metadataKeywords}`,
          "-metadata",
          `date=${new Date().toISOString().slice(0, 10)}`,
          "-metadata",
          "copyright=NHRepon",
          "-metadata",
          "subtitle=Cartoon",
          "-metadata",
          "rating=PG",
          "-metadata",
          "publisher_url=https://nhrepon.com",
          "-metadata",
          "encoder_version=1.0",
        ])
        .output(outputVideo)
        .on("start", (cmdline) => console.log("FFmpeg started:", "cmdline"))
        .on("progress", (progress) => {
          const elapsed = timemarkToSeconds(progress.timemark);
          if (elapsed === null || totalDuration <= 0) return;
          const safeTotal = Math.max(totalDuration, elapsed, 0.001);
          const percent = Math.min((elapsed / safeTotal) * 100, 99.4);
          const rounded = Math.floor(percent);
          if (rounded <= lastLoggedPercent) return;
          lastLoggedPercent = rounded;
          console.log(
            `Progress: ${percent.toFixed(1)}% - elapsed: ${elapsed.toFixed(1)}s / total: ${totalDuration.toFixed(1)}s`,
          );
        })
        .on("end", async () => {
          try {
            const hash = await fileSha256Hex(outputVideo);
            console.log("Progress: 100.0%");
            console.log(
              `Output: ${outputVideo} ( ${OUTPUT_WIDTH}x${OUTPUT_HEIGHT} )`,
            );
            console.log(`SHA256: ${hash}`);
            console.log("Video processed successfully");

            // Split the processed video into parts
            const results = await splitVideo({
              inputVideo: outputVideo,
              tempPartsDir: tempPartDir,
              processedOutputDir: outputDir,
            });
            console.log(`Split into ${results.length} parts`);

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

async function splitVideo({ inputVideo, tempPartsDir, processedOutputDir }) {
  const MIN_PART_DURATION_SECONDS = 5;

  const getDuration = (filePath) =>
    new Promise((resolve, reject) => {
      ffmpeg.ffprobe(filePath, (error, metadata) => {
        if (error) {
          reject(new Error(`ffprobe failed for ${filePath}: ${error.message}`));
          return;
        }

        const duration = Number(metadata?.format?.duration);
        if (!Number.isFinite(duration)) {
          reject(new Error(`Could not get video duration for ${filePath}`));
          return;
        }
        resolve(duration);
      });
    });

  const cutPart = ({ startSeconds, durationSeconds, outputPath }) =>
    new Promise((resolve, reject) => {
      ffmpeg(inputVideo)
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
        .on("end", resolve)
        .on("error", reject)
        .run();
    });

  fs.mkdirSync(tempPartsDir, { recursive: true });
  fs.mkdirSync(processedOutputDir, { recursive: true });

  let totalDuration = await getDuration(inputVideo);

  if (totalDuration < MIN_PART_DURATION_SECONDS) {
    console.log(`Video is too short: ${totalDuration} seconds`);
    return [];
  }

  const ext = ".mp4";
  const baseName = path.basename(inputVideo, ext);
  const processedFiles = [];

  let startSeconds = 0;
  let partIndex = 0;

  while (startSeconds < totalDuration) {
    partIndex++;
    let partSeconds = getRandomNumber(50, 59);
    const durationSeconds = Math.min(partSeconds, totalDuration - startSeconds);

    console.log(
      `Part ${partIndex}: ${durationSeconds}s (random: ${partSeconds}s)`,
    );
    const partNumber = String(partIndex).padStart(2, "0");
    const splitPartPath = path.join(
      processedOutputDir,
      `${baseName}-part-${partNumber}${ext}`,
    );

    console.log(`Splitting part ${partIndex}: ${Math.round(durationSeconds)}s`);

    await cutPart({
      startSeconds,
      durationSeconds,
      outputPath: splitPartPath,
    });

    processedFiles.push({
      splitPartPath,
      processedOutput: splitPartPath,
    });
    startSeconds += durationSeconds;
  }

  return processedFiles;
}

const inputDir = path.join(__dirname, "input");
// const introDir = path.join(__dirname, "intro");
const assetsDir = path.join(__dirname, "assets");
const audioDir = path.join(__dirname, "audio");
const tempPartDir = path.join(__dirname, "output/parts");
const partOutputDir = path.join(__dirname, "output/partOutput/shorts");

async function run() {
  const inputFiles = fs
    .readdirSync(inputDir)
    .filter((file) => /\.(mp4|mov|mkv|webm)$/i.test(file))
    .map((file) => path.join(inputDir, file));

  if (inputFiles.length === 0) {
    throw new Error(`No video found in input dir: ${inputDir}`);
  }

  for (const inputVideo of inputFiles) {
    console.log(`Processing ${path.basename(inputVideo)}...`);

    const processedOutput = await videoProcessor(
      inputVideo,
      partOutputDir,
      tempPartDir,
      assetsDir,
      audioDir,
    );
    console.log(`Main video processed: ${processedOutput}`);
  }
}

run().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
