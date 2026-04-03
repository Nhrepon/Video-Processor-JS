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

function videoProcessor(videoPath, outputDir, introDir, assetsDir, audio) {
  ffmpeg.setFfmpegPath(ffmpegPath);
  ffmpeg.setFfprobePath(ffprobePath);

  const SPEED_FACTOR = 1.05;
  const OUTPUT_SIZE = 1080;
  const HALF_SIZE = Math.floor(OUTPUT_SIZE / 2);
  const OUTPUT_FPS = 30;
  const X264_PRESET = "fast";
  const CRF = "24";
  const OVERLAY_OPACITY = 0.3;
  const OVERLAY_DURATION = 1.2;
  const OVERLAY_MIN_GAP = 5;
  const OVERLAY_MAX_GAP = 12;
  const BLUR_STRENGTH = 10;

  const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".mkv", ".webm"]);
  const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

  let fileName = path.basename(videoPath); // adjust if you run from repo root
  const assetPath = (fileName) => path.join(assetsDir, fileName);
  const drawtextFont = assetPath("RacingSansOne-Regular.ttf")
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:");

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
    const extraAudio = fs
      .readdirSync(audioDir)
      .map((file) => path.join(audioDir, file))[0];
    const outputVideo = path.join(outputDir, `produced-by-nhrepon-${fileName}`);

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
    const introDuration = introOrigDur / SPEED_FACTOR;
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

    const command = ffmpeg();
    inputs.forEach((inp) => addInput(command, inp));

    const fc = [];
    const gradeFilter = "hue=s=0.28,eq=contrast=1.04:brightness=0.01";

    // Main: apply blur on half-res background, foreground at full res
    fc.push(`[0:v]setpts=PTS/${SPEED_FACTOR},split=2[mainA][mainB]`);
    fc.push(
      `[mainA]scale=${HALF_SIZE}:${HALF_SIZE}:force_original_aspect_ratio=increase,crop=${HALF_SIZE}:${HALF_SIZE},boxblur=${BLUR_STRENGTH},scale=${OUTPUT_SIZE}:${OUTPUT_SIZE},${gradeFilter}[mainbg]`,
    );
    fc.push(
      `[mainB]hflip,scale=1400:1400:force_original_aspect_ratio=increase,${gradeFilter}[mainfg]`,
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

    const brandText = escapeDrawtext("Produced By Nhrepon.com");
    const bottomText = escapeDrawtext(
      "Like, Comment and Share for more vidoe!",
    );
    fc.push(
      `${currentMainLabel}drawtext=text='${brandText}':fontfile='${drawtextFont}':fontcolor=white:fontsize=48:borderw=2:bordercolor=black:box=1:boxcolor=black@0.55:boxborderw=18:x=(w-text_w)/2:y=40:fix_bounds=true:enable='gte(t,0)'[maintoptext]`,
    );
    fc.push(
      `[maintoptext]drawtext=text='${bottomText}':fontfile='${drawtextFont}':fontcolor=white:fontsize=42:borderw=2:bordercolor=black:box=1:boxcolor=black@0.55:boxborderw=18:x=(w-text_w)/2:y=h-text_h-40:fix_bounds=true:enable='gte(t,0)',setsar=1[mainv]`,
    );

    // Intro processing at half-res blur also
    fc.push(`[1:v]setpts=PTS/${SPEED_FACTOR},split=2[introA][introB]`);
    fc.push(
      `[introA]scale=${HALF_SIZE}:${HALF_SIZE}:force_original_aspect_ratio=increase,crop=${HALF_SIZE}:${HALF_SIZE},boxblur=${BLUR_STRENGTH},scale=${OUTPUT_SIZE}:${OUTPUT_SIZE},${gradeFilter}[introbg]`,
    );
    fc.push(
      `[introB]scale=${OUTPUT_SIZE}:${OUTPUT_SIZE}:force_original_aspect_ratio=increase,${gradeFilter}[introfg]`,
    );
    fc.push(`[introbg][introfg]overlay=(W-w)/2:(H-h)/2[introbase]`);
    fc.push(
      `[introbase]drawtext=text='${brandText}':fontfile='${drawtextFont}':fontcolor=white:fontsize=28:borderw=2:bordercolor=black:box=1:boxcolor=black@0.55:boxborderw=18:x=(w-text_w)/2:y=90:fix_bounds=true:enable='gte(t,0)'[introtoptext]`,
    );
    fc.push(
      `[introtoptext]drawtext=text='${brandText}':fontfile='${drawtextFont}':fontcolor=white:fontsize=28:borderw=2:bordercolor=black:box=1:boxcolor=black@0.55:boxborderw=18:x=(w-text_w)/2:y=h-text_h-90:fix_bounds=true:enable='gte(t,0)',setsar=1[introv]`,
    );

    // Audio
    // fc.push(`[0:a]${atempoFilters(SPEED_FACTOR)},volume=1.0[mainorig]`);
    fc.push(
      `[0:a]asetrate=44100*1.06,aresample=44100,${atempoFilters(SPEED_FACTOR / 1.06)},volume=1.0[mainorig]`,
    );

    fc.push(`[1:a]${atempoFilters(SPEED_FACTOR)},volume=1.0[introorig]`);
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

    // concat
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
        "title=Nhrepon com Original Square Video",
        "-metadata",
        "comment=Produced by NHRepon com",
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
          console.log("\nDone!");
          console.log(`Output: ${outputVideo} (1080x1080 square)`);
          console.log(`SHA256: ${hash}`);
        } catch (err) {
          console.log(
            "Completed but failed to hash output:",
            err.message || err,
          );
        }
      })
      .on("error", (err, stdout, stderr) => {
        console.error("Error:", err && err.message ? err.message : err);
        if (stderr) console.error(stderr);
      })
      .run();
  }

  processVideo().catch((err) => {
    console.error("Fatal:", err && err.message ? err.message : err);
    process.exit(1);
  });
}

const inputDir = path.join(__dirname, "input");
const outputDir = path.join(__dirname, "output");
const introDir = path.join(__dirname, "intro");
const assetsDir = path.join(__dirname, "assets");
const audioDir = path.join(__dirname, "audio");
async function run() {
  const inputFiles = fs
    .readdirSync(inputDir)
    .map((file) => path.join(inputDir, file));
  if (inputFiles.length === 0) {
    throw new Error(`No video found in input dir: ${inputDir}`);
  }
  // await Promise.all(inputFiles.map((videoPath) => videoProcessor(videoPath)));
  for (const videoPath of inputFiles) {
    await videoProcessor(videoPath, outputDir, introDir, assetsDir, audioDir);
  }
}
run().catch(console.error);
