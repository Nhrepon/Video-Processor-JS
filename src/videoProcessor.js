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
const {
  getRandomNumber,
  getAudioFiles,
  removeFile,
} = require("./utility/utility");
ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

function videoProcessor(videoPath, outputDir, introDir, assetsDir, audioDir) {
  ffmpeg.setFfmpegPath(ffmpegPath);
  ffmpeg.setFfprobePath(ffprobePath);

  const SPEED_FACTOR = 1.05;
  const OUTPUT_SIZE = 1080;
  const HALF_SIZE = Math.floor(OUTPUT_SIZE / 2);
  const OUTPUT_FPS = 30;
  const X264_PRESET = "fast";
  const CRF = "24";
  const OVERLAY_OPACITY = 0.04;
  const OVERLAY_DURATION = 1.0;
  const OVERLAY_MIN_GAP = 9;
  const OVERLAY_MAX_GAP = 22;
  const BLUR_STRENGTH = 5;
  const VOICE_PITCH = 0.88;
  const ORIGINAL_AUDIO_VOLUME = 0.9;
  const BED_AUDIO_VOLUME = 0.18;
  const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".mkv", ".webm"]);
  const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

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
      .map((f) => ({ path: assetPath(f), type: "image", name: f }));

    return imageAssets;
  }

  function buildOverlayPlan(mainDuration, assetCount) {
    const overlays = [];
    let current = 5;
    const dur = Math.max(0, Number(mainDuration) || 0);

    while (true) {
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
    const randomId = Math.floor(Math.random() * 99999) + 1;
    const outputFileName =
      `${fileBaseName}-${randomId}-by-nhrepon`
        .trim()
        .replace(/\s+/g, "-")
        .replace(/[^a-zA-Z0-9-]/g, "")
        .replace(/-+/g, "-")
        .toLowerCase() + `.mp4`;
    const outputVideo = path.join(outputDir, outputFileName);

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
      getMediaDuration(introVideo),
    ]);

    const mainDuration = mainOrigDur / SPEED_FACTOR;
    const introDuration = introOrigDur;
    const totalDuration = mainDuration + introDuration;
    const overlays = buildOverlayPlan(mainDuration, overlayAssets.length);

    console.log(`Using ${overlayAssets.length} overlay asset(s)`);
    console.log(`Inserting ${overlays.length} random overlay segment(s)`);

    const inputs = [
      { path: inputVideo, type: "video", label: "main" },
      { path: introVideo, type: "video", label: "intro" },
      { path: extraAudio, type: "audio", label: "audio" },
      ...overlayAssets.map((a) => ({ ...a })),
    ];
    const hasLogo = fs.existsSync(logoPath);
    if (hasLogo) {
      inputs.push({ path: logoPath, type: "image", label: "logo" });
    }

    const command = ffmpeg();
    inputs.forEach((inp) => addInput(command, inp));

    const fc = [];
    // const gradeFilter = "hue=s=0.58,eq=contrast=1.04:brightness=0.01";
    const gradeFilter =
      "hue=s=0.58,eq=contrast=1.12:brightness=0.02:saturation=1.15,unsharp=7:7:1.5:5:5:0.8,eq=brightness=0.02:contrast=1.05:gamma=1.05";

    // Main: apply blur on half-res background, foreground at full res
    fc.push(`[0:v]setpts=PTS/${SPEED_FACTOR},split=2[mainA][mainB]`);
    fc.push(
      `[mainA]scale=${HALF_SIZE}:${HALF_SIZE}:force_original_aspect_ratio=increase,crop=${HALF_SIZE}:${HALF_SIZE},boxblur=${BLUR_STRENGTH},scale=${OUTPUT_SIZE}:${OUTPUT_SIZE},${gradeFilter}[mainbg]`,
    );
    fc.push(
      `[mainB]hflip,scale=${OUTPUT_SIZE}:${OUTPUT_SIZE - 180}:force_original_aspect_ratio=increase,crop=${OUTPUT_SIZE}:${OUTPUT_SIZE - 180}:(iw-ow)/2:(ih-oh)/2,${gradeFilter}[mainfg]`, // `[mainB]hflip,scale=${OUTPUT_SIZE - 180}:${OUTPUT_SIZE - 180}:force_original_aspect_ratio=increase,${gradeFilter}[mainfg]`,
    );
    fc.push(`[mainbg][mainfg]overlay=(W-w)/2:(H-h)/2[mainbase]`);

    let currentMainLabel = "[mainbase]";

    overlays.forEach((ov, idx) => {
      const overallInputIndex = 3 + ov.assetIndex; // 0 main,1 intro,2 audio, overlays start at 3
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
    fc.push(
      `${currentMainLabel}drawtext=text='${brandText}':fontfile='${drawtextFont}':fontcolor=white:fontsize=42:borderw=3:bordercolor=black:x=40:y=25:fix_bounds=true:enable='gte(t,0)'[maintoptext]`, //box=1:boxcolor=black@0.55:boxborderw=18:
    );
    fc.push(
      `[maintoptext]drawtext=text='${bottomText}':fontfile='${drawtextFont}':fontcolor=white:fontsize=30:borderw=2:bordercolor=black:x=(w-text_w)/2:y=h-text_h-10:fix_bounds=true:enable='gte(t,0)',setsar=1[mainv]`,
    );
    // logo
    if (hasLogo) {
      fc.push(
        `[${3 + overlayAssets.length}:v]scale=${100}:-1,format=rgba[mainlogo]`,
      );
      fc.push(`[mainv][mainlogo]overlay=W-w-10:10[mainvwithlogo]`);
    }

    // Keep intro at original size: center-crop if too large, pad if too small.
    fc.push(
      `[1:v]crop='min(iw,${OUTPUT_SIZE})':'min(ih,${OUTPUT_SIZE})':(iw-min(iw\\,${OUTPUT_SIZE}))/2:(ih-min(ih\\,${OUTPUT_SIZE}))/2,pad=${OUTPUT_SIZE}:${OUTPUT_SIZE}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[introv]`,
    );

    // Audio
    // fc.push(`[0:a]${atempoFilters(SPEED_FACTOR)},volume=1.0[mainorig]`);
    fc.push(
      `[0:a]asetrate=44100*${VOICE_PITCH},aresample=44100,${atempoFilters(SPEED_FACTOR / VOICE_PITCH)},volume=${ORIGINAL_AUDIO_VOLUME}[mainorig]`,
    );

    fc.push(`[1:a]volume=0.3[introa]`);
    fc.push(`[2:a]${atempoFilters(SPEED_FACTOR)}[extraamain]`);
    fc.push(
      `[extraamain]atrim=duration=${mainDuration.toFixed(3)},volume=${BED_AUDIO_VOLUME}[mainbed]`,
    );
    fc.push(
      `[mainorig][mainbed]amix=inputs=2:duration=first:dropout_transition=2[maina]`,
    );

    // concat
    fc.push(
      `[${hasLogo ? "mainvwithlogo" : "mainv"}][maina][introv][introa]concat=n=2:v=1:a=1[outv][outa]`,
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
            console.log("\nDone!");
            console.log(`Output: ${outputVideo}`);
            console.log(`SHA256: ${hash}`);
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
    const results = await splitVideo({
      inputVideo,
      tempPartsDir: partDir,
      processedOutputDir: outputDir,
      introDir,
      assetsDir,
      audioDir,
      partMinutes: 2,
    });

    console.log(`Finished ${path.basename(inputVideo)}`);
    // console.log(results);
    console.log(`Total ${results.length} video processed...`);
  }
}
run().catch(console.error);
