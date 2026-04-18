const fs = require("fs");
const path = require("path");

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
module.exports = {
  removeFile,
  getRandomNumber,
  getAudioFiles,
};
