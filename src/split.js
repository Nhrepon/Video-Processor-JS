const { splitVideo } = require("./utility/splitVideo");
const path = require("path");
const fs = require("fs");

const inputDir = path.join(__dirname, "input");
const outputDir = path.join(__dirname, "output/partOutput");

async function run() {
  fs.mkdirSync(inputDir, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });
  const inputFiles = fs
    .readdirSync(inputDir)
    .map((file) => path.join(inputDir, file));
  if (inputFiles.length === 0) {
    throw new Error(`No video found in input dir: ${inputDir}`);
  }
  for (const inputVideo of inputFiles) {
    const results = await splitVideo({ inputVideo, outputDir, partMinutes: 2 });

    console.log(`Finished ${inputVideo}`);
    console.log(`Total ${results.length} video processed...`);
  }
}
run().catch(console.error);
