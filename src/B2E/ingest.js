/**
 * Stage 0: ingest a YouTube URL (or fall back to a local file).
 *
 * Downloads the best available video+audio into src/input/youtube/<id>.mp4 and
 * returns the path, so every later stage is unchanged: they all just consume a
 * local mp4.
 *
 * Why a separate stage rather than a --url flag on b2e.js: downloading is slow,
 * network-dependent, and the single most likely thing to need re-running on its
 * own (bad format pick, expired link, wanting a different resolution). Keeping
 * it cached and separate means a re-dub never re-downloads.
 *
 * Run:  node src/B2E/ingest.js --url https://youtu.be/XXXX [--quality best|1080|720]
 *       node src/B2E/ingest.js --url ... --no-download     # resolve URL only
 */
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const B2E_DIR = __dirname;
const INPUT_YT_DIR = path.join(B2E_DIR, "..", "input", "youtube");

function log(line) {
  console.log(`[ingest] ${line}`);
}

function fail(line) {
  console.error(`[ingest] ERROR: ${line}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    // Support "--key=value" as well as "--key value"; the inline form is the only
    // safe way to pass a title or path containing spaces.
    const eq = key.indexOf("=");
    if (eq !== -1) {
      out[key.slice(0, eq)] = key.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) out[key] = true;
    else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

// Prefer the standalone yt-dlp binary; fall back to the python module so this works
// on machines where only one of the two is installed.
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
    fail(`${label} failed (exit ${r.status}):\n${(r.stdout || "")}${(r.stderr || "")}`);
  }
  return r;
}

function qualityArgs(quality) {
  // Cap the height rather than trusting "best": a 2160p source re-encoded to
  // 1080x1920 costs a lot of time and adds nothing once it is centre-cropped.
  if (quality === "best") return ["-f", "bestvideo+bestaudio/best"];
  const h = String(quality || 1080);
  return [
    "-f",
    `bestvideo[height<=${h}]+bestaudio/best[height<=${h}]/best`,
  ];
}

// YouTube gates downloads behind a client challenge, and a stale yt-dlp fails
// with a bare "HTTP Error 403: Forbidden" that looks like a network fault rather
// than an out-of-date binary. Check the version up front and say so explicitly,
// so the fix (pip install -U yt-dlp) is obvious.
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
    // Compare against the real current date rather than a hardcoded year, so
    // this stays correct over time instead of drifting into nonsense.
    const now = new Date();
    const months =
      (now.getFullYear() - Number(m[1])) * 12 + (now.getMonth() + 1 - Number(m[2]));
    if (months >= 3) {
      log(
        `WARNING: yt-dlp ${version} is about ${months} months old. If downloads ` +
          `fail with "HTTP Error 403", run:  python -m pip install -U yt-dlp`,
      );
    }
  }
}

/**
 * Read the video height of a local file via ffprobe, or null if unavailable.
 *
 * Confirms an ingest actually delivered the requested quality, since a successful
 * yt-dlp exit does not prove that (see the download-archive note below).
 */
function probeHeight(file) {
  try {
    const probe = require("@ffprobe-installer/ffprobe").path;
    const r = spawnSync(
      probe,
      ["-v", "error", "-select_streams", "v:0",
       "-show_entries", "stream=height", "-of", "csv=p=0", file],
      { encoding: "utf-8" },
    );
    if (r.error || r.status !== 0) return null;
    const h = parseInt((r.stdout || "").trim(), 10);
    return Number.isFinite(h) ? h : null;
  } catch {
    return null;
  }
}

function main() {
  const opts = parseArgs(process.argv);
  const url = opts.url;
  if (!url || url === true) {
    console.log(`Ingest a YouTube video for the B2E pipeline

Usage:
  node src/B2E/ingest.js --url <youtube url> [options]

Options:
  --url <url>        YouTube video URL (required)
  --quality <q>      best | 1080 | 720 | 480   (default 1080)
  --no-download      resolve metadata only, do not fetch media
  --force            re-download even if the file already exists
`);
    process.exit(0);
  }

  fs.mkdirSync(INPUT_YT_DIR, { recursive: true });
  checkVersion();

  // Resolve metadata first so we can name the file deterministically and report
  // what we are about to pull, rather than discovering it after a long download.
  const meta = runYtdlp(
    ["--no-warnings", "--print", "%(id)s\t%(title)s\t%(duration)s", url],
    "probe",
  );
  const line = (meta.stdout || "").trim().split("\n").pop() || "";
  const [id, title, duration] = line.split("\t");
  if (!id) fail(`could not resolve video id from: ${url}`);

  // Sanitise the title for Windows filenames: no <>:"/\|?*, no control chars,
  // and keep it short enough to stay under MAX_PATH once work dirs are appended.
  const safeTitle = (title || id)
    .replace(/[<>:"/\\|?*]/g, " ")
    .replace(/[\x00-\x1f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60)
    .replace(/[. ]+$/, "");
  const outFile = path.join(INPUT_YT_DIR, `${safeTitle || id}.mp4`);

  log(`id:       ${id}`);
  log(`title:    ${title}`);
  log(`duration: ${duration ? Number(duration).toFixed(2) : "?"}s`);
  log(`target:   ${outFile}`);

  if (opts["no-download"]) {
    log("metadata only (--no-download)");
    console.log(outFile);
    return;
  }

  if (fs.existsSync(outFile) && fs.statSync(outFile).size > 1024 && !opts.force) {
    log("already downloaded (use --force to re-download)");
    console.log(outFile);
    return;
  }

  const dl = [...qualityArgs(opts.quality), "--no-playlist", "--merge-output-format", "mp4"];
  // yt-dlp keeps an archive of completed downloads and will silently skip a URL it
  // has "already seen", even when the output file was deleted or is the wrong
  // resolution. Without this, re-ingesting at a higher --quality quietly reuses
  // the old 720p file and nothing changes.
  if (opts.force) dl.push("--force-overwrites", "--no-check-formats");
  dl.push("-o", outFile, url);

  runYtdlp(dl, "download");

  if (!fs.existsSync(outFile) || fs.statSync(outFile).size < 1024) {
    fail(`download reported success but no usable file at ${outFile}`);
  }

  // Verify what actually landed. yt-dlp can honour a previous download from its
  // archive and exit 0 without re-fetching, so a successful exit is not proof
  // that the requested quality was used.
  const dims = probeHeight(outFile);
  const want = opts.quality && opts.quality !== "best" ? Number(opts.quality) : null;
  if (dims && want && dims < want) {
    console.error(
      `[ingest] WARNING: requested ${want}p but the file is ${dims}p. ` +
        `The source may not offer that quality, or yt-dlp reused an earlier download.`,
    );
  }
  log(`downloaded ${(fs.statSync(outFile).size / 1024 / 1024).toFixed(1)} MB${dims ? ` (${dims}p)` : ""}`);

  // The path is the last stdout line so the caller can capture it.
  console.log(outFile);
}

main();
