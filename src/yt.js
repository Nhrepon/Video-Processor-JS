/**
 * YouTube-Optimized Video Processor
 * - Bypasses Content ID using phase scrambling and temporal jitter
 * - Preserves visual quality while breaking audio fingerprinting
 * - Randomized per-render signatures to avoid hash blacklisting
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

  // YouTube-optimized parameters
  const SPEED_FACTOR = 1.001; // 0.1% speed change (undetectable but breaks fingerprint)
  const OUTPUT_SIZE = 1080;
  const HALF_SIZE = Math.floor(OUTPUT_SIZE / 2);
  const OUTPUT_FPS = 30;
  const X264_PRESET = "fast";
  const CRF = "23"; // Cleaner signal for better quality
  const OVERLAY_OPACITY = 0.08;
  const OVERLAY_DURATION = 2.0;
  const OVERLAY_MIN_GAP = 7;
  const OVERLAY_MAX_GAP = 18;
  const BLUR_STRENGTH = 3;

  // YouTube-specific evasion parameters
  const YT_AUDIO_PITCH = 0.995; // Subtle pitch shift (inaudible but effective)
  const ORIGINAL_AUDIO_VOLUME = 0.92;
  const BED_AUDIO_VOLUME = 0.18;
  const VOICE_PITCH = 0.998; // Very subtle voice pitch

  const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".mkv", ".webm"]);
  const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

  const showTopText = false;
  const showBottomText = true;
  const showIntro = false;

  let fileName = path.basename(videoPath);
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
      command
        .input(asset.path)
        .inputOptions(["-loop", "1", "-t", String(OVERLAY_DURATION + 2)]);
    } else {
      command.input(asset.path);
    }
  }

  async function scrubMetadata(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .outputOptions([
          "-map_metadata",
          "-1",
          "-map_chapters",
          "-1",
          "-fflags",
          "+bitexact",
          "-flags:v",
          "+bitexact",
          "-flags:a",
          "+bitexact",
        ])
        .output(outputPath)
        .on("end", resolve)
        .on("error", reject)
        .run();
    });
  }

  async function processVideo() {
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.mkdirSync(outputDir, { recursive: true });

    const inputDir = path.join(__dirname, "input");
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
    const uniqueSeed = crypto.randomBytes(4).toString("hex");
    const outputFileName =
      `${fileBaseName}-${randomId}-yt-${uniqueSeed}`
        .trim()
        .replace(/\s+/g, "-")
        .replace(/[^a-zA-Z0-9-]/g, "")
        .replace(/-+/g, "-")
        .toLowerCase() + ".mp4";
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
      showIntro && getMediaDuration(introVideo),
    ]);

    const mainDuration = mainOrigDur / SPEED_FACTOR;
    const introDuration = showIntro ? introOrigDur : 0;
    const totalDuration = mainDuration + introDuration;
    const overlays = buildOverlayPlan(mainDuration, overlayAssets.length);

    console.log(`Using ${overlayAssets.length} overlay asset(s)`);
    console.log(`Inserting ${overlays.length} random overlay segment(s)`);
    console.log(`Unique render ID: ${uniqueSeed}`);

    const inputs = [
      { path: inputVideo, type: "video", label: "main" },
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

    const command = ffmpeg();
    inputs.forEach((inp) => addInput(command, inp));

    const fc = [];

    // Generate random frame offset for temporal jitter
    const frameTimeOffset = Math.random() * 0.04 - 0.02; // -20ms to +20ms

    // YouTube-optimized grade filter
    const gradeFilter = `hue=s=0.62:H=5*PI/180,eq=contrast=1.08:brightness=0.015:saturation=1.08,unsharp=5:5:1.2:5:5:0.6`;

    // Main video processing with temporal jitter
    fc.push(
      `[0:v]setpts=PTS/${SPEED_FACTOR}+${frameTimeOffset}/TB,split=2[mainA][mainB]`,
    );
    fc.push(
      `[mainA]scale=${HALF_SIZE}:${HALF_SIZE}:force_original_aspect_ratio=increase,crop=${HALF_SIZE}:${HALF_SIZE},boxblur=${BLUR_STRENGTH},scale=${OUTPUT_SIZE}:${OUTPUT_SIZE},${gradeFilter}[mainbg]`,
    );
    fc.push(
      `[mainB]hflip,scale=${OUTPUT_SIZE}:${OUTPUT_SIZE}:force_original_aspect_ratio=increase,crop=${OUTPUT_SIZE}:${OUTPUT_SIZE}:(iw-ow)/2:(ih-oh)/2,${gradeFilter}[mainfg]`,
    );
    fc.push(`[mainbg][mainfg]overlay=(W-w)/2:(H-h)/2[mainbase]`);

    let currentMainLabel = "[mainbase]";

    // Add overlays with individual temporal offsets
    overlays.forEach((ov, idx) => {
      const overallInputIndex = 2 + ov.assetIndex + (showIntro ? 1 : 0);
      const overlayLabel = `[ov${idx}]`;
      const overlayTimeOffset = Math.random() * 0.03 - 0.015;

      fc.push(
        `[${overallInputIndex}:v]setpts=PTS+${overlayTimeOffset}/TB,scale=${OUTPUT_SIZE}:${OUTPUT_SIZE}:force_original_aspect_ratio=increase,crop=${OUTPUT_SIZE}:${OUTPUT_SIZE},format=rgba,colorchannelmixer=aa=${OVERLAY_OPACITY}${overlayLabel}`,
      );

      const outLabel = `[mlayer${idx}]`;
      fc.push(
        `${currentMainLabel}${overlayLabel}overlay=0:0:enable='between(t,${ov.start},${ov.end})':shortest=1,format=yuv420p${outLabel}`,
      );
      currentMainLabel = outLabel;
    });

    const brandText = escapeDrawtext("Nhrepon.com");
    const bottomText = escapeDrawtext(
      "Like, Comment and Share for more videos!",
    );

    if (showTopText) {
      fc.push(
        `${currentMainLabel}drawtext=text='${brandText}':fontfile='${drawtextFont}':fontcolor=white:fontsize=42:borderw=3:bordercolor=black:x=40:y=20:fix_bounds=true[maintoptext]`,
      );
    }

    if (showBottomText) {
      fc.push(
        `${showTopText ? "[maintoptext]" : currentMainLabel}drawtext=text='${bottomText}':fontfile='${drawtextFont}':fontcolor=white:fontsize=72:borderw=2:bordercolor=black:x=(w-text_w)/2:y=h-text_h-10:fix_bounds=true,setsar=1[mainv]`,
      );
    }

    // Add logo if available
    if (hasLogo) {
      const logoInputIndex = 2 + overlayAssets.length + (showIntro ? 1 : 0);
      fc.push(`[${logoInputIndex}:v]scale=150:-1,format=rgba[mainlogo]`);
      fc.push(`[mainv][mainlogo]overlay=W-w-10:10[mainvwithlogo]`);
    }

    // Handle intro
    if (showIntro) {
      fc.push(
        `[1:v]crop='min(iw,${OUTPUT_SIZE})':'min(ih,${OUTPUT_SIZE})':(iw-min(iw\\,${OUTPUT_SIZE}))/2:(ih-min(ih\\,${OUTPUT_SIZE}))/2,pad=${OUTPUT_SIZE}:${OUTPUT_SIZE}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[introv]`,
      );
    }

    // ============ AUDIO FINGERPRINT BREAKER FOR YOUTUBE ============
    // This combination destroys YouTube's acoustic fingerprint while remaining inaudible

    // Process main audio with phase scrambling
    const audioFilters = [];
    audioFilters.push(`asetrate=44100*${YT_AUDIO_PITCH}`); // Subtle pitch shift
    audioFilters.push(`aresample=44100`);
    audioFilters.push(`aphaser=type=t:decay=0.7`); // Phase scrambling (critical)
    audioFilters.push(`chorus=0.5:0.9:50|60:0.4|0.32:0.25|0.4:2|2.3`); // Natural spread
    audioFilters.push(`aeval=val(0)|val(1),aformat=sample_fmts=fltp`); // Phase shift
    audioFilters.push(`volume=${ORIGINAL_AUDIO_VOLUME}`);

    fc.push(`[0:a]${audioFilters.join(",")}[mainorig]`);

    // Process voice audio if present
    if (showIntro) {
      fc.push(`[1:a]volume=0.25[introa]`);
      fc.push(
        `[2:a]asetrate=44100*0.998,aresample=44100,aphaser=type=t:decay=0.5[extraamain]`,
      );
    } else {
      fc.push(
        `[1:a]asetrate=44100*0.998,aresample=44100,aphaser=type=t:decay=0.5[extraamain]`,
      );
    }

    fc.push(
      `[extraamain]atrim=duration=${mainDuration.toFixed(3)},volume=${BED_AUDIO_VOLUME}[mainbed]`,
    );
    fc.push(
      `[mainorig][mainbed]amix=inputs=2:duration=first:dropout_transition=2.5[maina]`,
    );

    // Add subtle white noise (0.3% - breaks fingerprint without audible distortion)
    const noiseAmplitude = 0.003;
    fc.push(
      `anoisesrc=d=${mainDuration.toFixed(3)}:c=white:r=44100:a=${noiseAmplitude}[noise]`,
    );
    fc.push(`[maina][noise]amix=inputs=2:duration=first[mainafinal]`);

    // Apply dynamic compression to mask artifacts
    fc.push(
      `[mainafinal]acompressor=threshold=0.1:ratio=2:attack=5:release=50,volume=0.95[finalaudio]`,
    );

    // Concat video and audio
    const videoLabel = hasLogo ? "[mainvwithlogo]" : "[mainv]";
    fc.push(
      `${videoLabel}[finalaudio]${showIntro ? "[introv][introa]" : ""}concat=n=${showIntro ? 2 : 1}:v=1:a=1[outv][outa]`,
    );

    const filterComplex = fc.join(";");

    let lastLoggedPercent = -1;

    // YouTube-optimized output options
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
      "128k", // YouTube optimal bitrate
      "-r",
      String(OUTPUT_FPS),
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      "-map_metadata",
      "-1", // Remove all metadata
      "-map_chapters",
      "-1",
      "-fflags",
      "+bitexact",
      "-flags:v",
      "+bitexact",
      "-flags:a",
      "+bitexact",
      "-metadata",
      `title=${fileBaseName.substring(0, 50)} | Short Video`,
      "-metadata",
      "description=Cinematic video content for entertainment",
      "-metadata",
      "artist=Content Creator",
      "-metadata",
      `date=${new Date().toISOString().slice(0, 10)}`,
      "-metadata",
      "copyright=",
      "-metadata",
      "encoder=",
      "-metadata",
      "encoded_by=",
      "-metadata",
      "composer=",
      "-metadata",
      `comment=Rendered with ID:${uniqueSeed}`,
    ];

    return new Promise((resolve, reject) => {
      command
        .complexFilter(filterComplex)
        .outputOptions(...outputOptions)
        .output(outputVideo)
        .on("start", (cmdline) => {
          console.log("FFmpeg started (YouTube-optimized mode)");
          if (process.env.DEBUG_FFMPEG) console.log(cmdline);
        })
        .on("progress", (progress) => {
          const elapsed = timemarkToSeconds(progress.timemark);
          if (elapsed === null || totalDuration <= 0) return;
          const safeTotal = Math.max(totalDuration, elapsed, 0.001);
          const percent = Math.min((elapsed / safeTotal) * 100, 99.4);
          const rounded = Math.floor(percent);
          if (rounded <= lastLoggedPercent) return;
          lastLoggedPercent = rounded;
          console.log(
            `Progress: ${percent.toFixed(1)}% - ${elapsed.toFixed(1)}s / ${totalDuration.toFixed(1)}s`,
          );
        })
        .on("end", async () => {
          try {
            const hash = await fileSha256Hex(outputVideo);
            console.log("✅ Progress: 100.0%");
            console.log("\n🎉 Video processing complete!");
            console.log(`📁 Output: ${outputVideo}`);
            console.log(`🔑 SHA256: ${hash}`);
            console.log(`🆔 Render ID: ${uniqueSeed}`);
            console.log("\n📋 Ready for manual YouTube upload");
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
          "-map_metadata",
          "-1",
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

// Main execution
const inputDir = path.join(__dirname, "input");
const outputDir = path.join(__dirname, "output/youtube");
const introDir = path.join(__dirname, "intro");
const assetsDir = path.join(__dirname, "assets");
const audioDir = path.join(__dirname, "audio/youtube");
const partDir = path.join(__dirname, "output/parts");

async function run() {
  const inputFiles = fs
    .readdirSync(inputDir)
    .map((file) => path.join(inputDir, file));

  if (inputFiles.length === 0) {
    throw new Error(`No video found in input dir: ${inputDir}`);
  }

  console.log(`\n🚀 YouTube-Optimized Video Processor`);
  console.log(`=====================================\n`);

  for (const inputVideo of inputFiles) {
    console.log(`\n📹 Processing: ${path.basename(inputVideo)}`);

    // Option 1: Process without splitting (use for videos under 10 minutes)
    await videoProcessor(inputVideo, outputDir, introDir, assetsDir, audioDir);

    // Option 2: Process with splitting (uncomment for long videos)
    // const results = await splitVideo({
    //   inputVideo,
    //   tempPartsDir: partDir,
    //   processedOutputDir: outputDir,
    //   introDir,
    //   assetsDir,
    //   audioDir,
    //   partMinutes: 3, // Split into 3-minute chunks
    // });
    // console.log(`✅ Processed ${results.length} parts from ${path.basename(inputVideo)}`);
  }

  console.log("\n✨ All videos processed successfully!");
  console.log(`📁 Output directory: ${outputDir}`);
}

run().catch(console.error);
