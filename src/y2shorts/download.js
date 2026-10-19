/**
 * YouTube downloader for the y2shorts pipeline.
 *
 * Wraps yt-dlp (binary or `python -m yt_dlp`) to fetch metadata + media and
 * cache it locally, so a re-render never re-downloads. Mirrors the approach
 * already proven in src/B2E/ingest.js.
 */
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { sanitizeFileName } = require("./text");

function log(line) {
  console.log(`[y2shorts:download] ${line}`);
}

function fail(line) {
  throw new Error(`[y2shorts:download] ${line}`);
}

// Prefer the standalone yt-dlp binary; fall back to the python module so this
// works on machines where only one of the two is installed.
function ytdlpCommand() {
  const probe = spawnSync("yt-dlp", ["--version"], { encoding: "utf-8" });
  if (!probe.error && probe.status === 0) return { cmd: "yt-dlp", prefix: [] };
  log("yt-dlp binary not found, falling back to `python -m yt_dlp`");
  return { cmd: "python", prefix: ["-m", "yt_dlp"] };
}

function runYtdlp(args, label) {
  const { cmd, prefix } = ytdlpCommand();
  const full = [...prefix, ...args];
  log(`${label}: yt-dlp ${args.join(" ")}`);
  const r = spawnSync(cmd, full, {
    encoding: "utf-8",
    maxBuffer: 1024 * 1024 * 64,
  });
  if (r.error) fail(`${label} could not start: ${r.error.message}`);
  if (r.status !== 0) {
    fail(
      `${label} failed (exit ${r.status}):\n${r.stdout || ""}${r.stderr || ""}`,
    );
  }
  return r;
}

function qualityArgs(quality) {
  if (quality === "best") return ["-f", "bestvideo+bestaudio/best"];
  const h = String(quality || 1080);
  return [
    "-f",
    `bestvideo[height<=${h}]+bestaudio/best[height<=${h}]/best`,
  ];
}

function checkVersion() {
  const { cmd, prefix } = ytdlpCommand();
  const r = spawnSync(cmd, [...prefix, "--version"], { encoding: "utf-8" });
  if (r.error || r.status !== 0) {
    fail("yt-dlp not found. Install it with:  python -m pip install -U yt-dlp");
  }
  const version = (r.stdout || "").trim();
  log(`yt-dlp ${version}`);
  const m = version.match(/^(\d{4})\.(\d{1,2})\.(\d{1,2})/);
  if (m) {
    const now = new Date();
    const months =
      (now.getFullYear() - Number(m[1])) * 12 +
      (now.getMonth() + 1 - Number(m[2]));
    if (months >= 3) {
      log(
        `WARNING: yt-dlp ${version} is about ${months} months old. If downloads ` +
          `fail with "HTTP Error 403", run:  python -m pip install -U yt-dlp`,
      );
    }
  }
}

/**
 * Download a YouTube URL into cacheDir and return { filePath, id, title, duration }.
 * Reuses an existing file when present (unless force is set).
 */
function download(url, cacheDir, { quality = 1080, force = false } = {}) {
  if (!url) fail("a YouTube URL is required");
  fs.mkdirSync(cacheDir, { recursive: true });
  checkVersion();

  const meta = runYtdlp(
    ["--no-warnings", "--print", "%(id)s\t%(title)s\t%(duration)s", url],
    "probe",
  );
  const line = (meta.stdout || "").trim().split("\n").pop() || "";
  const [id, rawTitle, rawDuration] = line.split("\t");
  if (!id) fail(`could not resolve video id from: ${url}`);

  const title = rawTitle || id;
  const duration = Number(rawDuration);
  const safeTitle = sanitizeFileName(title, id);
  const outFile = path.join(cacheDir, `${safeTitle}.mp4`);

  log(`id:       ${id}`);
  log(`title:    ${title}`);
  log(`duration: ${Number.isFinite(duration) ? duration.toFixed(2) : "?"}s`);
  log(`target:   ${outFile}`);

  if (fs.existsSync(outFile) && fs.statSync(outFile).size > 1024 && !force) {
    log("already downloaded (using cache)");
    return { filePath: outFile, id, title, duration };
  }

  const dl = [
    ...qualityArgs(quality),
    "--no-playlist",
    "--merge-output-format",
    "mp4",
  ];
  if (force) dl.push("--force-overwrites", "--no-check-formats");
  dl.push("-o", outFile, url);

  runYtdlp(dl, "download");

  if (!fs.existsSync(outFile) || fs.statSync(outFile).size < 1024) {
    fail(`download reported success but no usable file at ${outFile}`);
  }
  log(`downloaded ${(fs.statSync(outFile).size / 1024 / 1024).toFixed(1)} MB`);

  return { filePath: outFile, id, title, duration };
}

module.exports = { download };
