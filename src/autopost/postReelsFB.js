const fs = require("fs");
const path = require("path");
const { loadConfig, postReel } = require("./fbReels");

// ---------------------------------------------------------------- SEO layer
// Facebook Reels SEO is caption-driven: the first line is the hook FB search
// indexes hardest, and the hashtag tail feeds topic clustering. A single
// static caption for every upload trains the algorithm to show the page to
// the same shrinking audience; rotation widens the keyword surface.
//
// Per-file unique captions live in config/captions.json (built by
// build_captions.py). Each entry maps the reel filename to a distinct
// { title, caption } so every upload gets a different name, title and hashtag
// set. The fallback pool below is only used for files with no manifest entry.

const CAPTIONS_MANIFEST_PATH = path.join(__dirname, "config", "captions.json");

function loadCaptionsManifest() {
  try {
    return JSON.parse(fs.readFileSync(CAPTIONS_MANIFEST_PATH, "utf8"));
  } catch {
    return {};
  }
}

const CAPTION_POOL = [
  "Tom is cooking up trouble again! \u26bd\ufe0f Which team are you on \u2014 Tom or Jerry? Drop your pick below! \U0001f5fa\ufe0f\n.\n.\n.\n#cartoonmornings #tomandjerry #classiccartoon #cartoon #funny #sports #football #soccer #cartoonfunny #nostalgia #90skids #cartoonlovers #reels #viral #fyp #foryou",
  "POV: Jerry steals the show AGAIN \U0001f602 Tag someone who always roots for the underdog!\n.\n.\n.\n#cartoonmornings #tomandjerry #funnycartoon #cartooncomedy #jerry #classics #retrocartoon #cartoonreels #nostalgiacartoon #funnyreels #comedy #viralreels #fyp #foryoupage",
  "The most legendary rivalry in cartoon history \U0001f3af Who wins this round? Comment your score prediction!\n.\n.\n.\n#cartoonmornings #tomandjerry #cartoonrivalry #bestcartoon #funnymoments #cartoonvideo #watchtillend #funnyvideo #trending #viralvideo #cartoonfans #reelsvideo #fyp #foryou",
  "Rate this chase 1-10 \U0001f4a5 Be honest \u2014 how many times have you seen THIS episode? \U0001f39f\ufe0f\n.\n.\n.\n#cartoonmornings #tomandjerry #classic #oldcartoons #goldenera #funnychase #epicmoments #funnyreels #reelsfacebook #trendingreels #explore #viral #fyp",
  "Wait for the plot twist at the end \U0001f9f5 You will NOT believe what Jerry does! Watch till the end!\n.\n.\n.\n#cartoonmornings #tomandjerry #plottwist #watchtilltheend #funnycartoon #cartoonclips #funnyvideo #cartoonreels #comedyreels #viralpost #trendingnow #explorepage #foryou #fyp",
  "When the game is on but the rivalry never stops \u26bd\ufe0f\U0001f3c6 Who's your MVP \u2014 Tom or Jerry? Vote in the comments!\n.\n.\n.\n#cartoonmornings #tomandjerry #sports #soccer #football #cartoonsports #funnymatch #cartoongoals #funnyreels #sportscartoon #reels #viral #trending #fyp #foryou",
  "Nobody: ... Tom at 3AM planning his next move \U0001f914\U0001f4a5 Sound on for this one! \U0001f50a\n.\n.\n.\n#cartoonmornings #tomandjerry #funnycartoon #memecartoon #relatable #cartoonmemes #funnyclips #tomandjerryfunny #soundon #comedygold #viralreels #funnyreels #fyp #foryoupage #explore",
  "Which one are you today? \U0001f914 Tom energy or Jerry energy? Be honest \U0001f602\n.\n.\n.\n#cartoonmornings #tomandjerry #relatable #funny #memes #cartoonrelatable #tomandjerrymemes #funnymoments #dailyreels #cartoonoftheday #funnyreels #viral #trending #fyp #foryou",
];

const HASHTAG_SEO_SETS = [
  ["#cartoonmornings", "#tomandjerry", "#funnycartoon", "#cartooncomedy", "#classiccartoon", "#nostalgiacartoon", "#funnyreels", "#viralreels", "#fyp", "#foryou"],
  ["#cartoonmornings", "#tomandjerry", "#cartoonrivalry", "#epicchase", "#funnymoments", "#watchtillend", "#cartoonreels", "#trendingreels", "#explorepage", "#viral"],
  ["#cartoonmornings", "#tomandjerry", "#cartoonvideo", "#sports", "#football", "#soccer", "#sportscartoon", "#funnymatch", "#reelsvideo", "#foryoupage"],
];

// Deterministic per-file pick: same file always gets the same caption across
// retries, but different files get different captions. Hashing the filename
// spreads variants across the library with zero extra state.
function captionForFile(file) {
  let hash = 0;
  for (const ch of file) {
    hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  }
  return CAPTION_POOL[hash % CAPTION_POOL.length];
}

// Per-file unique caption from captions.json (overrides static config.caption).
// Returns { caption, title } or null when the file has no manifest entry.
const CAPTIONS_MANIFEST = loadCaptionsManifest();
function captionFromManifest(file) {
  const entry = CAPTIONS_MANIFEST[file];
  if (entry && entry.caption) {
    return { caption: entry.caption, title: entry.title || "" };
  }
  return null;
}

// Random thumb offset - a mid-clip frame is a stronger CTR hook than frame 0
// (which is usually a fade-in or plain scene). Falls back to 0 if probe fails.
function randomThumbOffsetMs() {
  return Math.floor(Math.random() * 15000) + 2000; // 2s-17s
}

// ---------------------------------------------------------------- engine
// Reels live under src/output/partOutput/reelsFB, which is TWO levels up from
// this file's new home in src/autopost/ (project root -> src -> autopost).
const DEFAULT_REELS_DIR = path.join(__dirname, "..", "output/partOutput/reelsFB");
const STATE_PATH = path.join(__dirname, "config/reelsfb-state.json");
const LOG_PATH = path.join(__dirname, "config/reelsfb.log");

function dhaka(ts) {
  return new Date(ts * 1000).toLocaleString("en-GB", {
    timeZone: "Asia/Dhaka",
    hour12: false,
  });
}

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
  const scheduleMode = args.includes("--schedule");
  const countArg = args.find((arg) => !arg.startsWith("--"));

  // Dry run must still read the real blocklist so the gate preview is honest;
  // it only skips the credential requirement.
  const config = dryRun ? loadConfig({ requireToken: false }) : loadConfig();
  // Schedule mode bulk-handles the backlog, so it defaults to everything
  // eligible instead of maxPostsPerRun.
  const count =
    countArg === "all"
      ? Infinity
      : countArg
        ? Number(countArg)
        : scheduleMode
          ? Infinity
          : config.maxPostsPerRun || 1;
  if (Number.isNaN(count) || count <= 0) {
    throw new Error(
      "Usage: node src/autopost/postReelsFB.js [count|all] [--dry] [--publish] " +
        "[--schedule [--start=ISO|unix] [--gap-min=120] [--gap-max=180]]",
    );
  }

  // reelsDir in fb.json is repo-root-relative ("src/output/..."), so resolve
  // from TWO levels up: autopost -> src -> repo root.
  const reelsDir = config.reelsDir
    ? path.resolve(__dirname, "..", "..", config.reelsDir)
    : DEFAULT_REELS_DIR;
  // A scheduled reel becomes publicly visible once its time arrives, so the
  // copyright gate applies to it exactly as it does to an instant publish.
  const published = scheduleMode || forcePublish || config.autoPublish === true;
  const blocklist = config.copyrightBlocklist || [];

  const opt = (name) => {
    const hit = args.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.split("=").slice(1).join("=") : undefined;
  };
  const gapMinMin = Number(opt("gap-min")) || 120; // minutes between publishes
  const gapMaxMin = Number(opt("gap-max")) || 180;
  const startRaw = opt("start");
  const startTs = startRaw
    ? /^\d+$/.test(startRaw)
      ? Number(startRaw)
      : Math.floor(new Date(startRaw).getTime() / 1000)
    : Math.floor(Date.now() / 1000) + 60 * 60; // first publish ~1h from now

  const state = readState();
  const allReels = listReels(reelsDir);
  const candidates = allReels.filter(
    (file) => !state.posted[file] && !state.skipped[file],
  );

  log(`Reels ${allReels.length} total, ${candidates.length} eligible (dir ${reelsDir})`);
  const modeLabel = scheduleMode
    ? `SCHEDULED from ${new Date(startTs * 1000).toISOString()} (gaps ${gapMinMin}-${gapMaxMin}min)`
    : published
      ? "PUBLISHED"
      : "DRAFT";
  log(`Mode: ${modeLabel} | gate: ${blocklist.length} blocklist term(s)`);

  if (candidates.length === 0) {
    log("Nothing eligible.");
    return;
  }

  // Pre-shuffle once - O(count) vs repeated O(n) splice + indexOf.
  const queue = takeRandom(candidates, count);

  // Schedule mode: assign each queued reel a server-side publish time.
  // Default: first at startTs, then gapMin..gapMax minutes after the last.
  // --viral: snap each publish to the next high-engagement hour slot (Reels
  // peak windows) so posts land when the audience is actually active.
  const viralMode = args.includes("--viral");
  const schedule = new Map();
  if (scheduleMode) {
    if (viralMode) {
      // Peak engagement hours (local). One post per slot, walking forward in
      // time so no two reels compete for the same audience window.
      // 08:00, 12:30, 18:00, 20:00, 21:00 — morning, midday, prime evening.
      const PEAK_MINUTES = [8 * 60, 12 * 60 + 30, 18 * 60, 20 * 60, 21 * 60];
      const DAY_MS = 24 * 60 * 60 * 1000;
      const nextSlot = (fromMs) => {
        const base = new Date(fromMs);
        base.setSeconds(0, 0);
        for (let dayOffset = 0; dayOffset < 14; dayOffset++) {
          const dayStart = new Date(base);
          dayStart.setDate(dayStart.getDate() + dayOffset);
          dayStart.setHours(0, 0, 0, 0);
          for (const mins of PEAK_MINUTES) {
            const slot = new Date(dayStart.getTime() + mins * 60 * 1000);
            if (slot.getTime() >= fromMs) return slot;
          }
        }
        // Fallback: just advance a day.
        return new Date(fromMs + DAY_MS);
      };
      let slot = nextSlot(startTs * 1000);
      for (const file of queue) {
        schedule.set(file, Math.floor(slot.getTime() / 1000));
        // next slot must be strictly after this one (skip same/earlier slots)
        slot = nextSlot(slot.getTime() + 60 * 1000);
      }
    } else {
      let nextTs = startTs;
      for (const file of queue) {
        schedule.set(file, nextTs);
        nextTs += (gapMinMin + Math.random() * (gapMaxMin - gapMinMin)) * 60;
      }
    }
  }

  if (dryRun) {
    log("DRY RUN");
    const preview = scheduleMode
      ? queue
      : candidates.slice(0, Math.min(count, 10));
    preview.forEach((f) => {
      // Preview must mirror the real run: the blocklist only applies when
      // publishing publicly. Drafts bypass it.
      const gate = published ? checkCopyright(f, blocklist) : { ok: true };
      const when = schedule.has(f)
        ? ` -> ${new Date(schedule.get(f) * 1000).toISOString()} (${dhaka(schedule.get(f))})`
        : "";
      log(
        `  ${gate.ok ? "PASS" : "BLOCK"} ${f}${when}` +
          (gate.ok ? "" : ` - ${gate.reason}`),
      );
    });
    return;
  }

  let postedCount = 0;
  let blockedCount = 0;
  const failures = [];

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
      const manifestPick = captionFromManifest(file);
      const caption = manifestPick
        ? manifestPick.caption
        : (config.caption || captionForFile(file));
      const thumbOffsetMs = randomThumbOffsetMs();
      const schedTs = schedule.get(file);
      log(
        `Uploading ${file} (${schedTs ? `SCHEDULED ${new Date(schedTs * 1000).toISOString()}` : published ? "PUBLISHED" : "DRAFT"}) | ${manifestPick ? "manifest-unique" : "pool-variant #" + (CAPTION_POOL.indexOf(caption) + 1)} | thumb @${thumbOffsetMs}ms`,
      );
      const result = await postReel({
        videoPath: path.join(reelsDir, file),
        description: caption,
        published,
        thumbOffsetMs,
        scheduledPublishTime: schedTs,
        config,
      });
      state.posted[file] = {
        videoId: result.videoId,
        videoState: result.videoState,
        ...(schedTs
          ? { scheduledFor: new Date(schedTs * 1000).toISOString() }
          : {}),
        bytes: result.bytes,
        captionVariant: manifestPick ? "manifest-unique" : (CAPTION_POOL.indexOf(caption) + 1),
        title: manifestPick ? manifestPick.title : "",
        thumbOffsetMs,
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
