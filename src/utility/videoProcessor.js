const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("@ffmpeg-installer/ffmpeg").path;
const ffprobePath = require("@ffprobe-installer/ffprobe").path;
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

function videoProcessor({
  videoPath,
  outputDir,
  introDir,
  assetsDir,
  audioDir,
  speed = 1.05,
  outputWidth = 1080,
  outputHeight = 1920,
  scaleWidth = outputWidth,
  scaleHeight = outputHeight,
  outputFPS = 30,
  x264Preset = "fast",
  crf = "24",
  overlayOpacity = 0.1,
  overlayDuration = 1.0,
  overlayMinGap = 9,
  overlayMaxGap = 22,
  blurStrength = 6,
  voicePitch = 0.91,
  originalAudioVolume = 0.9,
  bedAudioVolume = 0.18,
}) {
  const SPEED_FACTOR = speed;
  const OUTPUT_WIDTH = outputWidth;
  const OUTPUT_HEIGHT = outputHeight;
  const SCALE_WIDTH = scaleWidth;
  const SCALE_HEIGHT = scaleHeight;
  const HALF_WIDTH = Math.floor(OUTPUT_WIDTH / 2);
  const HALF_HEIGHT = Math.floor(OUTPUT_HEIGHT / 2);
  const OUTPUT_FPS = outputFPS;
  const X264_PRESET = x264Preset;
  const CRF = crf;
  const OVERLAY_OPACITY = overlayOpacity;
  const OVERLAY_DURATION = overlayDuration;
  const OVERLAY_MIN_GAP = overlayMinGap;
  const OVERLAY_MAX_GAP = overlayMaxGap;
  const BLUR_STRENGTH = blurStrength;
  const VOICE_PITCH = voicePitch;
  const ORIGINAL_AUDIO_VOLUME = originalAudioVolume;
  const BED_AUDIO_VOLUME = bedAudioVolume;
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
        `[mainB]hflip,scale=${SCALE_WIDTH}:${SCALE_HEIGHT}:force_original_aspect_ratio=increase,${gradeFilter}[mainfg]`,
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
        `[0:a?]asetrate=44100*${VOICE_PITCH},aresample=44100,${atempoFilters(SPEED_FACTOR / VOICE_PITCH)},volume=${ORIGINAL_AUDIO_VOLUME}[mainorig]`,
      );
      fc.push(
        `[1:a?]${atempoFilters(SPEED_FACTOR)},atrim=duration=${mainDuration.toFixed(3)},volume=${BED_AUDIO_VOLUME}[mainbed]`,
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

module.exports = { videoProcessor };
