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

function copyrightSafeVideoProcessor(
  videoPath,
  outputDir,
  introDir,
  assetsDir,
  audioDir,
) {
  ffmpeg.setFfmpegPath(ffmpegPath);
  ffmpeg.setFfprobePath(ffprobePath);

  // Enhanced parameters for copyright avoidance
  const SPEED_FACTOR = 1.08; // Slightly faster to alter timing
  const OUTPUT_WIDTH = 1080;
  const OUTPUT_HEIGHT = 1350;
  const HALF_WIDTH = Math.floor(OUTPUT_WIDTH / 2);
  const HALF_HEIGHT = Math.floor(OUTPUT_HEIGHT / 2);
  const OUTPUT_FPS = 30;
  const X264_PRESET = "fast";
  const CRF = "24";
  const OVERLAY_OPACITY = 0.08; // Increased overlay opacity
  const OVERLAY_DURATION = 1.2; // Longer overlay duration
  const OVERLAY_MIN_GAP = 7;
  const OVERLAY_MAX_GAP = 15;
  const BLUR_STRENGTH = 3; // Increased blur
  const VOICE_PITCH = 0.82; // More significant pitch change
  const ORIGINAL_AUDIO_VOLUME = 0.7; // Lower original audio
  const BED_AUDIO_VOLUME = 0.25; // Higher bed audio
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
    let current = 3; // Start earlier
    const duration = Math.max(0, Number(mainDuration) || 0);

    while (true) {
      const gap =
        OVERLAY_MIN_GAP + Math.random() * (OVERLAY_MAX_GAP - OVERLAY_MIN_GAP);
      current += gap;

      if (current + OVERLAY_DURATION > duration - 2) break;

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

      const inputVideo = videoPath;
      const introVideo = fs
        .readdirSync(introDir)
        .map((file) => path.join(introDir, file))[0];
      const audioFiles = getAudioFiles(audioDir);
      const extraAudio =
        audioFiles.length > 0
          ? audioFiles[getRandomNumber(0, audioFiles.length - 1)]
          : audioFiles[0];

      const randomId = Math.floor(Math.random() * 99999) + 1;
      const outputFileName =
        `${fileBaseName}-${randomId}-copyright-safe`
          .trim()
          .replace(/\s+/g, "-")
          .replace(/[^a-zA-Z0-9-]/g, "")
          .replace(/-+/g, "-")
          .toLowerCase() + `.mp4`;
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

      console.log(
        `Using ${overlayAssets.length} overlay asset(s) for copyright avoidance`,
      );
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

      // Enhanced visual effects for copyright avoidance
      const gradeFilter =
        "hue=s=0.22: h=0.15,eq=contrast=1.08:brightness=0.02:saturation=0.85,curves=all='0/0 0.5/0.58 1/1'";
      const noiseFilter = "noise=alls=8:allf=t+u";
      const vignetteFilter = "vignette=0.3:0.8";

      // Main video processing with enhanced effects
      fc.push(`[0:v]setpts=PTS/${SPEED_FACTOR},split=2[mainA][mainB]`);
      fc.push(
        `[mainA]scale=${HALF_WIDTH}:${HALF_HEIGHT}:force_original_aspect_ratio=increase,crop=${HALF_WIDTH}:${HALF_HEIGHT},boxblur=${BLUR_STRENGTH},scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT},${gradeFilter},${noiseFilter},${vignetteFilter}[mainbg]`,
      );
      fc.push(
        `[mainB]hflip,scale=${1000}:${1000}:force_original_aspect_ratio=increase,${gradeFilter},eq=brightness=0.03:contrast=1.06[mainfg]`,
      );
      fc.push(`[mainbg][mainfg]overlay=(W-w)/2:(H-h)/2[mainbase]`);

      let currentMainLabel = "[mainbase]";
      overlays.forEach((overlay, index) => {
        const overallInputIndex = 3 + overlay.assetIndex;
        const overlayLabel = `[ov${index}]`;
        const outLabel = `[mlayer${index}]`;

        fc.push(
          `[${overallInputIndex}:v]scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=increase,crop=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT},format=rgba,colorchannelmixer=aa=${OVERLAY_OPACITY},hue=s=0.3${overlayLabel}`,
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

      // Enhanced text overlays with more effects
      fc.push(
        `${currentMainLabel}drawtext=text='${brandText}':fontfile='${drawtextFont}':fontcolor=white:fontsize=92:borderw=3:bordercolor=black@0.7:x=20:y=20:fix_bounds=true:enable='gte(t,0)'[maintoptext]`,
      );
      fc.push(
        `[maintoptext]drawtext=text='${bottomText}':fontfile='${drawtextFont}':fontcolor=white:fontsize=42:borderw=2:bordercolor=black@0.7:x=(w-text_w)/2:y=h-text_h-20:fix_bounds=true:enable='gte(t,0)',setsar=1[maintexted]`,
      );

      // Logo with effects
      fc.push(
        `[${3 + overlayAssets.length}:v]scale=${150}:-1,format=rgba,hue=s=0.2[mainlogo]`,
      );
      fc.push(`[maintexted][mainlogo]overlay=W-w-${10}:${10}[mainv]`);

      // Intro processing with enhanced effects
      fc.push(`[1:v]setpts=PTS/${SPEED_FACTOR},split=2[introA][introB]`);
      fc.push(
        `[introA]scale=${HALF_WIDTH}:${HALF_HEIGHT}:force_original_aspect_ratio=increase,crop=${HALF_WIDTH}:${HALF_HEIGHT},boxblur=${BLUR_STRENGTH},scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT},${gradeFilter},${noiseFilter}[introbg]`,
      );
      fc.push(
        `[introB]scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=increase,${gradeFilter},eq=brightness=0.04:contrast=1.05[introfg]`,
      );
      fc.push(`[introbg][introfg]overlay=(W-w)/2:(H-h)/2[introbase]`);
      fc.push(
        `[introbase]drawtext=text='${brandText}':fontfile='${drawtextFont}':fontcolor=white:fontsize=72:borderw=3:bordercolor=black@0.7:box=1:boxcolor=black@0.65:boxborderw=20:x=(w-text_w)/2:y=90:fix_bounds=true:enable='gte(t,0)'[introtoptext]`,
      );
      fc.push(
        `[introtoptext]drawtext=text='${brandText}':fontfile='${drawtextFont}':fontcolor=white:fontsize=72:borderw=3:bordercolor=black@0.7:box=1:boxcolor=black@0.65:boxborderw=20:x=(w-text_w)/2:y=h-text_h-90:fix_bounds=true:enable='gte(t,0)',setsar=1[introv]`,
      );

      // Enhanced audio processing for copyright avoidance
      fc.push(
        `[0:a]asetrate=44100*${VOICE_PITCH},aresample=44100,${atempoFilters(SPEED_FACTOR / VOICE_PITCH)},volume=${ORIGINAL_AUDIO_VOLUME},highpass=f=200,lowpass=f=3000,equalizer=f=1000:width_type=h:width=100:g=3[mainorig]`,
      );
      fc.push(
        `[1:a]${atempoFilters(SPEED_FACTOR)},atrim=duration=${introDuration.toFixed(3)},volume=${ORIGINAL_AUDIO_VOLUME},highpass=f=150,lowpass=f=4000[introorig]`,
      );
      fc.push(`[2:a]${atempoFilters(SPEED_FACTOR)}[extraamain]`);
      fc.push(
        `[extraamain]atrim=duration=${mainDuration.toFixed(3)},volume=${BED_AUDIO_VOLUME},equalizer=f=500:width_type=h:width=50:g=2[mainbed]`,
      );
      fc.push(
        `[mainorig][mainbed]amix=inputs=2:duration=first:dropout_transition=2,highpass=f=100,lowpass=f=5000[maina]`,
      );
      fc.push(`[introorig]anull[introa]`);
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
          `title=Md. Nur Hossain Repon ${outputFileName}`,
          "-metadata",
          "comment=Copyright-safe processing by NHRepon",
          "-metadata",
          "artist=Md. Nur Hossain Repon",
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
          console.log(`Progress: ${percent.toFixed(1)}%`);
        })
        .on("end", async () => {
          try {
            const hash = await fileSha256Hex(outputVideo);
            console.log("Progress: 100.0%");
            console.log(
              `Copyright-safe output: ${outputVideo} (1080x1350 4:5)`,
            );
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

async function splitCopyrightSafeVideo({
  inputVideo,
  tempPartsDir,
  processedOutputDir,
  introDir,
  assetsDir,
  audioDir,
  partMinutes = 4, // Shorter parts for more variation
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
  const ext = ".mp4";
  const baseName = path.basename(inputVideo, ext);
  const processedFiles = [];

  for (let index = 0; index < totalParts; index += 1) {
    const startSeconds = index * partSeconds;
    const durationSeconds = Math.min(partSeconds, totalDuration - startSeconds);
    const partNumber = String(index + 1).padStart(2, "0");
    const splitPartPath = path.join(
      tempPartsDir,
      `${baseName}-copyright-safe-part-${partNumber}${ext}`,
    );

    console.log(
      `Splitting copyright-safe part ${index + 1}/${totalParts}: ${Math.round(durationSeconds)}s`,
    );

    await cutPart({
      startSeconds,
      durationSeconds,
      outputPath: splitPartPath,
    });

    console.log(`Processing copyright-safe split part: ${splitPartPath}`);

    const processedOutput = await copyrightSafeVideoProcessor(
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
    const removed = await removeFile(splitPartPath);
    console.log(
      removed
        ? `Removed temp part: ${splitPartPath}`
        : `Temp part already missing: ${splitPartPath}`,
    );
  }

  return processedFiles;
}

const inputDir = path.join(__dirname, "input");
const introDir = path.join(__dirname, "intro");
const assetsDir = path.join(__dirname, "assets");
const audioDir = path.join(__dirname, "audio");
const partDir = path.join(__dirname, "output/parts");
const partOutputDir = path.join(__dirname, "output/copyrightSafeOutput");

async function runCopyrightSafe() {
  const inputFiles = fs
    .readdirSync(inputDir)
    .filter((file) => /\.(mp4|mov|mkv|webm)$/i.test(file))
    .map((file) => path.join(inputDir, file));

  if (inputFiles.length === 0) {
    throw new Error(`No video found in input dir: ${inputDir}`);
  }

  for (const inputVideo of inputFiles) {
    const results = await splitCopyrightSafeVideo({
      inputVideo,
      tempPartsDir: partDir,
      processedOutputDir: partOutputDir,
      introDir,
      assetsDir,
      audioDir,
      partMinutes: 3, // Even shorter parts for maximum variation
    });

    console.log(
      `Finished copyright-safe processing for ${path.basename(inputVideo)}`,
    );
    console.log(`Total ${results.length} copyright-safe videos processed...`);
  }
}

module.exports = {
  copyrightSafeVideoProcessor,
  splitCopyrightSafeVideo,
  runCopyrightSafe,
};

// Uncomment to run directly
runCopyrightSafe().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
