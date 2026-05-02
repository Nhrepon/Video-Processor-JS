const os = require("os");
const fs = require("fs");
const path = require("path");
const ffmpeg = require("fluent-ffmpeg");
const { reverseVideo, mergeVideo } = require("./utility");
const { videoProcessor } = require("./videoProcessor");

// ---------- helpers ----------

function createWorkspace() {
  const jobId = Date.now() + "-" + Math.random().toString(36).slice(2, 8);
  const dir = path.join(os.tmpdir(), "video-pipeline", jobId);

  const paths = {
    root: dir,
    reversed: path.join(dir, "reversed.mp4"),
    merged: path.join(dir, "merged.mp4"),
    extended: path.join(dir, "extended.mp4"),
    parts: path.join(dir, "parts"),
  };

  fs.mkdirSync(paths.parts, { recursive: true });

  return { jobId, paths };
}

function cleanupWorkspace(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    console.log("🧹 Cleaned temp:", dir);
  } catch (e) {
    console.warn("Cleanup failed:", e.message);
  }
}

function getDuration(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(err);

      const duration = Number(metadata?.format?.duration);
      if (!Number.isFinite(duration)) {
        return reject(new Error(`Invalid duration: ${filePath}`));
      }

      resolve(duration);
    });
  });
}

function cutVideo({ input, start, duration, output }) {
  return new Promise((resolve, reject) => {
    ffmpeg(input)
      .setStartTime(start)
      .duration(duration)
      .outputOptions([
        "-c:v libx264",
        "-preset fast",
        "-crf 23",
        "-c:a aac",
        "-b:a 192k",
        "-movflags +faststart",
        "-y",
      ])
      .output(output)
      .on("end", () => resolve(output))
      .on("error", reject)
      .run();
  });
}

// ---------- extend (reverse + concat + loop) ----------

async function extendVideo({
  source,
  workspace,
  minDuration,
}) {
  const { reversed, merged, extended } = workspace.paths;

  // IMPORTANT: your reverseVideo / mergeVideo should accept output path
  await reverseVideo(source, reversed);
  await mergeVideo(source, reversed, merged);

  const mergedDuration = await getDuration(merged);
  const safe = Math.max(mergedDuration, 0.001);

  const loops = Math.ceil(minDuration / safe) - 1;

  return new Promise((resolve, reject) => {
    ffmpeg(merged)
      .inputOptions(["-stream_loop", String(Math.max(loops, 0))])
      .outputOptions([
        "-t", String(minDuration), // force exact duration
        "-c:v libx264",
        "-preset fast",
        "-crf 23",
        "-c:a aac",
        "-b:a 192k",
        "-movflags +faststart",
        "-y",
      ])
      .output(extended)
      .on("end", () => resolve(extended))
      .on("error", reject)
      .run();
  });
}

// ---------- MAIN FUNCTION ----------

async function splitVideo({
  inputVideo,
  processedOutputDir,
  introDir,
  assetsDir,
  audioDir,
  partMinutes = 1,
}) {
  const MIN_INPUT_DURATION = 30;
  const MIN_PART_DURATION = 30;
  const PART_SECONDS = partMinutes * 60;

  if (!inputVideo || !fs.existsSync(inputVideo)) {
    throw new Error(`Input video not found: ${inputVideo}`);
  }

  fs.mkdirSync(processedOutputDir, { recursive: true });

  const workspace = createWorkspace();

  let sourceVideo = inputVideo;
  let totalDuration = 0;

  try {
    totalDuration = await getDuration(sourceVideo);

    // ---------- extend if too short ----------
    if (totalDuration < MIN_INPUT_DURATION) {
      console.log(
        `Extending short video (${totalDuration.toFixed(2)}s → ${MIN_INPUT_DURATION}s)`
      );

      sourceVideo = await extendVideo({
        source: inputVideo,
        workspace,
        minDuration: MIN_INPUT_DURATION,
      });

      totalDuration = await getDuration(sourceVideo);
    }

    const totalParts = Math.ceil(totalDuration / PART_SECONDS);
    const results = [];

    // ---------- split loop ----------
    for (let i = 0; i < totalParts; i++) {
      const start = i * PART_SECONDS;
      const duration = Math.min(PART_SECONDS, totalDuration - start);

      if (duration < MIN_PART_DURATION) {
        console.log(`Skipping part ${i + 1} (too short: ${duration}s)`);
        continue;
      }

      const partPath = path.join(
        workspace.paths.parts,
        `part-${String(i + 1).padStart(2, "0")}.mp4`
      );

      console.log(
        `Cutting part ${i + 1}/${totalParts} (${Math.round(duration)}s)`
      );

      await cutVideo({
        input: sourceVideo,
        start,
        duration,
        output: partPath,
      });

      console.log(`Processing: ${partPath}`);

      const processed = await videoProcessor(
        partPath,
        processedOutputDir,
        introDir,
        assetsDir,
        audioDir
      );

      results.push({
        part: partPath,
        output: processed,
      });
    }

    return results;

  } finally {
    // ---------- ALWAYS CLEAN ----------
    cleanupWorkspace(workspace.paths.root);
  }
}

module.exports = { splitVideo };