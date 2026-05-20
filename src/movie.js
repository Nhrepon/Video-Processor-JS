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
const {
  getRandomNumber,
  getAudioFiles,
  fileSha256Hex,
  timemarkToSeconds,
  getDuration,
  removeFile,
  atempoFilters,
  escapeDrawtext,
  addInput,
  buildOverlayPlan,
  getMediaDuration,
} = require("./utility/utility");
ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

const inputDir = path.join(__dirname, "input");
const outputDir = path.join(__dirname, "output");
const assetsDir = path.join(__dirname, "assets");
const audioDir = path.join(__dirname, "audio");
const voiceOverDir = path.join(__dirname, "audio/voiceOver");
const partDir = path.join(__dirname, "output/parts");
const PART_MINUTES = 9;
// Trim settings - remove seconds from start and end
const TRIM_START_SECONDS = 1200; // Remove 90 seconds from start
const TRIM_END_SECONDS = 100; // Remove 3 seconds from end

async function run() {
  const inputFiles = fs
    .readdirSync(inputDir)
    .map((file) => path.join(inputDir, file));
  if (inputFiles.length === 0) {
    throw new Error(`No video found in input dir: ${inputDir}`);
  }
  for (const inputVideo of inputFiles) {
    const duration = await getDuration(inputVideo);
    console.log(`Duration of ${inputVideo}: ${duration}`);
    if (duration > PART_MINUTES * 60) {
      await splitVideo({
        inputVideo,
        processDir: partDir,
        partMinutes: PART_MINUTES,
        trimStart: TRIM_START_SECONDS,
        trimEnd: TRIM_END_SECONDS,
      });
    } else {
      await videoProcessor(
        inputVideo,
        outputDir,
        assetsDir,
        audioDir,
        voiceOverDir,
      );
    }

    console.log(`Finished ${inputVideo}`);
  }
}

async function splitVideo({
  inputVideo,
  processDir,
  partMinutes = 5,
  trimStart = 0,
  trimEnd = 0,
}) {
  fs.mkdirSync(processDir, { recursive: true });
  const seconds = partMinutes * 60;
  const MIN_PART_DURATION_SECONDS = 5;

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
  let totalDuration = await getDuration(inputVideo);

  // Apply trimming to total duration
  const trimmedDuration = totalDuration - trimStart - trimEnd;
  if (trimmedDuration < MIN_PART_DURATION_SECONDS) {
    console.log(
      `Video is too short after trimming: ${trimmedDuration} seconds`,
    );
    return [];
  }

  const ext = ".mp4";
  const baseName = path.basename(inputVideo, ext);
  const processedFiles = [];

  let startSeconds = trimStart; // Start from trim position
  let partIndex = 0;

  while (startSeconds < totalDuration - trimEnd) {
    partIndex++;
    let partSeconds = getRandomNumber(seconds, seconds + 50);
    const maxDuration = totalDuration - trimEnd - startSeconds;
    const durationSeconds = Math.min(partSeconds, maxDuration);

    console.log(
      `Part ${partIndex}: ${durationSeconds}s (random: ${partSeconds}s)`,
    );
    const partNumber = String(partIndex).padStart(2, "0");
    const splitPartPath = path.join(
      processDir,
      `${baseName}-part-${partNumber}${ext}`,
    );

    console.log(
      `Splitting part ${partIndex}: ${Math.round(durationSeconds)}s - ${splitPartPath}`,
    );

    await cutPart({
      startSeconds,
      durationSeconds,
      outputPath: splitPartPath,
    });

    console.log(
      `Processing: ${partIndex} our of ${Math.ceil(trimmedDuration / seconds)}`,
    );

    const processedOutput = await videoProcessor(
      splitPartPath,
      outputDir,
      assetsDir,
      audioDir,
      voiceOverDir,
    );

    processedFiles.push({
      splitPartPath,
      processedOutput,
    });
    startSeconds += durationSeconds;

    const removed = await removeFile(splitPartPath);
    console.log(
      removed
        ? `Removed temp part: ${splitPartPath}`
        : `Temp part already missing: ${splitPartPath}`,
    );
  }

  return processedFiles;
}

function videoProcessor(
  videoPath,
  outputDir,
  assetsDir,
  audioDir,
  voiceOverDir,
) {
  const SPEED_FACTOR = 1.06;
  const OUTPUT_WIDTH = 1440;
  const OUTPUT_HEIGHT = 1080;
  const HALF_WIDTH = Math.floor(OUTPUT_WIDTH / 2);
  const HALF_HEIGHT = Math.floor(OUTPUT_HEIGHT / 2);
  const OUTPUT_FPS = 28;
  const X264_PRESET = "fast";
  const CRF = "24";
  const OVERLAY_OPACITY = 0.05;
  const OVERLAY_DURATION = 1.5;
  const OVERLAY_MIN_GAP = 8;
  const OVERLAY_MAX_GAP = 20;
  const BLUR_STRENGTH = 5;
  const VOICE_PITCH = 0.93;
  const ORIGINAL_AUDIO_VOLUME = 1.0;
  const BED_AUDIO_VOLUME = 0.12;
  const VOICEOVER_VOLUME = 0.3;
  const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".mkv", ".webm"]);
  const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

  const brandText = escapeDrawtext("Nhrepon.com");
  const showBottomText = true;
  const showVoiceover = false;
  const hueShift = 0.38;

  let fileName = path.basename(videoPath); // adjust if you run from repo root
  const fileExt = path.extname(fileName);
  const fileBaseName = path.basename(fileName, fileExt);
  const assetPath = (fileName) => path.join(assetsDir, fileName);
  const drawtextFont = assetPath("RacingSansOne-Regular.ttf")
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:");
  const logoPath = assetPath("logo.png");

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

  async function processVideo() {
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.mkdirSync(outputDir, { recursive: true });
    fs.mkdirSync(inputDir, { recursive: true });
    fs.mkdirSync(voiceOverDir, { recursive: true });

    const inputVideo = videoPath;
    const audioFiles = getAudioFiles(audioDir);
    if (audioFiles.length === 0) {
      throw new Error(`No audio files found in ${audioDir}`);
    }
    const extraAudio = audioFiles[getRandomNumber(0, audioFiles.length - 1)];
    const voiceFiles = getAudioFiles(voiceOverDir);
    const voiceOver =
      voiceFiles.length > 0
        ? voiceFiles[getRandomNumber(0, voiceFiles.length - 1)]
        : null;
    if (voiceOver) {
      console.log(`Voiceover: ${path.basename(voiceOver)}`);
    } else {
      console.warn(`No voiceover files in ${voiceOverDir}`);
    }
    const randomId = Math.floor(Math.random() * 999) + 1;
    const outputFileName =
      `${fileBaseName}`
        .trim()
        .replace(/\s+/g, "-")
        .replace(/[^a-zA-Z0-9-]/g, "-")
        .replace(/-+/g, "-")
        .toLowerCase() + `-${randomId}-by-nhrepon.mp4`;

    const outputVideo = path.join(outputDir, outputFileName);

    if (!fs.existsSync(inputVideo))
      throw new Error(`input.mp4 not found at ${inputVideo}`);
    if (!extraAudio || !fs.existsSync(extraAudio)) {
      throw new Error(`audio not found at ${extraAudio}`);
    }

    const overlayAssets = getOverlayAssets();
    if (overlayAssets.length === 0)
      throw new Error(
        "No overlay asset found. Add own-footage.* or own-image.* to assets/",
      );

    const [mainOrigDur] = await Promise.all([getMediaDuration(inputVideo)]);

    const mainDuration = mainOrigDur / SPEED_FACTOR;
    const overlays = buildOverlayPlan(
      mainDuration,
      overlayAssets.length,
      OVERLAY_DURATION,
      OVERLAY_MIN_GAP,
      OVERLAY_MAX_GAP,
    );

    console.log(`Video duration: ${mainOrigDur.toFixed(2)}s`);
    console.log(`Using ${overlayAssets.length} overlay asset(s)`);
    console.log(`Inserting ${overlays.length} random overlay segment(s)`);

    const inputs = [
      {
        path: inputVideo,
        type: "video",
        label: "main",
      },
      { path: extraAudio, type: "audio", label: "audio" },
    ];
    if (voiceOver && showVoiceover) {
      inputs.push({ path: voiceOver, type: "audio", label: "voiceover" });
    }
    inputs.push(
      ...overlayAssets.map((a, i) => ({
        ...a,
        label: a.label || `overlay_${i}`,
      })),
    );
    const hasLogo = fs.existsSync(logoPath);
    if (hasLogo) {
      inputs.push({ path: logoPath, type: "image", label: "logo" });
    }

    const inputIndex = (label) => {
      const index = inputs.findIndex((inp) => inp.label === label);
      if (index < 0) throw new Error(`Missing ffmpeg input: ${label}`);
      return index;
    };
    const overlayBaseIdx =
      voiceOver && showVoiceover ? inputIndex("voiceover") + 1 : 2;
    // Debug: Log input order
    console.log("Input order:");
    inputs.forEach((inp, idx) => {
      console.log(`  ${idx}: ${inp.label} (${inp.type}) - ${inp.path}`);
    });

    const command = ffmpeg();
    inputs.forEach((inp) => addInput(command, inp, OVERLAY_DURATION));

    const fc = [];
    // const gradeFilter = `hue=s=${hueShift},eq=contrast=1.04:brightness=0.01`;
    // const gradeFilter = `hue=s=${hueShift},eq=contrast=1.12:brightness=0.02:saturation=1.15,unsharp=7:7:1.5:5:5:0.8,eq=brightness=0.02:contrast=1.05:gamma=1.05`;
    // Add a slight gamma and unsharp filter to heavily alter the frame signature
    const gradeFilter = `hue=s=${hueShift},eq=contrast=1.08:brightness=0.02:gamma=1.05,unsharp=5:5:1.0:5:5:0.5`;

    fc.push(
      `[0:v]setpts=PTS/${SPEED_FACTOR},tmix=frames=2:weights="0.18 0.35 0.47",split=2[mainA][mainB]`,
    );
    // fc.push(
    //   `[0:v]setpts=PTS/${SPEED_FACTOR},split=2,[mainA][mainB]`,
    // );

    // Main: apply blur on half-res background, foreground at full res
    fc.push(
      `[mainA]scale=${HALF_WIDTH}:${HALF_HEIGHT}:force_original_aspect_ratio=increase,crop=${HALF_WIDTH}:${HALF_HEIGHT},boxblur=${BLUR_STRENGTH},scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT},${gradeFilter}[mainbg]`,
    );
    fc.push(
      `[mainB]hflip,scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=increase,${gradeFilter}[mainfg]`,
    );
    fc.push(`[mainbg][mainfg]overlay=(W-w)/2:(H-h)/2[mainbase]`);
    let currentMainLabel = "[mainbase]";
    overlays.forEach((ov, idx) => {
      const overallInputIndex = overlayBaseIdx + ov.assetIndex;
      const overlayLabel = `[ov${idx}]`;
      // scaled once; for image we already looped with -t but treat same in filter
      fc.push(
        `[${overallInputIndex}:v]scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=increase,crop=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT},format=rgba,colorchannelmixer=aa=${OVERLAY_OPACITY}${overlayLabel}`,
      );
      const outLabel = `[mlayer${idx}]`;
      fc.push(
        `${currentMainLabel}${overlayLabel}overlay=0:0:enable='between(t,${ov.start},${ov.end})'${outLabel}`,
      );
      currentMainLabel = outLabel;
    });

    if (showBottomText) {
      fc.push(
        `${currentMainLabel}drawtext=text='${brandText}':fontfile='${drawtextFont}':fontcolor=white:fontsize=48:borderw=2:bordercolor=black:x=(w-text_w)/2:y=h-text_h-10:fix_bounds=true:enable='gte(t,0)',setsar=1[mainv]`,
      );
    }

    let finalVideoLabel = "[mainv]";
    // logo
    if (hasLogo) {
      const logoInputIndex = inputIndex("logo");
      fc.push(`[${logoInputIndex}:v]scale=${140}:-1,format=rgba[mainlogo]`);
      fc.push(`[mainv][mainlogo]overlay=W-w-10:10[mainvwithlogo]`);
      finalVideoLabel = "[mainvwithlogo]";
    }

    // Generate random modifiers for each video
    const mainOrigVolume =
      voiceOver && showVoiceover ? "1.2" : ORIGINAL_AUDIO_VOLUME;

    // Original movie audio (speed-matched to main clip) ,highpass=f=80,lowpass=f=12500
    // `[0:a]aresample=44100,asetrate=44100*${VOICE_PITCH},${atempoFilters(SPEED_FACTOR / VOICE_PITCH)},highpass=f=110,lowpass=f=8500,afftdn=nf=-25,equalizer=f=180:width_type=h:width=120:g=-2,equalizer=f=2800:width_type=h:width=1400:g=4,equalizer=f=5200:width_type=h:width=1800:g=2,acompressor=threshold=0.06:ratio=3:attack=12:release=180:makeup=1.7,alimiter=limit=0.96,volume=${mainOrigVolume}[mainorig]`,
    fc.push(
      `[0:a]aresample=44100,asetrate=44100*${VOICE_PITCH},${atempoFilters(SPEED_FACTOR / VOICE_PITCH)},aresample=44100,afftdn=nr=25:nf=-45:tn=1,volume=${mainOrigVolume}[mainorig]`,
    );

    // Bed music: stream_loop on input (aloop size=32767 truncates to ~0.7s)
    fc.push(`[1:a]atempo=1,volume=${BED_AUDIO_VOLUME}[mainbed]`);

    if (voiceOver && showVoiceover) {
      const voiceOverInputIndex = inputIndex("voiceover");
      fc.push(
        `[${voiceOverInputIndex}:a]atempo=1,afftdn=nr=25:nf=-45:tn=1,volume=${VOICEOVER_VOLUME}[voiceovermix]`,
      );
      fc.push(
        `[mainorig][mainbed][voiceovermix]amix=inputs=3:duration=first:dropout_transition=2[finala]`,
      );
    } else {
      fc.push(
        `[mainorig][mainbed]amix=inputs=2:duration=first:dropout_transition=2[finala]`,
      );
    }

    // concat
    fc.push(`${finalVideoLabel}[finala]concat=n=1:v=1:a=1[outv][outa]`);

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
          if (elapsed === null || mainDuration <= 0) return;
          const safeTotal = Math.max(mainDuration, elapsed, 0.001);
          const percent = Math.min((elapsed / safeTotal) * 100, 99.4);
          const rounded = Math.floor(percent);
          if (rounded <= lastLoggedPercent) return;
          lastLoggedPercent = rounded;
          console.log(
            `Progress: ${percent.toFixed(1)}% ✅ ${elapsed.toFixed(1)}s done of ${mainDuration.toFixed(1)}s`,
          );
        })
        .on("end", async () => {
          try {
            const hash = await fileSha256Hex(outputVideo);
            console.log("✅ Progress: 100.0%");
            console.log("\n🎉 Done!");
            console.log(`✅ Output: ${outputVideo}`);
            console.log(`✅ SHA256: ${hash}`);
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

run().catch(console.error);
