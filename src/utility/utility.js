const fs = require("fs");
const path = require("path");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("@ffmpeg-installer/ffmpeg").path;
const ffprobePath = require("@ffprobe-installer/ffprobe").path;
const crypto = require("crypto");

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

async function removeFile(filePath) {
  if (!filePath) return false;

  const RETRYABLE_CODES = new Set(["EBUSY", "EPERM"]);
  const MAX_ATTEMPTS = 8;
  const BASE_DELAY_MS = 150;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      await fs.promises.unlink(filePath);
      return true;
    } catch (error) {
      if (error && error.code === "ENOENT") {
        return false;
      }

      const shouldRetry =
        error && RETRYABLE_CODES.has(error.code) && attempt < MAX_ATTEMPTS;

      if (!shouldRetry) {
        throw error;
      }

      await new Promise((resolve) =>
        setTimeout(resolve, BASE_DELAY_MS * attempt),
      );
    }
  }

  return false;
}

function getRandomNumber(min = 0, max = 99999) {
  const lowerBound = Math.ceil(min);
  const upperBound = Math.floor(max);

  if (lowerBound > upperBound) {
    throw new Error("min cannot be greater than max");
  }

  return Math.floor(Math.random() * (upperBound - lowerBound + 1)) + lowerBound;
}

function getAudioFiles(dir) {
  if (!dir || !fs.existsSync(dir)) {
    return [];
  }

  return fs
    .readdirSync(dir)
    .map((file) => path.resolve(dir, file))
    .filter((filePath) => {
      try {
        return fs.statSync(filePath).isFile();
      } catch {
        return false;
      }
    })
    .filter((filePath) => /\.(mp3|wav|m4a|aac|ogg|flac|mp4)$/i.test(filePath));
}

function getDuration(filePath) {
  return new Promise((resolve, reject) => {
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

function timemarkToSeconds(timemark) {
  if (!timemark) return null;
  const parts = timemark.split(":").map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null;
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

// async function reverseVideo(videoPath) {
//   return new Promise((resolve, reject) => {
//     const outputPath = videoPath.replace(/(\.[^.]+)$/, '_reversed$1');

//     ffmpeg(videoPath)
//       .outputOptions([
//         '-vf reverse',
//         '-af areverse',
//         '-c:v libx264',
//         '-preset fast',
//         '-crf 23',
//         '-c:a aac',
//         '-b:a 192k',
//         '-movflags +faststart',
//         '-y' // overwrite
//       ])
//       .output(outputPath)
//       .on('end', () => resolve(outputPath))
//       .on('error', reject)
//       .run();
//   });
// }

// async function mergeVideo(video1, video2, tempPartDir) {
//   return new Promise((resolve, reject) => {
//     const outputPath = path.join(tempPartDir, 'merged_video.mp4');

//     const command = ffmpeg()
//       .input(video1)
//       .input(video2);

//     command
//       .complexFilter([
//         '[0:v][1:v]concat=n=2:v=1:a=0[outv]',
//         '[0:a?][1:a?]concat=n=2:v=0:a=1[outa]'
//       ])
//       .outputOptions([
//         '-map [outv]',
//         '-map [outa]?',
//         '-c:v libx264',
//         '-preset fast',
//         '-crf 23',
//         '-c:a aac',
//         '-b:a 192k',
//         '-movflags +faststart',
//         '-y'
//       ])
//       .output(outputPath)
//       .on('end', () => resolve(outputPath))
//       .on('error', reject)
//       .run();
//   });
// }

async function reverseVideo(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .outputOptions([
        "-vf reverse",
        "-af areverse",
        "-c:v libx264",
        "-preset fast",
        "-crf 23",
        "-c:a aac",
        "-b:a 192k",
        "-movflags +faststart",
        "-y",
      ])
      .output(outputPath + "_reversed.mp4")
      .on("end", () => resolve(outputPath + "_reversed.mp4"))
      .on("error", reject)
      .run();
  });
}

async function mergeVideo(video1, video2, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(video1)
      .input(video2)
      .complexFilter([
        "[0:v][1:v]concat=n=2:v=1:a=0[outv]",
        "[0:a?][1:a?]concat=n=2:v=0:a=1[outa]",
      ])
      .outputOptions([
        "-map [outv]",
        "-map [outa]?", // safe if no audio
        "-c:v libx264",
        "-preset fast",
        "-crf 23",
        "-c:a aac",
        "-b:a 192k",
        "-movflags +faststart",
        "-y",
      ])
      .output(outputPath + "_merged.mp4")
      .on("end", () => resolve(outputPath + "_merged.mp4"))
      .on("error", reject)
      .run();
  });
}

module.exports = {
  removeFile,
  getRandomNumber,
  getAudioFiles,
  reverseVideo,
  mergeVideo,
  getDuration,
  fileSha256Hex,
  timemarkToSeconds,
};
