/**
 * y2shorts — YouTube link → vertical Short.
 *
 * Pipeline:
 *   1. Download the YouTube URL (cached) via yt-dlp      -> download.js
 *   2. Render a 1080x1920 centre-cropped Short with a     -> render.js
 *      low-volume copyright-free music bed (from
 *      src/audio/youtube) and the video title on top.
 *
 * Usage:
 *   node src/y2shorts/y2shorts.js --url <youtube url> [options]
 *
 * Options:
 *   --url <url>        YouTube video URL (required)
 *   --title <text>     Override the on-video title (default: YouTube title)
 *   --no-title         Skip the title overlay entirely
 *   --duration <sec>   Trim output to at most N seconds
 *   --trim-start <sec> Seconds to skip at the start of the source (intro)
 *   --trim-end <sec>   Seconds to skip at the end of the source (outro)
 *   --quality <q>      best | 1080 | 720 | 480   (default 1080)
 *   --force            Re-download even if cached
 */
const fs = require("fs");
const path = require("path");
const { download } = require("./download");
const { renderShort, planShorts } = require("./render");
const { sanitizeFileName } = require("./text");

const ROOT = path.join(__dirname, "..", "..");
const CACHE_DIR = path.join(__dirname, "cache");
const OUTPUT_DIR = path.join(__dirname, "output");
const MUSIC_DIR = path.join(ROOT, "src", "audio", "youtube");
const FONT_PATH = path.join(ROOT, "src", "assets", "RacingSansOne-Regular.ttf");

function log(line) {
  console.log(`[y2shorts] ${line}`);
}

// Flags that never take a value. Without this, a following positional URL would
// be consumed as the flag's value (e.g. "--download-only <url>").
const BOOLEAN_FLAGS = new Set([
  "download-only",
  "no-render",
  "force",
  "no-title",
]);

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    // A bare (non-flag) token is treated as the YouTube URL, so both
    // "--url <url>" and a plain positional "<url>" work.
    if (!argv[i].startsWith("--")) {
      if (!out.url) out.url = argv[i];
      continue;
    }
    const key = argv[i].slice(2);
    const eq = key.indexOf("=");
    if (eq !== -1) {
      out[key.slice(0, eq)] = key.slice(eq + 1);
      continue;
    }
    if (BOOLEAN_FLAGS.has(key)) {
      out[key] = true;
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

function usage() {
  console.log(`y2shorts — turn a YouTube link into a vertical Short

Usage:
  npm run y2shorts -- --url <youtube url> [options]
  npm run y2shorts -- <youtube url>            (positional also works)
  node src/y2shorts/y2shorts.js --url <youtube url> [options]

Options:
  --url <url>        YouTube video URL (required)
  --title <text>     Override the on-video title (default: YouTube title)
  --no-title         Skip the title overlay entirely
  --duration <sec>   Trim output to at most N seconds
  --start <sec>      Start offset for a single-clip cut (default 0)
  --trim-start <sec> Seconds to skip at the start of the source (intro)
  --trim-end <sec>   Seconds to skip at the end of the source (outro)
  --quality <q>      best | 1080 | 720 | 480   (default 1080)
  --download-only    Download to cache and stop (no render)
  --force            Re-download even if cached

Notes:
  render.js feature.numberOfClips controls how many separate Shorts are
  produced (named <title>-short-1.mp4, -short-2.mp4, ... when > 1).
`);
}

async function main() {
  const opts = parseArgs(process.argv);
  const url = typeof opts.url === "string" ? opts.url : null;
  if (!url) {
    usage();
    process.exit(0);
  }

  if (!fs.existsSync(FONT_PATH)) {
    log(`WARNING: font not found at ${FONT_PATH}; title may not render`);
  }

  // 1. Download (cached).
  const media = download(url, CACHE_DIR, {
    quality: opts.quality,
    force: Boolean(opts.force),
  });

  // Download-only mode: stop here and hand back the cached file path. A later
  // render run reuses this cache instead of re-downloading.
  if (opts["download-only"] || opts["no-render"]) {
    log(`download only -> ${media.filePath}`);
    console.log(media.filePath);
    return;
  }

  // 2. Decide the on-video title.
  let title;
  if (opts["no-title"]) title = "";
  else if (typeof opts.title === "string") title = opts.title;
  else title = media.title || "";

  const duration = opts.duration ? Number(opts.duration) : undefined;
  const start = opts.start != null ? Number(opts.start) : undefined;
  const trimStart =
    opts["trim-start"] != null ? Number(opts["trim-start"]) : undefined;
  const trimEnd =
    opts["trim-end"] != null ? Number(opts["trim-end"]) : undefined;

  const safeName = sanitizeFileName(media.title || media.id, media.id);
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  // numberOfClips decides how many SEPARATE Shorts this source yields; each is
  // cut from its own slice of the source so they don't repeat footage.
  const sourceDuration = Number(media.duration);
  if (!Number.isFinite(sourceDuration) || sourceDuration <= 0) {
    throw new Error(`Could not determine source duration for ${media.filePath}`);
  }
  const plans = planShorts(sourceDuration, {
    duration,
    start,
    trimStart,
    trimEnd,
  });

  const outputs = [];
  for (let i = 0; i < plans.length; i += 1) {
    const suffix = plans.length > 1 ? `-short-${i + 1}` : "-short";
    const outputPath = path.join(OUTPUT_DIR, `${safeName}${suffix}.mp4`);
    log(`rendering Short ${i + 1}/${plans.length} -> ${outputPath}`);
    await renderShort({
      videoPath: media.filePath,
      outputPath,
      musicDir: MUSIC_DIR,
      fontPath: FONT_PATH,
      title,
      duration: plans[i].duration,
      start: plans[i].start,
    });
    outputs.push(outputPath);
  }

  log("done.");
  outputs.forEach((p) => console.log(p));
}

main().catch((err) => {
  console.error(`[y2shorts] ERROR: ${err.message}`);
  process.exit(1);
});
