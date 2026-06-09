const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("@ffmpeg-installer/ffmpeg").path;
const ffprobePath = require("@ffprobe-installer/ffprobe").path;
const fs = require("fs");
const path = require("path");
const {
  getRandomNumber,
  getAudioFiles,
  removeFile,
  getDuration,
  buildOverlayPlan,
  addInput,
  getMediaDuration,
  atempoFilters,
  fileSha256Hex,
  escapeDrawtext,
  getMediaMetadata,
} = require("./utility/utility");
ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

const inputDir = path.join(__dirname, "input");
const outputDir = path.join(__dirname, "output");
const introDir = path.join(__dirname, "intro");
const assetsDir = path.join(__dirname, "assets");
const audioDir = path.join(__dirname, "audio");
const partDir = path.join(__dirname, "output/parts");

const PART_MINUTES = 3;
const TRIM_START_SECONDS = 20;
const TRIM_END_SECONDS = 15;

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
        introDir,
        assetsDir,
        audioDir
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
  const seconds = partMinutes * 60;
  const MIN_PART_DURATION_SECONDS = 5;

  const cutPart = ({ startSeconds, durationSeconds, outputPath }) =>
    new Promise((resolve, reject) => {
      ffmpeg(inputVideo)
        .setStartTime(startSeconds)
        .duration(durationSeconds)
        .outputOptions([
          "-c",
          "copy",
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

  let startSeconds = trimStart;
  let partIndex = 0;

  while (startSeconds < totalDuration - trimEnd) {
    partIndex++;
    let partSeconds = getRandomNumber(seconds, seconds + 50);
    const durationSeconds = Math.min(
      partSeconds,
      totalDuration - trimEnd - startSeconds,
    );

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
      `Processing: ${partIndex} our of ${Math.ceil(totalDuration / seconds)}`,
    );

    const processedOutput = await videoProcessor(
      splitPartPath,
      outputDir,
      introDir,
      assetsDir,
      audioDir,
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

function videoProcessor(videoPath, outputDir, introDir, assetsDir, audioDir) {
  const SPEED_FACTOR = 1.06;
  const OUTPUT_WIDTH = 1440; // 1440
  const OUTPUT_HEIGHT = 1080;
  const HALF_WIDTH = Math.floor(OUTPUT_WIDTH / 2);
  const HALF_HEIGHT = Math.floor(OUTPUT_HEIGHT / 2);
  const OUTPUT_FPS = 30;
  const X264_PRESET = "fast";
  const CRF = "24";
  const OVERLAY_OPACITY = 0.05;
  const OVERLAY_DURATION = 1.5;
  const OVERLAY_MIN_GAP = 8;
  const OVERLAY_MAX_GAP = 20;
  const BLUR_STRENGTH = 5;
  const VOICE_PITCH = 0.96;
  const ORIGINAL_AUDIO_VOLUME = 1.0;
  const BED_AUDIO_VOLUME = 0.11;
  const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".mkv", ".webm"]);
  const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
  const showTopText = false;
  const showBottomText = true;
  const showIntro = true;
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

    const inputVideo = videoPath;
    const introVideoList = fs.readdirSync(introDir);
    const introVideo = introVideoList.map((file) => path.join(introDir, file))[getRandomNumber(0, introVideoList.length - 1)];
    const audioFiles = getAudioFiles(audioDir);
    if (audioFiles.length === 0) {
      throw new Error("No audio files found in audio directory");
    }
    const extraAudio =
      audioFiles.length > 0
        ? audioFiles[getRandomNumber(0, audioFiles.length - 1)]
        : null;
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
    if (!fs.existsSync(introVideo))
      throw new Error(`intro.mp4 not found at ${introVideo}`);
    if (!fs.existsSync(extraAudio))
      throw new Error(`audio.mp4 not found at ${extraAudio}`);

    const overlayAssets = getOverlayAssets();
    if (overlayAssets.length === 0)
      throw new Error(
        "No overlay asset found. Add own-footage.* or own-image.* to assets/",
      );

    const { duration: mainOrigDur, hasAudio } = await getMediaMetadata(inputVideo);
    const introOrigDur = showIntro ? await getMediaDuration(introVideo) : 0;

    const mainDuration = mainOrigDur / SPEED_FACTOR;
    const introDuration = showIntro ? introOrigDur : 0;
    const totalDuration = mainDuration + introDuration;
    const overlays = buildOverlayPlan(
      mainDuration,
      overlayAssets.length,
      OVERLAY_DURATION,
      OVERLAY_MIN_GAP,
      OVERLAY_MAX_GAP,
    );

    console.log(`Original video duration: ${mainOrigDur.toFixed(2)}s`);
    console.log(`Using ${overlayAssets.length} overlay asset(s)`);
    console.log(`Inserting ${overlays.length} random overlay segment(s)`);

    const inputs = [
      {
        path: inputVideo,
        type: "video",
        label: "main",
      },
      { path: extraAudio, type: "audio", label: "audio" },
      ...overlayAssets.map((a, i) => ({
        path: a.path,
        type: a.type,
        name: a.name,
        label: `overlay_${i}`,
      })),
    ];
    const hasLogo = fs.existsSync(logoPath);
    if (hasLogo) {
      inputs.push({ path: logoPath, type: "image", label: "logo" });
    }
    if (showIntro) {
      inputs.push({ path: introVideo, type: "video", label: "intro" });
    }

    const inputIndex = (label) => {
      const index = inputs.findIndex((inp) => inp.label === label);
      if (index < 0) throw new Error(`Missing ffmpeg input: ${label}`);
      return index;
    };

    const mainIdx = inputIndex("main");
    const audioIdx = inputIndex("audio");
    const logoIdx = hasLogo ? inputIndex("logo") : -1;
    const introIdx = showIntro ? inputIndex("intro") : -1;
    const overlayBaseIdx = inputIndex("overlay_0");

    // Debug: Log input order
    console.log("Input order:");
    inputs.forEach((inp, idx) => {
      console.log(`  ${idx}: ${inp.label} (${inp.type}) - ${inp.path}`);
    });

    const command = ffmpeg();
    inputs.forEach((inp) => addInput(command, inp, OVERLAY_DURATION));

    const fc = [];
    // const gradeFilter = "hue=s=0.58,eq=contrast=1.04:brightness=0.01";
    const gradeFilter = `hue=s=${hueShift},eq=contrast=1.05:brightness=0.01:saturation=1.11,unsharp=7:7:1.5:5:5:0.8,eq=brightness=0.01:contrast=1.05:gamma=1.05`;

    // Main: apply blur on half-res background, foreground at full res
    fc.push(`[0:v]setpts=PTS/${SPEED_FACTOR},split=2[mainA][mainB]`);
    fc.push(
      `[mainA]scale=${HALF_WIDTH}:${HALF_HEIGHT}:force_original_aspect_ratio=increase,crop=${HALF_WIDTH}:${HALF_HEIGHT},boxblur=${BLUR_STRENGTH},scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT},${gradeFilter}[mainbg]`,
    );
    fc.push(
      `[mainB]hflip,scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=increase,crop=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:(iw-ow)/2:(ih-oh)/2,${gradeFilter}[mainfg]`, // `[mainB]hflip,scale=${OUTPUT_SIZE - 180}:${OUTPUT_SIZE - 180}:force_original_aspect_ratio=increase,${gradeFilter}[mainfg]`,
    );
    fc.push(`[mainbg][mainfg]overlay=(W-w)/2:(H-h)/2[mainbase]`);

    let currentMainLabel = "[mainbase]";

    overlays.forEach((ov, idx) => {
      const overallInputIndex = overlayBaseIdx + ov.assetIndex;
      const overlayLabel = `[ov${idx}]`;

      // Scale overlay input and apply opacity
      fc.push(
        `[${overallInputIndex}:v]scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=increase,crop=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT},format=rgba,colorchannelmixer=aa=${OVERLAY_OPACITY}${overlayLabel}`
      );

      const outLabel = `[mlayer${idx}]`;
      fc.push(
        `${currentMainLabel}${overlayLabel}overlay=0:0:enable='between(t,${ov.start},${ov.end})'${outLabel}`
      );
      currentMainLabel = outLabel;
    });

    const brandText = escapeDrawtext("Nhrepon.com");
    if (showTopText) {
      fc.push(
        `${currentMainLabel}drawtext=text='${brandText}':fontfile='${drawtextFont}':fontcolor=white:fontsize=42:borderw=3:bordercolor=black:x=40:y=20:fix_bounds=true:enable='gte(t,0)'[maintoptext]`, //box=1:boxcolor=black@0.55:boxborderw=18:
      );
    }

    if (showBottomText) {
      fc.push(
        `${showTopText ? "[maintoptext]" : currentMainLabel}drawtext=text='${brandText}':fontfile='${drawtextFont}':fontcolor=white:fontsize=48:borderw=2:bordercolor=black:x=(w-text_w)/2:y=h-text_h-10:fix_bounds=true:enable='gte(t,0)',setsar=1[mainv]`,
      );
    }
    // logo
    if (hasLogo) {
      fc.push(`[${logoIdx}:v]scale=${140}:-1,format=rgba[mainlogo]`);
      fc.push(`[mainv][mainlogo]overlay=W-w-10:10[mainvwithlogo]`);
    }

    // Keep intro at original size: center-crop if too large, pad if too small.
    if (showIntro) {
      fc.push(
        `[${introIdx}:v]crop='min(iw,${OUTPUT_WIDTH})':'min(ih,${OUTPUT_HEIGHT})':(iw-min(iw\\,${OUTPUT_WIDTH}))/2:(ih-min(ih\\,${OUTPUT_HEIGHT}))/2,pad=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[introv]`,
      );
    }

    // Audio
    if (hasAudio) {
      fc.push(
        `[${mainIdx}:a]asetrate=44100*${VOICE_PITCH},aresample=44100,${atempoFilters(SPEED_FACTOR / VOICE_PITCH)},volume=${ORIGINAL_AUDIO_VOLUME}[mainorig]`,
      );
    }

    if (showIntro) {
      fc.push(`[${introIdx}:a]volume=0.3[introa]`);
      fc.push(`[${audioIdx}:a]${atempoFilters(SPEED_FACTOR)}[extraamain]`);
    } else {
      fc.push(`[${audioIdx}:a]${atempoFilters(SPEED_FACTOR)}[extraamain]`);
    }
    fc.push(
      `[extraamain]atrim=duration=${mainDuration.toFixed(3)},volume=${BED_AUDIO_VOLUME}[mainbed]`,
    );
    if (hasAudio) {
      fc.push(
        `[mainorig][mainbed]amix=inputs=2:duration=first:dropout_transition=2[maina]`,
      );
    } else {
      fc.push(`[mainbed]anull[maina]`);
    }
    fc.push(`[maina]atrim=duration=${totalDuration.toFixed(3)}[finala]`);

    // Ensure final video matches full duration
    fc.push(`[${hasLogo ? "mainvwithlogo" : "mainv"}]setpts=PTS[finalv]`);
    fc.push(`[finalv]trim=duration=${totalDuration}[finalv_trim]`);
    
    // Concat intro if enabled
    if (showIntro) {
      fc.push(
        `[introv][introa][finalv_trim][finala]concat=n=2:v=1:a=1[outv][outa]`,
        // `[finalv_trim][finala][introv][introa]concat=n=2:v=1:a=1[outv][outa]`,
      );
    } else {
      fc.push(`[finalv_trim]null[outv]`);
      fc.push(`[finala]anull[outa]`);
    }

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
      "-shortest",
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
