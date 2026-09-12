const fs = require("fs");
const path = require("path");
const { loadConfig, postReel } = require("./utility/fbReels");

const DEFAULT_REELS_DIR = path.join(__dirname, "output/partOutput/reelsFB");
const STATE_PATH = path.join(__dirname, "config/reelsfb-state.json");
const LOG_PATH = path.join(__dirname, "config/reelsfb.log");

function log(line) {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  console.log(stamped);
  try {
    fs.appendFileSync(LOG_PATH, stamped + "\n");
  } catch {
    /* logging must never break the run */
  }
}

function readState() {
  if (!fs.existsSync(STATE_PATH)) return { posted: {}, skipped: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    return { posted: parsed.posted || {}, skipped: parsed.skipped || {} };
  } catch {
    return { posted: {}, skipped: {} };
  }
}

function writeState(state) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function listReels(dir) {
  if (!fs.existsSync(dir)) throw new Error(`Reels dir not found: ${dir}`);
  return fs
    .readdirSync(dir)
    .filter((file) => path.extname(file).toLowerCase() === ".mp4")
    .sort();
}

function pickRandom(files) {
  return files[Math.floor(Math.random() * files.length)];
}

// Fisher-Yates partial shuffle - O(count) instead of O(n) splice per pick.
function takeRandom(items, count) {
  const copy = [...items];
  const n = Math.min(count, copy.length);
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(Math.random() * (copy.length - i));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

// Name-based gate only. It cannot see inside the video and it is NOT a
// copyright oracle - it just refuses to auto-publish anything whose filename
// names a studio or franchise on the blocklist. Facebook has no public
// pre-publish copyright check; Rights Manager only reports AFTER upload, by
// which point the post already exists on the page.
function normalize(text) {
  // "Tom-&-Jerry!" -> "tom jerry" so separators, case and punctuation cannot
  // smuggle a blocklisted term past a naive substring test.
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function checkCopyright(file, blocklist) {
  const haystack = normalize(file);
  const padded = ` ${haystack} `;
  for (const term of blocklist) {
    const needle = normalize(term);
    if (!needle) continue;
    if (padded.includes(` ${needle} `)) {
      return { ok: false, reason: `filename matches blocklist term "${term}"` };
    }
  }
  return { ok: true };
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry");
  const forcePublish = args.includes("--publish");
  const countArg = args.find((arg) => !arg.startsWith("--"));

  // Dry run must still read the real blocklist so the gate preview is honest;
  // it only skips the credential requirement.
  const config = dryRun ? loadConfig({ requireToken: false }) : loadConfig();
  const count = countArg === "all" ? Infinity : countArg ? Number(countArg) : config.maxPostsPerRun || 1;
  if (Number.isNaN(count) || count <= 0) {
    throw new Error("Usage: node src/postReelsFB.js [count|all] [--dry] [--publish]");
  }

  const reelsDir = config.reelsDir
    ? path.resolve(__dirname, "..", config.reelsDir)
    : DEFAULT_REELS_DIR;

  const published = forcePublish ? true : config.autoPublish === true;
  const blocklist = config.copyrightBlocklist || [];

  const state = readState();
  const allReels = listReels(reelsDir);
  const candidates = allReels.filter(
    (file) => !state.posted[file] && !state.skipped[file],
  );

  log(`Reels ${allReels.length} total, ${candidates.length} eligible (dir ${reelsDir})`);
  log(`Mode: ${published ? "PUBLISHED" : "DRAFT"} | gate: ${blocklist.length} blocklist term(s)`);

  if (candidates.length === 0) {
    log("Nothing eligible.");
    return;
  }

  if (dryRun) {
    log("DRY RUN");
    candidates.slice(0, Math.min(count, 10)).forEach((f) => {
      // Preview must mirror the real run: the blocklist only applies when
      // publishing publicly. Drafts bypass it.
      const gate = published ? checkCopyright(f, blocklist) : { ok: true };
      log(
        `  ${gate.ok ? "PASS" : "BLOCK"} ${f}` +
          (gate.ok ? "" : " - " + gate.reason),
      );
    });
    return;
  }

  let postedCount = 0;
  let blockedCount = 0;
  const failures = [];

  // Pre-shuffle once - O(count) vs repeated O(n) splice + indexOf.
  const queue = takeRandom(candidates, count);

  for (const file of queue) {
    // In DRAFT mode the gate is skipped on purpose: a draft is invisible to
    // the public, and manual review IS the copyright check. Running the
    // blocklist here would block every unposted file and no draft would ever
    // reach the page. The gate only governs public publishing.
    const gate = published ? checkCopyright(file, blocklist) : { ok: true };
    if (!gate.ok) {
      blockedCount += 1;
      state.skipped[file] = { reason: gate.reason, at: new Date().toISOString() };
      writeState(state);
      log(`SKIP ${file} - ${gate.reason}`);
      continue;
    }

    try {
      log(`Uploading ${file} (${published ? "PUBLISHED" : "DRAFT"}) ...`);
      const result = await postReel({
        videoPath: path.join(reelsDir, file),
        description: config.caption || "",
        published,
        config,
      });
      state.posted[file] = {
        videoId: result.videoId,
        videoState: result.videoState,
        bytes: result.bytes,
        at: new Date().toISOString(),
      };
      writeState(state);
      postedCount += 1;
      log(`OK ${file} -> video_id ${result.videoId} (${result.videoState})`);
    } catch (error) {
      failures.push({ file, error: error.message || String(error) });
      log(`FAIL ${file} - ${error.message || error}`);
    }
    if (postedCount >= count) break;
  }

  log(`Done. uploaded=${postedCount} blocked=${blockedCount} failed=${failures.length}`);
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  log(`FATAL ${error.message || error}`);
  process.exit(1);
});