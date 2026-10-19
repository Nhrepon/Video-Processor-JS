/**
 * cartoon_daily_pipeline.js
 * ─────────────────────────
 * Daily orchestrator for cartoonMornings reels:
 *   1. Generate 9:16 reels from ALL source MP4s in src/input/
 *   2. Build unique SEO captions for each new reel
 *   3. Schedule pending reels at peak viral hours (08:00, 12:30, 18:00)
 *
 * Run:  node src/scripts/cartoon_daily_pipeline.js
 *
 * The Windows Scheduled Task fires this once per day. It processes whatever
 * source MP4s are sitting in src/input/, generates 3 reels per source, then
 * moves the sources to src/input/processed/ so they are not re-processed.
 *
 * If the PC was offline for multiple days, ALL queued sources are processed
 * in one run. schedule_pending.py then spreads the reels across peak slots
 * (~3 per day) so the page gets consistent daily content.
 */
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const REPO = path.join(__dirname, "..", "..");
const INPUT_DIR = path.join(REPO, "src", "input");
const PROCESSED_DIR = path.join(INPUT_DIR, "processed");
const VIDEO_DIR = path.join(REPO, "src", "autopost", "video");
const LOG_PATH = path.join(REPO, "src", "autopost", "config", "daily-pipeline.log");
const CAPTIONS_PATH = path.join(REPO, "src", "autopost", "config", "captions.json");

const REELS_PER_SOURCE = 3; // 3 reels per source at peak hours

function log(line) {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  console.log(stamped);
  try {
    fs.appendFileSync(LOG_PATH, stamped + "\n");
  } catch {
    /* logging must never break the run */
  }
}

function run(cmd, args, opts = {}) {
  log(`> ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, {
    cwd: REPO,
    encoding: "utf-8",
    windowsHide: true,
    ...opts,
  });
  if (r.stdout) log(r.stdout.trim());
  if (r.stderr) log(`STDERR: ${r.stderr.trim()}`);
  return r;
}

function safeCopy(src, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const ext = path.extname(src);
  const safeName = `source-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}${ext}`;
  const dest = path.join(destDir, safeName);
  fs.copyFileSync(src, dest);
  return dest;
}

// A reel is caption-covered only if captions.json has an entry keyed by its
// exact filename. Any gap means the poster would fall back to the static
// fb.json caption — same title/desc on every post. Never schedule in that state.
function reelsMissingCaptions() {
  let manifest = {};
  try { manifest = JSON.parse(fs.readFileSync(CAPTIONS_PATH, "utf8")); } catch {}
  const reels = fs.existsSync(VIDEO_DIR)
    ? fs.readdirSync(VIDEO_DIR).filter((f) => /\.mp4$/i.test(f))
    : [];
  return reels.filter((f) => !manifest[f]);
}

function ensureCaptions() {
  const missing = reelsMissingCaptions();
  if (missing.length === 0) {
    log("captions.json covers all reels — skipping build_captions.");
    return true;
  }
  log(`${missing.length} reel(s) missing captions — running build_captions.py`);
  const caption = run("python", ["src/autopost/build_captions.py"]);
  if (caption.status !== 0) {
    log(`build_captions.py failed (exit ${caption.status}) — aborting.`);
    return false;
  }
  // Verify the rename+manifest pass actually closed the gap
  const stillMissing = reelsMissingCaptions();
  if (stillMissing.length > 0) {
    log(`still ${stillMissing.length} reel(s) without captions after build — aborting.`);
    return false;
  }
  return true;
}

function main() {
  log("=== cartoon_daily_pipeline start ===");

  // 1. Find source MP4s
  fs.mkdirSync(PROCESSED_DIR, { recursive: true });
  const sources = (fs.readdirSync(INPUT_DIR) || [])
    .filter((f) => /\.mp4$/i.test(f) && f !== "processed")
    .map((f) => path.join(INPUT_DIR, f))
    .sort();

  if (sources.length === 0) {
    // No new sources, but there might still be uncaptioned/unscheduled reels
    log("No new source MP4s in src/input/ — checking for uncaptioned reels...");
    if (!ensureCaptions()) process.exit(1);
    const schedule = run("python", [
      "src/autopost/schedule_pending.py",
      "--viral",
    ]);
    if (schedule.status !== 0 && schedule.status !== 2) {
      log(`schedule_pending.py failed (exit ${schedule.status}).`);
    }
    log("=== cartoon_daily_pipeline done (no new sources) ===");
    return;
  }

  log(`Found ${sources.length} source(s): ${sources.map(s => path.basename(s)).join(", ")}`);

  // 2. Generate reels — 3 reels per source (each part scans its own segment)
  //    Skip intro/outro (default: 60s start, 30s end) to avoid watermarks, title cards, credits
  //    Copy to safe temp names first to avoid emoji/special char path issues
  let totalGenerated = 0;
  const SAFE_TEMP_DIR = path.join(REPO, "src", "output", "tempSafeSources");
  fs.mkdirSync(SAFE_TEMP_DIR, { recursive: true });
  
  for (const src of sources) {
    log(`Generating ${REELS_PER_SOURCE} reels from ${path.basename(src)}`);
    const safeSrc = safeCopy(src, SAFE_TEMP_DIR);
    const gen = run("node", [
      "src/scripts/cartoonToReels.js",
      "--input", safeSrc,
      "--parts", String(REELS_PER_SOURCE),
      "--skip-start", "60",
      "--skip-end", "30",
    ]);
    if (gen.status !== 0) {
      log(`cartoonToReels.js failed for ${path.basename(src)} (exit ${gen.status}) — skipping.`);
    } else {
      totalGenerated += REELS_PER_SOURCE;
      // Move original to processed
      const dest = path.join(PROCESSED_DIR, path.basename(src));
      if (fs.existsSync(dest)) {
        const ext = path.extname(dest);
        const base = path.basename(dest, ext);
        fs.renameSync(src, path.join(PROCESSED_DIR, `${base}-${Date.now().toString(36)}${ext}`));
      } else {
        fs.renameSync(src, dest);
      }
      log(`Moved to processed: ${path.basename(src)}`);
    }
    // Clean up safe copy
    try { fs.unlinkSync(safeSrc); } catch {}
  }

  if (totalGenerated === 0) {
    log("No reels generated — aborting.");
    process.exit(1);
  }

  // 3. Build unique captions for any reel missing a manifest entry
  if (!ensureCaptions()) process.exit(1);

  // 4. Schedule pending reels at peak viral hours
  //    schedule_pending.py --viral spreads them across 08:00, 12:30, 18:00 slots
  const schedule = run("python", [
    "src/autopost/schedule_pending.py",
    "--viral",
  ]);
  if (schedule.status !== 0 && schedule.status !== 2) {
    // exit 2 = token expired (handled by schedule_pending itself)
    log(`schedule_pending.py failed (exit ${schedule.status}).`);
  }

  log(`=== cartoon_daily_pipeline done (${totalGenerated} reels from ${sources.length} sources) ===`);
}

main();
