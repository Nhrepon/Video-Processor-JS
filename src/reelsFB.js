const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("@ffmpeg-installer/ffmpeg").path;
const ffprobePath = require("@ffprobe-installer/ffprobe").path;
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

function videoProcessor(videoPath, outputDir, introDir, assetsDir, audioDir) {
  ffmpeg.setFfmpegPath(ffmpegPath);
  ffmpeg.setFfprobePath(ffprobePath);

  const SPEED_FACTOR = 1.05;
  const OUTPUT_WIDTH = 1080;
  const OUTPUT_HEIGHT = 1920;
  const HALF_WIDTH = Math.floor(OUTPUT_WIDTH / 2);
  const HALF_HEIGHT = Math.floor(OUTPUT_HEIGHT / 2);
  const OUTPUT_FPS = 30;
  const X264_PRESET = "fast";
  const CRF = "24";
  const OVERLAY_OPACITY = 0.3;
  const OVERLAY_DURATION = 1.0;
  const OVERLAY_MIN_GAP = 5;
  const OVERLAY_MAX_GAP = 12;
  const BLUR_STRENGTH = 10;
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

      const [mainOrigDur, introOrigDur] = await Promise.all([
        getMediaDuration(inputVideo),
        getMediaDuration(introVideo),
      ]);

      const mainDuration = mainOrigDur / SPEED_FACTOR;
      const introDuration = introOrigDur / SPEED_FACTOR;
      const totalDuration = mainDuration;
      const overlays = buildOverlayPlan(mainDuration, overlayAssets.length);

      console.log(`Using ${overlayAssets.length} overlay asset(s)`);
      console.log(`Inserting ${overlays.length} random overlay segment(s)`);

      const inputs = [
        { path: inputVideo, type: "video" },
        { path: introVideo, type: "video" },
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
        `[mainB]hflip,scale=${1080}:${1080}:force_original_aspect_ratio=increase,${gradeFilter}[mainfg]`,
      );
      fc.push(`[mainbg][mainfg]overlay=(W-w)/2:(H-h)/2[mainbase]`);

      let currentMainLabel = "[mainbase]";
      overlays.forEach((overlay, index) => {
        const overallInputIndex = 3 + overlay.assetIndex;
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
        `${currentMainLabel}drawtext=text='${brandText}':fontfile='${drawtextFont}':fontcolor=white:fontsize=120:borderw=2:bordercolor=black:box=1:boxcolor=black@0.55:boxborderw=18:x=(w-text_w)/2:y=40:fix_bounds=true:enable='gte(t,0)'[maintoptext]`,
      );
      fc.push(
        `[maintoptext]drawtext=text='${bottomText}':fontfile='${drawtextFont}':fontcolor=white:fontsize=48:borderw=2:bordercolor=black:box=1:boxcolor=black@0.55:boxborderw=18:x=(w-text_w)/2:y=h-text_h-40:fix_bounds=true:enable='gte(t,0)',setsar=1[maintexted]`, //setsar=1[mainv]
      );

      // logo
      fc.push(
        `[${3 + overlayAssets.length}:v]scale=${150}:-1,format=rgba[mainlogo]`,
      );
      fc.push(`[maintexted][mainlogo]overlay=W-w-${20}:${20}[mainv]`);
      // Intro processing at half-res blur also
      fc.push(`[1:v]setpts=PTS/${SPEED_FACTOR},split=2[introA][introB]`);
      fc.push(
        `[introA]scale=${HALF_WIDTH}:${HALF_HEIGHT}:force_original_aspect_ratio=increase,crop=${HALF_WIDTH}:${HALF_HEIGHT},boxblur=${BLUR_STRENGTH},scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT},${gradeFilter}[introbg]`,
      );
      fc.push(
        `[introB]scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=increase,${gradeFilter}[introfg]`,
      );
      fc.push(`[introbg][introfg]overlay=(W-w)/2:(H-h)/2[introbase]`);
      fc.push(
        `[introbase]drawtext=text='${brandText}':fontfile='${drawtextFont}':fontcolor=white:fontsize=72:borderw=2:bordercolor=black:box=1:boxcolor=black@0.55:boxborderw=18:x=(w-text_w)/2:y=90:fix_bounds=true:enable='gte(t,0)'[introtoptext]`,
      );
      fc.push(
        `[introtoptext]drawtext=text='${brandText}':fontfile='${drawtextFont}':fontcolor=white:fontsize=72:borderw=2:bordercolor=black:box=1:boxcolor=black@0.55:boxborderw=18:x=(w-text_w)/2:y=h-text_h-90:fix_bounds=true:enable='gte(t,0)',setsar=1[introv]`,
      );

      fc.push(
        `[0:a]asetrate=44100*${VOICE_PITCH},aresample=44100,${atempoFilters(SPEED_FACTOR / VOICE_PITCH)},volume=1.0[mainorig]`,
      );
      fc.push(
        `[1:a]${atempoFilters(SPEED_FACTOR)},atrim=duration=${introDuration.toFixed(3)},volume=1.0[introorig]`,
      );
      fc.push(
        `[2:a]${atempoFilters(SPEED_FACTOR)},asplit=2[extraamain][extraaintro]`,
      );
      fc.push(
        `[extraamain]atrim=duration=${mainDuration.toFixed(3)},volume=0.2[mainbed]`,
      );
      fc.push(
        `[extraaintro]atrim=start=${mainDuration.toFixed(3)}:duration=${introDuration.toFixed(3)},volume=0.2[introbed]`,
      );
      fc.push(
        `[mainorig][mainbed]amix=inputs=2:duration=first:dropout_transition=2[maina]`,
      );
      fc.push(
        `[introorig][introbed]amix=inputs=2:duration=first:dropout_transition=2[introa]`,
      );
      fc.push(`[mainv][maina][introv][introa]concat=n=2:v=1:a=1[outv][outa]`);

      const filterComplex = fc.join(";");
      let lastLoggedPercent = -1;

      command
        .complexFilter(filterComplex)
        .outputOptions([
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
          "title=Md. Nur Hossain Repon Original Video",
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

  if (!inputVideo || !fs.existsSync(inputVideo)) {
    throw new Error(`Input video not found: ${inputVideo}`);
  }

  fs.mkdirSync(tempPartsDir, { recursive: true });
  fs.mkdirSync(processedOutputDir, { recursive: true });

  const totalDuration = await getDuration(inputVideo);
  const totalParts = Math.ceil(totalDuration / partSeconds);
  const ext = ".mp4"; //path.extname(inputVideo) ||
  const baseName = path.basename(inputVideo, ext);
  const processedFiles = [];

  for (let index = 0; index < totalParts; index += 1) {
    const startSeconds = index * partSeconds;
    const durationSeconds = Math.min(partSeconds, totalDuration - startSeconds);
    const partNumber = String(index + 1).padStart(2, "0");
    const splitPartPath = path.join(
      tempPartsDir,
      `${baseName}-part-${partNumber}${ext}`,
    );

    console.log(
      `Splitting part ${index + 1}/${totalParts}: ${Math.round(durationSeconds)}s`,
    );

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
  }

  return processedFiles;
}

const inputDir = path.join(__dirname, "input");
const introDir = path.join(__dirname, "intro");
const assetsDir = path.join(__dirname, "assets");
const audioDir = path.join(__dirname, "audio");
const partDir = path.join(__dirname, "parts");
const partOutputDir = path.join(__dirname, "partOutput");

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
      tempPartsDir: partDir,
      processedOutputDir: partOutputDir,
      introDir,
      assetsDir,
      audioDir,
      partMinutes: 1,
    });

    console.log(`Finished ${path.basename(inputVideo)}`);
    // console.log(results);
    console.log(`Total ${results.length} video processed...`);
  }
}

run().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
