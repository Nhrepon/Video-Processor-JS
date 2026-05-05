const ffmpeg = require("fluent-ffmpeg");
const { getDuration, getRandomNumber } = require("./utility");
const path = require("path");

async function splitVideo({ inputVideo, outputDir, partMinutes = 5 }) {
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

  if (totalDuration < MIN_PART_DURATION_SECONDS) {
    console.log(`Video is too short: ${totalDuration} seconds`);
    return [];
  }

  const ext = ".mp4";
  const baseName = path.basename(inputVideo, ext);
  const processedFiles = [];

  let startSeconds = 0;
  let partIndex = 0;

  while (startSeconds < totalDuration) {
    partIndex++;
    let partSeconds = getRandomNumber(seconds, seconds + 50);
    const durationSeconds = Math.min(partSeconds, totalDuration - startSeconds);

    console.log(
      `Part ${partIndex}: ${durationSeconds}s (random: ${partSeconds}s)`,
    );
    const partNumber = String(partIndex).padStart(2, "0");
    const splitPartPath = path.join(
      outputDir,
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

    processedFiles.push({
      splitPartPath,
      processedOutput: splitPartPath,
    });
    startSeconds += durationSeconds;
  }

  return processedFiles;
}

module.exports = {
  splitVideo,
};
