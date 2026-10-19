/**
 * Movie clip processor — builds 1080x1080 square clips from full movies,
 * ready for Facebook page upload. Optimised like cartoon.js:
 *
 * - FAST cuts: trim + part cuts are stream-copy (c:v copy), so nothing is
 *   encoded twice — the filtergraph pass is the only encode (huge speedup
 *   on multi-GB movies, no generation loss)
 * - Trim applied ONCE to the whole source, before splitting (never per part)
 * - Part planner (planParts): exact --parts N, or auto-cover with random
 *   min..max lengths and optional randomStart sampling
 * - Short inputs are looped up to minInputSeconds before cutting
 * - Sanitized temp names ('#' and friends break ffmpeg commands)
 * - Per-part + per-input error isolation with cleanup in finally
 * - Run summary + log file in output/
 * - Resume manifests: inputs skipped by content fingerprint, parts resumable
 * - Output verification via ffprobe; ffmpeg retries with backoff
 * - Features toggles (text / logo / overlay / contentMod / voiceover)
 * - All tunables live in ONE `FEATURES` object; CLI only overrides
 *
 * Usage: node src/scripts/movie.js [options]   (npm run movie -- ...)
 */

const ffmpeg = require("fluent-ffmpeg");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");

// ============================================================
// FEATURES — single object with every tunable in this script.
// The CLI (parseArgs) only overrides the values it exposes;
// everything else is edited here and nowhere else.
// ============================================================
const FEATURES = {
  // Accepted file types
  fileTypes: {
    video: [".mp4", ".mov", ".mkv", ".webm", ".avi"],
    image: [".jpg", ".jpeg", ".png", ".webp"],
    audio: [".mp3", ".m4a", ".wav", ".aac", ".ogg"],
  },

  // FFmpeg binaries — installerFallback = @ffmpeg-installer packages
  ffmpeg: {
    primaryPath: "F:\\ffmpeg\\bin\\ffmpeg.exe",
    primaryProbe: "F:\\ffmpeg\\bin\\ffprobe.exe",
    useInstallerFallback: true,
  },

  // Part planning (cartoon.js style)
  parts: {
    count: 0, // 0 = auto-cover whole trimmed video; N = exactly N clips (CLI --parts)
    minDuration: 40, // part length range in seconds (CLI --min/--max)
    maxDuration: 100,
    minPartSeconds: 15, // shorter tail fragments fold into the previous part
    minInputSeconds: 30, // shorter inputs get looped up to this before cutting
    randomStart: true, // each part taken from a random frame inside its scope
    trimStart: 300, // applied ONCE to the source before splitting
    trimEnd: 300, // applied ONCE to the source before splitting
    cutVideoCopy: true, // stream-copy cuts (fast, lossless); false = re-encode cuts
    keyframeSnap: true, // copy-cuts snap to a keyframe so audio & video start together
    keyframeSearchWindow: 45, // seconds searched before the cut point for a keyframe
    cutCrf: "23", // used only when cutVideoCopy = false
    cutPreset: "fast",
    // Trim checkpoint: the once-trimmed copy is cached in output/movie/trimCache
    // keyed by source fingerprint + trim values, and reused across runs
    // (re-running the same movie never re-trims). Set false = old temp behavior.
    cacheTrim: true,
    // Delete the cached trim after ALL parts succeed (saves disk, costs a
    // re-trim on the next run of the same source)
    deleteTrimCacheAfterSuccess: false,
  },

  // Output canvas (Facebook page square post/reel: 1080x1080)
  output: { width: 1080, height: 1080, fps: 30 },

  // Encoding — CLI: --crf --preset --speed
  encode: {
    crf: "23", // FB re-compresses; 23 keeps detail without huge files
    preset: "fast",
    speedFactor: 1.06,
    quality: "vivid", // default grading preset: soft | standard | vivid
    minOutputBytes: 100000, // smaller output = failed encode
  },

  // Grading presets — CLI: --quality
  grades: {
    soft: "hue=s=0.48,eq=contrast=1.04:brightness=0.01:gamma=1.02:saturation=1.05",
    standard:
      "hue=s=0.48,eq=contrast=1.08:brightness=0.015:gamma=1.03:saturation=1.10,unsharp=5:5:1.0",
    vivid: "hue=s=0.48,eq=contrast=1.12:brightness=0.02:gamma=1.05:saturation=1.15,unsharp=7:7:1.5:5:5:0.8,eq=brightness=0.02:contrast=1.05:gamma=1.05",
  },

  // Background blur & motion treatment
  cropOriginalVideoHeight: true, // remove baked-in black bars: crop N px from source top & bottom before anything else
  cropOriginalVideoHeightPX: 40, // N per edge (total height loss = 2*N = 50px)
  showBlurSection: true,
  blurSectionHeight: 140, // blurred bg band height (top & bottom); main video fills the FULL window height H - 2*this, width follows source ratio
  blurSectionStrength: 2, // blur passes on the bands (boxblur power); radius = blur.strength * 2
  blur: { strength: 5, squareCropMinRatio: 1.25 }, // squareCropMinRatio: center-square crop for wide sources
  tmixWeights: "0.18|0.35|0.47", // temporal blend (anti-flicker)
  zoompan: { base: 1.03, swing: 0.02, period: 250 }, // slow breathing zoom

  // Own-footage / own-image watermark overlays (toggle + missing assets soft-skip)
  overlay: {
    enable: true,
    opacity: 0.05,
    durationSeconds: 1.5,
    minGapSeconds: 8,
    maxGapSeconds: 20,
  },

  // Audio mix — CLI: --no-audio (drops original audio + voiceover)
  audio: {
    sampleRate: 44100,
    bitrate: "192k",
    voicePitch: 0.97,
    originalVolume: 0.84,
    originalVolumeWithVoiceover: 0.84,
    bedVolume: 0.22,
    voiceoverVolume: 0.2,
    voiceover: true, // master switch for voiceover layer
    denoise: "afftdn=nr=25:nf=-45:tn=1",
    originalClean: "highpass=f=80,lowpass=f=8000,afftdn=nf=-20", // wider band + light denoise (keep dialogue body)
    // Keep the movie dialogue clearly audible:
    dialogueBoost: 1.25, // extra multiplier on original movie audio
    duck: true, // sidechain-duck bed music & voiceover while the movie speaks
    duckStrength: "threshold=0.03:ratio=8:attack=80:release=450:makeup=1", // sidechaincompress params
    bedVolumeSilentSource: 0.6, // bed loudness when the video itself has no audio
    amixNormalize: false, // false = amix keeps each layer's volume (no /N division)
    maxMixGain: 0.95, // alimiter ceiling (0..1) after mixing
  },

  // Periodic removal: drop dropSeconds of every (everySeconds) cycle
  contentMod: { enable: true, everySeconds: 10, dropSeconds: 1 },

  // Branding
  branding: {
    text: "Nhrepon.com", // "" = disable bottom watermark
    textEnable: true,
    fontFile: "RacingSansOne-Regular.ttf",
    fontSizeRatio: 0.04, // auto size = height * ratio; 0 = use fontSizeFixed
    fontSizeFixed: 0,
    fontSizeMin: 48,
    logoFile: "logo.png",
    logoEnable: true,
    logoWidth: 120,
    logoMargin: 10,
  },

  // Random attention-hook text shown in the TOP BLUR BAND, right beside the
  // logo (only renders when showBlurSection is on and a font is available)
  hookText: {
    enable: true,
    messages: [
      "Wait for it...",
      "Watch till the END!",
      "You Will NOT Believe This!",
      "Best scene in the movie",
      "Turn your SOUND ON",
      "This gets WILD",
      "Rewatch this 100x",
      "POV - Pure Cinema",
      "That scene THOUGH",
      "Save this for movie night",
    ],
    colors: ["yellow", "0x00E5FF", "0xFFD400", "0xFF3D3D", "white"],
    fontSizeRatio: 0.42, // of blur band height (min 20px)
    rotateSeconds: 0, // >0 = swap to a new random hook every N seconds
    logoGap: 18, // px between text and the logo
    // NOTE: avoid apostrophes/colons in messages — drawtext quoting cannot
    // render them inside single-quoted text; apostrophes are stripped below
  },

  fadeSeconds: 0.4, // intro/outro fade (video + audio); 0 disables

  // Robustness
  retry: { maxAttempts: 3, baseDelayMs: 2000 },
  verify: { minDurationRatio: 0.9, maxDurationRatio: 1.15 },

  // CLI: --limit default (Infinity = process every video found)
  defaultLimit: Infinity,
};

// ---------- ffmpeg binaries (validated in ensureFfmpeg) ----------
let ffmpegPath = FEATURES.ffmpeg.primaryPath;
let ffprobePath = FEATURES.ffmpeg.primaryProbe;

function ensureFfmpeg() {
  const exists = (p) => {
    try {
      return p && fs.existsSync(p);
    } catch {
      return false;
    }
  };
  if (FEATURES.ffmpeg.useInstallerFallback && (!exists(ffmpegPath) || !exists(ffprobePath))) {
    try {
      const installerFfmpeg = require("@ffmpeg-installer/ffmpeg").path;
      const installerFfprobe = require("@ffprobe-installer/ffprobe").path;
      if (exists(installerFfmpeg)) ffmpegPath = installerFfmpeg;
      if (exists(installerFfprobe)) ffprobePath = installerFfprobe;
    } catch {
      /* installer packages not available */
    }
  }
  if (!exists(ffmpegPath)) {
    throw new Error(
      `ffmpeg not found at "${ffmpegPath}" and no installer fallback available.`,
    );
  }
  ffmpeg.setFfmpegPath(ffmpegPath);
  ffmpeg.setFfprobePath(ffprobePath);
}

// ---------- CLI ----------
function parseArgs(argv) {
  const opts = {
    input: null, // dir OR single file (cartoon.js style)
    outputDir: null,
    limit: FEATURES.defaultLimit,
    parts: null, // overrides FEATURES.parts.count
    min: null, // overrides FEATURES.parts.minDuration
    max: null, // overrides FEATURES.parts.maxDuration
    randomStart: null, // overrides FEATURES.parts.randomStart (on|off)
    speed: null,
    crf: null,
    preset: null,
    quality: null, // grading preset: soft | standard | vivid
    keepInput: false,
    moveInput: false,
    dryRun: false,
    force: false,
    noAudio: false,
  };
  const VALUE_FLAGS = new Set([
    "--input", "--output", "--limit", "--parts", "--min", "--max", "--random-start",
    "--speed", "--crf", "--preset", "--quality",
  ]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--input": opts.input = next(); break;
      case "--output": opts.outputDir = next(); break;
      case "--limit": opts.limit = parseInt(next(), 10) || FEATURES.defaultLimit; break;
      case "--parts": opts.parts = Math.max(0, Math.min(60, Number(next()) || 0)); break;
      case "--min": opts.min = Number(next()); break;
      case "--max": opts.max = Number(next()); break;
      case "--random-start": opts.randomStart = String(next()).toLowerCase() !== "off"; break;
      case "--speed": opts.speed = parseFloat(next()); break;
      case "--crf": opts.crf = String(next()); break;
      case "--preset": opts.preset = next(); break;
      case "--quality": opts.quality = next(); break;
      case "--move-input": opts.moveInput = true; break;
      case "--keep-input": opts.keepInput = true; break;
      case "--dry-run": opts.dryRun = true; break;
      case "--force": opts.force = true; break;
      case "--no-audio": opts.noAudio = true; break;
      default:
        // Positional path = input file (first bare token that is not a flag value)
        if (!a.startsWith("--") && !VALUE_FLAGS.has(argv[i - 1]) && !opts.input) {
          opts.input = a;
        } else {
          console.warn(`Unknown option ignored: ${a}`);
        }
    }
  }
  return opts;
}

const OPTS = parseArgs(process.argv.slice(2));

// Apply CLI overrides into FEATURES so there is still ONE source of truth
if (OPTS.parts != null) FEATURES.parts.count = OPTS.parts;
if (OPTS.min != null && OPTS.min > 0) FEATURES.parts.minDuration = OPTS.min;
if (OPTS.max != null && OPTS.max > 0) FEATURES.parts.maxDuration = OPTS.max;
if (OPTS.randomStart != null) FEATURES.parts.randomStart = OPTS.randomStart;

// ---------- folders (relative to src/, script lives in src/scripts/) ----------
const srcDir = path.join(__dirname, "..");
// --input accepts either a single video file or a directory to scan
const inputIsFile =
  !!OPTS.input && fs.existsSync(OPTS.input) && fs.statSync(OPTS.input).isFile();
const inputTargetFile = inputIsFile ? path.resolve(OPTS.input) : null;
const inputDir =
  OPTS.input && !inputIsFile
    ? path.resolve(OPTS.input)
    : path.join(srcDir, "input");
const outputDir = OPTS.outputDir
  ? path.resolve(OPTS.outputDir)
  : path.join(srcDir, "output", "movie");
const assetsDir = path.join(srcDir, "assets");
const audioDir = path.join(srcDir, "audio");
const voiceOverDir = path.join(srcDir, "audio", "voiceOver");
const partDir = path.join(outputDir, "tempParts");
const trimCacheDir = path.join(outputDir, "trimCache");

// Unique per process so two runs never collide on temp or output names.
const RUN_ID = `${Date.now().toString(36)}-${process.pid}`;

// ---------- logging ----------
let logFilePath = null;
function ts() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}
function log(...args) {
  const line = `[${ts()}] ${args.join(" ")}`;
  console.log(line);
  if (logFilePath) {
    try {
      fs.appendFileSync(logFilePath, line + "\n");
    } catch {
      /* logging must never crash the run */
    }
  }
}
function warn(...args) {
  const line = `[${ts()}] WARN ${args.join(" ")}`;
  console.warn(line);
  if (logFilePath) {
    try {
      fs.appendFileSync(logFilePath, line + "\n");
    } catch {
      /* ignore */
    }
  }
}

// ---------- small helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randBetween = (min, max) => min + Math.random() * Math.max(0, max - min);

// Sanitize a filename for safe use as an ffmpeg input/output argument.
// Characters like '#' are interpreted by ffmpeg as protocol/segment markers and
// silently corrupt commands (e.g. a trimmed copy collapses to a few seconds).
function safeName(name) {
  return name
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function safeUnlink(file, label) {
  if (!file) return;
  try {
    fs.unlinkSync(file);
  } catch (e) {
    if (e.code !== "ENOENT") {
      warn(`could not remove ${label || "temp"} ${path.basename(file)}: ${e.message}`);
    }
  }
}

// ---------- manifests (fingerprint based, cheap: first+last 1MB) ----------
function fingerprintFile(filePath) {
  return new Promise((resolve, reject) => {
    const size = fs.statSync(filePath).size;
    const hash = crypto.createHash("sha256");
    const readRange = (start, length) =>
      new Promise((res, rej) => {
        const stream = fs.createReadStream(filePath, { start, end: start + length - 1 });
        stream.on("data", (d) => hash.update(d));
        stream.on("end", res);
        stream.on("error", rej);
      });
    (async () => {
      try {
        hash.update(String(size));
        await readRange(0, Math.min(1_000_000, size));
        if (size > 2_000_000) {
          await readRange(size - 1_000_000, 1_000_000);
        }
        resolve(hash.digest("hex").slice(0, 16));
      } catch (err) {
        reject(err);
      }
    })();
  });
}

function readManifest(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}
function writeManifest(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (err) {
    warn(`Could not write manifest ${file}: ${err.message}`);
  }
}

// ---------- ffprobe helpers ----------
function probeMedia(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err)
        return reject(
          new Error(`ffprobe failed for ${filePath}: ${err.message}`),
        );
      const dur =
        metadata && metadata.format && Number(metadata.format.duration);
      const vStream =
        (metadata && metadata.streams || []).find(
          (s) => s && s.codec_type === "video" && s.width,
        ) || null;
      const hasAudio =
        (metadata && metadata.streams || []).some(
          (s) => s && s.codec_type === "audio",
        );
      resolve({
        duration: Number.isFinite(dur) ? dur : null,
        width: vStream ? vStream.width : null,
        height: vStream ? vStream.height : null,
        hasAudio,
      });
    });
  });
}

async function getMediaDurationSafe(filePath) {
  try {
    const p = await probeMedia(filePath);
    return p.duration;
  } catch {
    return NaN;
  }
}

async function verifyOutput(outputVideo, expectedDuration) {
  const stats = fs.statSync(outputVideo);
  if (stats.size < FEATURES.encode.minOutputBytes) {
    throw new Error(
      `Output suspiciously small (${stats.size} bytes): ${outputVideo}`,
    );
  }
  const probe = await probeMedia(outputVideo);
  if (!probe.width) throw new Error(`Output has no video stream: ${outputVideo}`);
  if (probe.duration === null) {
    warn(`Could not read output duration for verification: ${outputVideo}`);
    return;
  }
  const minOk =
    expectedDuration * FEATURES.verify.minDurationRatio - 2; // contentMod drops frames; allow tolerance
  if (
    probe.duration < minOk ||
    probe.duration > expectedDuration * FEATURES.verify.maxDurationRatio
  ) {
    throw new Error(
      `Output duration ${probe.duration.toFixed(1)}s outside expected range (~${expectedDuration.toFixed(1)}s): ${outputVideo}`,
    );
  }
  log(
    `Verified output: ${probe.width}x${probe.height}, ${probe.duration.toFixed(1)}s, ${probe.hasAudio ? "audio ✓" : "silent ⚠"}`,
  );
}

// ---------- retry ----------
async function withRetry(label, fn) {
  const maxAttempts = FEATURES.retry.maxAttempts;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      warn(
        `${label} failed (attempt ${attempt}/${maxAttempts}): ${err.message}`,
      );
      if (attempt < maxAttempts)
        await sleep(FEATURES.retry.baseDelayMs * attempt);
    }
  }
  throw lastErr;
}

// ---------- grading presets (FEATURES.grades) ----------
function gradeFor(name) {
  const key = String(name || FEATURES.encode.quality).toLowerCase();
  return FEATURES.grades[key] || FEATURES.grades.standard;
}

// ---------- part planner (mirrors cartoon.js planParts) ----------
//   • Fixed-count mode (parts.count > 0): split the trimmed video into N equal
//     scopes and take ONE window per scope (random duration in min..max, random
//     start inside the scope when randomStart) — exactly N varied clips.
//   • Auto mode (parts.count <= 0): cover the video from 0 with random-length
//     parts in [min..max]; short tail fragments fold into the previous part.
function planParts(totalDuration, cfg) {
  const { partsCount, minDur, maxDur, minPartSeconds, randomStart } = cfg;
  const dur = Math.max(0, totalDuration);
  const lo = Math.max(1, Math.min(minDur, dur));
  const hi = Math.max(lo, Math.min(maxDur, dur));

  if (partsCount && partsCount > 0) {
    const n = Math.max(
      1,
      Math.min(partsCount, Math.floor(dur / Math.max(1, minPartSeconds)) || 1),
    );
    const scopeLen = dur / n;
    const segments = [];
    for (let i = 0; i < n; i++) {
      const scopeStart = scopeLen * i;
      const floor = Math.min(minPartSeconds, scopeLen);
      let segDur = Math.min(randBetween(lo, hi), scopeLen);
      if (segDur < floor) segDur = floor;
      let start = scopeStart;
      if (randomStart && scopeLen > segDur) {
        start = scopeStart + Math.random() * (scopeLen - segDur);
      }
      start = Math.max(0, Math.min(start, dur - segDur));
      segments.push({ start, duration: segDur });
    }
    return segments;
  }

  const segments = [];
  let start = 0;
  while (start < dur - 0.1) {
    const remaining = dur - start;
    if (segments.length > 0 && remaining < minPartSeconds) {
      segments[segments.length - 1].duration += remaining;
      break;
    }
    let segDur = Math.min(randBetween(lo, hi), remaining);
    if (segDur < Math.min(minPartSeconds, remaining))
      segDur = Math.min(minPartSeconds, remaining);
    segments.push({ start, duration: segDur });
    start += segDur;
  }
  return segments;
}

// Stream-copy cuts can only START video at a keyframe: with a plain -ss, the
// video snaps to the next keyframe while audio starts exactly at the seek
// point — that is where a constant A/V offset (usually 5–6s on movies) comes
// from. Probe the keyframe packet times and cut at the closest keyframe so
// both tracks begin at the same frame. Packet-level ffprobe = demux only, no
// decode, so it's milliseconds even on huge files.
function prevKeyframeOr(sourcePath, timeSeconds) {
  return new Promise((resolve) => {
    const windowSec = FEATURES.parts.keyframeSearchWindow || 45;
    const start = Math.max(0, timeSeconds - windowSec);
    const args = [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "packet=pts_time,flags",
      "-of", "csv",
      "-read_intervals", `${start.toFixed(3)}%+${(windowSec + 10).toFixed(3)}`,
      sourcePath,
    ];
    execFile(
      ffprobePath,
      args,
      { windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout) => {
        if (err || !stdout) return resolve(timeSeconds);
        const keys = [];
        for (const line of stdout.split("\n")) {
          // packet lines look like: 123.456,K__   ('K' flag = keyframe)
          const m = line.match(/^(-?[\d.]+),([^,\r]*)/);
          if (!m) continue;
          const t = parseFloat(m[1]);
          if (Number.isFinite(t) && m[2].includes("K")) keys.push(t);
        }
        if (keys.length === 0) return resolve(timeSeconds);
        // nearest keyframe at or before the requested start (keeps content
        // window intact); else the next one after it — still frame-locked
        let best = null;
        for (const t of keys) {
          if (t <= timeSeconds + 0.05 && (best === null || t > best)) best = t;
        }
        if (best === null) {
          for (const t of keys) {
            if (t > timeSeconds && (best === null || t < best)) best = t;
          }
        }
        resolve(best !== null ? Math.max(0, best) : timeSeconds);
      },
    );
  });
}

// ---------- fast cuts (stream copy, like cartoon.js) ----------
function copyCut({ sourcePath, outputPath, startSeconds = 0, durationSeconds = null, loop = false }) {
  return new Promise((resolve, reject) => {
    const cmd = ffmpeg().input(sourcePath);
    if (loop) cmd.inputOptions(["-stream_loop", "-1"]);
    if (startSeconds > 0) cmd.inputOptions(["-ss", String(startSeconds)]);
    const outOpts = ["-c", "copy", "-avoid_negative_ts", "make_zero"];
    if (durationSeconds != null) outOpts.push("-t", String(durationSeconds));
    cmd.outputOptions(outOpts).output(outputPath);
    cmd.on("end", () => resolve(outputPath));
    cmd.on("error", (err, stdout, stderr) => {
      if (stderr) log(`copyCut stderr tail: ${String(stderr).slice(-300)}`);
      reject(err);
    });
    cmd.run();
  });
}

// Re-encode cut fallback (frame-accurate) — only when parts.cutVideoCopy = false
function encodedCut({ sourcePath, startSeconds, durationSeconds, outputPath }) {
  return new Promise((resolve, reject) => {
    ffmpeg(sourcePath)
      .setStartTime(startSeconds)
      .duration(durationSeconds)
      .outputOptions([
        "-c:v", "libx264", "-preset", FEATURES.parts.cutPreset, "-crf", FEATURES.parts.cutCrf,
        "-c:a", "aac", "-b:a", FEATURES.audio.bitrate,
        "-movflags", "+faststart",
      ])
      .output(outputPath)
      .on("end", resolve)
      .on("error", (err, stdout, stderr) => {
        if (stderr) log(`cut stderr tail: ${String(stderr).slice(-300)}`);
        reject(err);
      })
      .run();
  });
}

const {
  getRandomNumber,
  getAudioFiles,
  fileSha256Hex,
  timemarkToSeconds,
  removeFile,
  atempoFilters,
  escapeDrawtext,
  buildOverlayPlan,
} = require("../utility/utility");

function addInput(command, asset, overlayDuration) {
  if (asset.label === "logo") {
    // Logo loops for the whole video; drawtext-style overlay stays visible
    command.input(asset.path).inputOptions(["-loop", "1"]);
  } else if (asset.type === "image") {
    // loop image but limit duration to avoid infinite streams
    command
      .input(asset.path)
      .inputOptions(["-loop", "1", "-t", String(overlayDuration + 2)]);
  } else if (asset.label === "voiceover" || asset.label === "audio") {
    command.input(asset.path).inputOptions(["-stream_loop", "-1"]);
  } else {
    command.input(asset.path);
  }
}

// ---------------------------------------------------------------- run
async function run() {
  ensureFfmpeg();
  log(`ffmpeg: ${ffmpegPath}`);

  fs.mkdirSync(outputDir, { recursive: true });
  logFilePath = path.join(
    outputDir,
    `movie-${new Date().toISOString().slice(0, 10)}.log`,
  );

  // Input resolution: single file (--input / positional) or scan inputDir
  let inputFiles;
  if (inputTargetFile) {
    inputFiles = [inputTargetFile];
  } else {
    if (!fs.existsSync(inputDir)) {
      throw new Error(`Input dir not found: ${inputDir}`);
    }
    const allFiles = fs.readdirSync(inputDir).map((f) => path.join(inputDir, f));
    inputFiles = allFiles.filter((f) =>
      FEATURES.fileTypes.video.includes(path.extname(f).toLowerCase()),
    );
    const junk = allFiles.length - inputFiles.length;
    if (junk > 0) warn(`Skipped ${junk} non-video file(s) in input dir`);
  }
  if (inputFiles.length === 0) {
    throw new Error(`No video files found (input: ${inputDir})`);
  }
  if (inputFiles.length > OPTS.limit) {
    log(`Limiting to first ${OPTS.limit} of ${inputFiles.length} videos`);
    inputFiles.length = OPTS.limit;
  }

  log(
    `movie — ${inputFiles.length} source(s) | parts/source: ${FEATURES.parts.count || "auto"} | ` +
      `part length ${FEATURES.parts.minDuration}–${FEATURES.parts.maxDuration}s | ` +
      `randomStart: ${FEATURES.parts.randomStart ? "on" : "off"} | ` +
      `trim ${FEATURES.parts.trimStart}s/${FEATURES.parts.trimEnd}s | cuts: ${FEATURES.parts.cutVideoCopy ? "stream-copy (fast)" : "re-encode"}`,
  );
  log(`Input:  ${inputTargetFile || inputDir}`);
  log(`Output: ${outputDir}`);

  if (OPTS.dryRun) {
    for (const f of inputFiles) {
      const probe = await probeMedia(f).catch(() => null);
      if (!probe || probe.duration === null) {
        log(`[dry-run] ${path.basename(f)} — unreadable duration`);
        continue;
      }
      const trim =
        probe.duration > FEATURES.parts.minInputSeconds
          ? Math.max(
              0,
              probe.duration -
                (probe.duration > 1200 ? FEATURES.parts.trimStart : 0) -
                (probe.duration > 1200 ? FEATURES.parts.trimEnd : 0),
            )
          : probe.duration;
      const segs = planParts(trim, {
        partsCount: FEATURES.parts.count,
        minDur: FEATURES.parts.minDuration,
        maxDur: FEATURES.parts.maxDuration,
        minPartSeconds: FEATURES.parts.minPartSeconds,
        randomStart: FEATURES.parts.randomStart,
      });
      log(
        `[dry-run] ${path.basename(f)} — ${(probe.duration / 60).toFixed(1)} min, ${probe.width}x${probe.height}, ${probe.hasAudio ? "audio" : "silent"} → ${segs.length} part(s) planned`,
      );
      segs.forEach((s, i) =>
        log(`   part ${String(i + 1).padStart(2, "0")}: @${s.start.toFixed(1)}s +${s.duration.toFixed(1)}s`),
      );
    }
    log("[dry-run] nothing processed.");
    return;
  }

  const manifestFile = path.join(outputDir, "movie-manifest.json");
  const manifest = OPTS.force ? {} : readManifest(manifestFile);
  if (OPTS.force) log("--force: reprocessing everything, manifest reset");

  const results = { ok: 0, failed: 0, skipped: 0, outputs: [] };

  for (const inputVideo of inputFiles) {
    const baseName = path.basename(inputVideo);
    try {
      const fp = await fingerprintFile(inputVideo);
      if (manifest[fp]) {
        warn(
          `Already processed (${baseName}) — last output: ${manifest[fp].output}. Use --force to reprocess.`,
        );
        results.skipped++;
        continue;
      }

      const duration = await getMediaDurationSafe(inputVideo);
      if (!Number.isFinite(duration) || duration <= 0) {
        throw new Error(`Could not determine duration for ${baseName}`);
      }
      log(`Duration of ${baseName}: ${duration.toFixed(0)}s`);

      const parts = await splitVideo({
        inputVideo,
        fingerprint: fp,
        tempPartsDir: partDir,
        processedOutputDir: outputDir,
        assetsDir,
        audioDir,
        voiceOverDir,
      });

      if (parts.length > 0) {
        manifest[fp] = {
          source: baseName,
          output: parts[parts.length - 1].output,
          parts: parts.length,
          duration: Math.round(duration),
          at: new Date().toISOString(),
        };
        writeManifest(manifestFile, manifest);
        results.outputs.push(...parts.map((p) => p.output));
        results.ok += parts.length;
      }
      log(`Finished ${baseName} — ${parts.length} clip(s)`);
      await archiveInput(inputVideo);
    } catch (err) {
      results.failed++;
      log(`FAILED ${baseName}: ${err && err.message ? err.message : err}`);
      if (err && err.stack) warn(err.stack.split("\n").slice(0, 3).join(" | "));
    }
  }

  writeManifest(manifestFile, manifest);
  log(
    `Run complete — clips: ${results.outputs.length}, inputs skipped: ${results.skipped}, failures: ${results.failed}`,
  );
  if (results.outputs.length) {
    log(`🎉 ${results.outputs.length} file(s) written to ${outputDir}`);
    results.outputs.forEach((o) => log(`  ${o}`));
  }
  if (results.outputs.length === 0 && results.skipped === 0) {
    process.exitCode = 1;
  }
}

// Move processed source out of the input folder so the next run picks fresh files.
async function archiveInput(inputVideo) {
  if (!OPTS.moveInput || OPTS.keepInput) return;
  const doneDir = path.join(inputDir, "done");
  fs.mkdirSync(doneDir, { recursive: true });
  const target = path.join(doneDir, path.basename(inputVideo));
  try {
    fs.renameSync(inputVideo, target);
    log(`Moved input to ${target}`);
  } catch (err) {
    warn(`Could not move input ${path.basename(inputVideo)}: ${err.message}`);
  }
}

// ------------------------------------------------- split orchestrator
async function splitVideo({
  inputVideo,
  fingerprint,
  tempPartsDir,
  processedOutputDir,
  assetsDir,
  audioDir,
  voiceOverDir,
}) {
  fs.mkdirSync(tempPartsDir, { recursive: true });
  fs.mkdirSync(processedOutputDir, { recursive: true });

  const cleanup = [];
  const registerCleanup = (file) => {
    if (file && !cleanup.includes(file)) cleanup.push(file);
  };

  let sourceVideo = inputVideo;
  let totalDuration = await getMediaDurationSafe(inputVideo);
  if (!Number.isFinite(totalDuration) || totalDuration <= 0) {
    throw new Error(`Could not determine duration for ${inputVideo}`);
  }

  // Sanitized base name for all temp artifacts — '#' and spaces in filenames
  // silently corrupt ffmpeg commands (a trimmed copy can collapse to seconds).
  const safeBase = safeName(path.parse(inputVideo).name);

  // Apply trimStart/trimEnd ONCE to the whole source (stream-copy = instant,
  // lossless), before splitting into parts. Trim only for long sources so a
  // short clip is not eaten alive by head/tail trims.
  // Checkpoint: when cacheTrim is on, the trimmed copy lives in trimCache/
  // keyed by content fingerprint + trim values — repeated runs reuse it
  // instead of trimming again. A cached copy is reused only if it probes
  // valid and close to the expected length; otherwise it is re-created.
  const longSource = totalDuration > 1200;
  const trimStart = longSource ? FEATURES.parts.trimStart || 0 : 0;
  const trimEnd = longSource ? FEATURES.parts.trimEnd || 0 : 0;
  let trimCachePath = null;
  if (trimStart > 0 || trimEnd > 0) {
    const expectedTrimmed = Math.max(1, totalDuration - trimStart - trimEnd);
    const useCache = FEATURES.parts.cacheTrim;
    trimCachePath = useCache
      ? path.join(
          trimCacheDir,
          `${safeBase}-${fingerprint}-trim-${trimStart}-${trimEnd}.mp4`,
        )
      : path.join(tempPartsDir, `${safeBase}-${RUN_ID}-trimmed.mp4`);

    let reused = false;
    if (useCache && fs.existsSync(trimCachePath)) {
      const cachedDur = await getMediaDurationSafe(trimCachePath);
      // stream-copy trim lands on keyframes: start may shift earlier by up to
      // the snap window, so accept lengths in [expected, expected + window]
      const snapAllowance =
        FEATURES.parts.cutVideoCopy && FEATURES.parts.keyframeSnap
          ? FEATURES.parts.keyframeSearchWindow + 6
          : 6;
      if (
        Number.isFinite(cachedDur) &&
        cachedDur >= expectedTrimmed - 2 &&
        cachedDur <= expectedTrimmed + snapAllowance
      ) {
        reused = true;
        log(
          `✂︎ Trim checkpoint hit: ${path.basename(trimCachePath)} (${cachedDur.toFixed(0)}s) — re-trim skipped`,
        );
      } else {
        warn(
          `Trim cache invalid (got ${cachedDur}s, expected ~${expectedTrimmed.toFixed(0)}s) — re-trimming`,
        );
        safeUnlink(trimCachePath, "stale trim cache");
      }
    }

    if (!reused) {
      log(
        `Trimming source once: -${trimStart}s head / -${trimEnd}s tail (stream copy)${useCache ? " → cached for future runs" : ""}`,
      );
      // Write under a unique name, then rename into the cache slot so a crash
      // mid-trim can never leave a half-written file that looks valid
      const writePath = useCache
        ? `${trimCachePath}.${RUN_ID}.partial.mp4`
        : trimCachePath;
      if (useCache) fs.mkdirSync(trimCacheDir, { recursive: true });
      // snap the trim start to a keyframe (copy cuts) so head audio & video align
      let cutStart = trimStart;
      if (FEATURES.parts.cutVideoCopy && FEATURES.parts.keyframeSnap) {
        cutStart = await prevKeyframeOr(inputVideo, trimStart);
        if (Math.abs(cutStart - trimStart) > 0.05) {
          log(`Trim start snapped to keyframe: ${trimStart}s → ${cutStart.toFixed(2)}s`);
        }
      }
      await withRetry("trim", () =>
        copyCut({
          sourcePath: inputVideo,
          outputPath: writePath,
          startSeconds: cutStart,
          durationSeconds: Math.max(1, totalDuration - cutStart - trimEnd),
        }),
      );
      if (useCache) {
        try {
          fs.renameSync(writePath, trimCachePath);
        } catch (err) {
          warn(`Could not move trim into cache (${err.message}) — using temp file`);
          trimCachePath = writePath; // still reuse for this run
          registerCleanup(writePath); // but not kept across runs
        }
      } else {
        registerCleanup(trimCachePath);
      }
    }

    sourceVideo = trimCachePath;
    totalDuration = await getMediaDurationSafe(sourceVideo);
  }

  // Loop short inputs up to the minimum so there is always enough to cut.
  if (totalDuration < FEATURES.parts.minInputSeconds) {
    const extendedPath = path.join(
      tempPartsDir,
      `${safeBase}-${RUN_ID}-extended.mp4`,
    );
    log(
      `Input ${totalDuration.toFixed(1)}s < ${FEATURES.parts.minInputSeconds}s — looping to minimum (stream copy)`,
    );
    await withRetry("extend", () =>
      copyCut({
        sourcePath: sourceVideo,
        outputPath: extendedPath,
        durationSeconds: FEATURES.parts.minInputSeconds,
        loop: true,
      }),
    );
    sourceVideo = extendedPath;
    registerCleanup(extendedPath);
    totalDuration = await getMediaDurationSafe(sourceVideo);
  }

  const segments = planParts(totalDuration, {
    partsCount: FEATURES.parts.count,
    minDur: FEATURES.parts.minDuration,
    maxDur: FEATURES.parts.maxDuration,
    minPartSeconds: FEATURES.parts.minPartSeconds,
    randomStart: FEATURES.parts.randomStart,
  });
  log(
    `  plan ${segments.length} part(s) from ${totalDuration.toFixed(0)}s trimmed source ` +
      `(parts=${FEATURES.parts.count || "auto"}, len ${FEATURES.parts.minDuration}–${FEATURES.parts.maxDuration}s)`,
  );

  // per-source part manifest so an interrupted run resumes where it stopped
  const partsManifestFile = path.join(
    processedOutputDir,
    `movie-parts-${fingerprint}.json`,
  );
  const partsManifest = OPTS.force ? {} : readManifest(partsManifestFile);

  const processedFiles = [];
  const failures = [];
  // log the requested start; the actual copy-cut start snaps to a keyframe
  // (prevKeyframeOr) right after this line runs
  const cutStartNote = (segment) =>
    `${segment.start.toFixed(1)}${
      FEATURES.parts.cutVideoCopy && FEATURES.parts.keyframeSnap ? "→key" : ""
    }`;

  try {
    for (const [index, segment] of segments.entries()) {
      const partNumber = String(index + 1).padStart(2, "0");
      const key = `part-${partNumber}`;

      // Resume: previously completed part — skip cutting & processing
      if (
        partsManifest[key] &&
        fs.existsSync(partsManifest[key].output)
      ) {
        log(
          `Part ${index + 1}/${segments.length}: resume — already done (${path.basename(partsManifest[key].output)})`,
        );
        processedFiles.push(partsManifest[key]);
        continue;
      }

      const splitPartPath = path.join(
        tempPartsDir,
        `${safeBase}-${RUN_ID}-part-${partNumber}.mp4`,
      );
      log(
        `Splitting part ${index + 1}/${segments.length}: @${cutStartNote(segment)}s +${segment.duration.toFixed(1)}s (${FEATURES.parts.cutVideoCopy ? "copy" : "re-encode"})`,
      );
      try {
        // frame-lock the cut point to a keyframe when stream-copying
        let cutStart = segment.start;
        if (FEATURES.parts.cutVideoCopy && FEATURES.parts.keyframeSnap) {
          cutStart = await prevKeyframeOr(sourceVideo, segment.start);
        }
        await withRetry(`cut part ${partNumber}`, () =>
          FEATURES.parts.cutVideoCopy
            ? copyCut({
                sourcePath: sourceVideo,
                outputPath: splitPartPath,
                startSeconds: cutStart,
                durationSeconds: segment.duration,
              })
            : encodedCut({
                sourcePath: sourceVideo,
                startSeconds: cutStart,
                durationSeconds: segment.duration,
                outputPath: splitPartPath,
              }),
        );
        registerCleanup(splitPartPath);

        const processedOutput = await videoProcessor({
          videoPath: splitPartPath,
          outputDir: processedOutputDir,
          assetsDir,
          audioDir,
          voiceOverDir,
        });
        const entry = { output: processedOutput, start: segment.start, duration: segment.duration };
        processedFiles.push(entry);
        partsManifest[key] = entry;
        writeManifest(partsManifestFile, partsManifest);
      } catch (error) {
        // One bad part must not take the whole batch down.
        log(
          `Part ${index + 1}/${segments.length} failed: ${error.message || error}`,
        );
        failures.push({ part: index + 1, error: error.message || String(error) });
        safeUnlink(splitPartPath, "failed part");
      } finally {
        // Free disk as we go — temp parts of a movie add up to GBs
        safeUnlink(splitPartPath, "temp part");
      }
    }
  } finally {
    for (const file of cleanup) safeUnlink(file);
  }

  if (failures.length > 0) {
    warn(
      `${failures.length}/${segments.length} part(s) failed: ` +
        failures.map((f) => `#${f.part}`).join(", "),
    );
  }

  // Optional: free the trim cache once everything succeeded (next run of the
  // same source would then re-trim once)
  if (
    trimCachePath &&
    FEATURES.parts.cacheTrim &&
    FEATURES.parts.deleteTrimCacheAfterSuccess &&
    failures.length === 0 &&
    processedFiles.length > 0 &&
    trimCachePath.startsWith(trimCacheDir)
  ) {
    safeUnlink(trimCachePath, "trim cache");
    log("Trim cache removed (deleteTrimCacheAfterSuccess=true)");
  }

  return processedFiles;
}

// ---------------------------------------------------- per-part processing
async function videoProcessor({
  videoPath,
  outputDir,
  assetsDir,
  audioDir,
  voiceOverDir,
}) {
  // ---- tunables: every value comes from the single FEATURES object ----
  const OUT_W = FEATURES.output.width;   // 1080x1080 square for FB page
  const OUT_H = FEATURES.output.height;
  const OUT_FPS = FEATURES.output.fps;
  const HALF_WIDTH = Math.floor(OUT_W / 2);
  const HALF_HEIGHT = Math.floor(OUT_H / 2);
  const SPEED_FACTOR =
    OPTS.speed && OPTS.speed > 0.5 && OPTS.speed <= 4
      ? OPTS.speed
      : FEATURES.encode.speedFactor;
  const X264_PRESET = OPTS.preset || FEATURES.encode.preset;
  const CRF = OPTS.crf || FEATURES.encode.crf;
  const OVERLAY_OPACITY = FEATURES.overlay.opacity;
  const OVERLAY_DURATION = FEATURES.overlay.durationSeconds;
  const OVERLAY_MIN_GAP = FEATURES.overlay.minGapSeconds;
  const OVERLAY_MAX_GAP = FEATURES.overlay.maxGapSeconds;
  const BLUR_STRENGTH = FEATURES.blur.strength;
  const SQUARE_CROP_MIN_RATIO = FEATURES.blur.squareCropMinRatio;
  const VOICE_PITCH = FEATURES.audio.voicePitch;
  const ORIGINAL_AUDIO_VOLUME = FEATURES.audio.originalVolume;
  const BED_AUDIO_VOLUME = FEATURES.audio.bedVolume;
  const VOICEOVER_VOLUME = FEATURES.audio.voiceoverVolume;
  const SAMPLE_RATE = FEATURES.audio.sampleRate;
  const FADE_SECONDS = FEATURES.fadeSeconds;

  const showOverlay = FEATURES.overlay.enable;
  const showBottomText = FEATURES.branding.textEnable && Boolean(FEATURES.branding.text);
  const showLogoFeature = FEATURES.branding.logoEnable;
  const showVoiceover = FEATURES.audio.voiceover && !OPTS.noAudio;
  const brandText = escapeDrawtext(FEATURES.branding.text);
  const gradeFilter = gradeFor(OPTS.quality || FEATURES.encode.quality);

  const fileName = path.basename(videoPath);
  const fileExt = path.extname(fileName);
  const fileBaseName = path.basename(fileName, fileExt);
  const assetPath = (f) => path.join(assetsDir, f);
  const fontPath = assetPath(FEATURES.branding.fontFile);
  const drawtextFont = fontPath.replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:");
  const logoPath = assetPath(FEATURES.branding.logoFile);
  const fontSize =
    FEATURES.branding.fontSizeFixed > 0
      ? FEATURES.branding.fontSizeFixed
      : Math.max(
          FEATURES.branding.fontSizeMin,
          Math.round(OUT_H * FEATURES.branding.fontSizeRatio),
        );

  function getOverlayAssets() {
    if (!showOverlay || !fs.existsSync(assetsDir)) return [];
    const files = fs.readdirSync(assetsDir);
    const videoAssets = files
      .filter((f) => /^own-footage\./i.test(f))
      .filter((f) => FEATURES.fileTypes.video.includes(path.extname(f).toLowerCase()))
      .map((f) => ({ path: assetPath(f), type: "video", name: f }));

    if (videoAssets.length > 0) return videoAssets;

    const imageAssets = files
      .filter((f) => /^own-image\./i.test(f))
      .filter((f) => FEATURES.fileTypes.image.includes(path.extname(f).toLowerCase()))
      .map((f) => ({
        path: assetPath(f),
        type: "image",
        name: f,
        label: `overlay_${f}`,
      }));

    return imageAssets;
  }

  async function processVideo() {
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.mkdirSync(outputDir, { recursive: true });

    const inputVideo = videoPath;
    // Bed audio optional (cartoon.js style): graceful skip when absent
    const audioFiles = getAudioFiles(audioDir);
    const extraAudio =
      audioFiles.length > 0
        ? audioFiles[getRandomNumber(0, audioFiles.length - 1)]
        : null;
    const hasBed = !!extraAudio && fs.existsSync(extraAudio);

    const voiceFiles = showVoiceover ? getAudioFiles(voiceOverDir) : [];
    const voiceOver =
      voiceFiles.length > 0
        ? voiceFiles[getRandomNumber(0, voiceFiles.length - 1)]
        : null;

    const overlayAssets = getOverlayAssets();
    if (showOverlay && overlayAssets.length === 0) {
      log("  (overlay enabled but no own-footage.*/own-image.* found — skipping)");
    }

    const hasFont = fs.existsSync(fontPath);
    const hasLogo = showLogoFeature && fs.existsSync(logoPath);

    const randomId = Math.floor(Math.random() * 999) + 1;
    const outputFileName =
      `${fileBaseName}`
        .trim()
        .replace(/\s+/g, "-")
        .replace(/[^a-zA-Z0-9-]/g, "-")
        .replace(/-+/g, "-")
        .toLowerCase() + `-${randomId}-by-nhrepon.mp4`;

    const outputVideo = path.join(outputDir, outputFileName);

    if (!fs.existsSync(inputVideo))
      throw new Error(`input video not found at ${inputVideo}`);

    const meta = await probeMedia(inputVideo);
    if (meta.duration === null) {
      throw new Error(`Could not determine duration of ${inputVideo}`);
    }
    const mainOrigDur = meta.duration;
    const hasAudio = meta.hasAudio && !OPTS.noAudio;
    const mainDuration = mainOrigDur / SPEED_FACTOR;
    // Length after periodic removal (drop N of every M seconds shrinks the
    // timeline); audio gets the same aselect windows dropped to stay in sync
    const cmDrop = FEATURES.contentMod.dropSeconds;
    const cmEvery = FEATURES.contentMod.everySeconds;
    const finalDuration = FEATURES.contentMod.enable
      ? mainDuration * (1 - cmDrop / cmEvery)
      : mainDuration;

    log(
      `🎬 Processing ${fileName} -> ${outputFileName} (${mainDuration.toFixed(1)}s, bed ${hasBed ? "on" : "off"}, voiceover ${voiceOver ? path.basename(voiceOver) : "off"}, logo ${hasLogo ? "on" : "off"}, text ${showBottomText && hasFont ? "on" : "off"})`,
    );

    // Upscale warning: source narrower than output
    if (meta.width && meta.width < OUT_W) {
      warn(
        `Source is only ${meta.width}x${meta.height}px — will be upscaled to ${OUT_W}x${OUT_H}, expect softness`,
      );
    }

    // Black-bar removal (FEATURES.cropOriginalVideoHeight): some rips ship
    // hardcoded letterbox bars — cut N px from the source top & bottom BEFORE
    // split/blur/zoompan so every branch (and the AR math) sees clean picture
    const blackBarPx = FEATURES.cropOriginalVideoHeight
      ? Math.max(0, Math.floor(FEATURES.cropOriginalVideoHeightPX) || 0)
      : 0;
    const effH = meta.height ? Math.max(16, meta.height - blackBarPx * 2) : 0;
    if (blackBarPx > 0) {
      log(
        `Black-bar crop: -${blackBarPx}px top & bottom of source (${meta.height} → ${effH}px tall)`,
      );
    }

    // Blur sections (FEATURES.showBlurSection): full-width letterbox — the
    // sharp picture spans the ENTIRE output width (no blurred pillars on the
    // sides), sized by the source aspect ratio and clamped to the window
    // between the bands; the bands/gaps show heavily blurred video bg.
    const bandH =
      FEATURES.showBlurSection && FEATURES.blurSectionHeight > 0
        ? Math.max(
            2,
            Math.min(
              Math.floor(FEATURES.blurSectionHeight),
              Math.floor(OUT_H / 2 - 4), // keep at least 8px for the video
            ),
          )
        : 0;
    const contentH = OUT_H - bandH * 2; // sharp video window between bands

    // Content-aware square crop: for wide movie sources, keep the center
    // square instead of shrinking the whole frame into blurred pillars.
    // Skipped in band mode — the letterbox chain uses the full width.
    let squareCrop = "";
    if (
      bandH === 0 &&
      meta.width &&
      effH &&
      meta.width / effH >= SQUARE_CROP_MIN_RATIO
    ) {
      squareCrop = `crop='min(iw,ih)':'min(iw,ih)':(iw-ow)/2:0,scale=${OUT_W}:${OUT_H}:flags=lanczos,`;
      log(
        `Wide source ${meta.width}x${meta.height} → center square crop for bigger picture`,
      );
    }

    const overlays =
      overlayAssets.length > 0
        ? buildOverlayPlan(
            mainDuration,
            overlayAssets.length,
            OVERLAY_DURATION,
            OVERLAY_MIN_GAP,
            OVERLAY_MAX_GAP,
          )
        : [];

    log(`Inserting ${overlays.length} random overlay segment(s)`);

    // Inputs: [0]=main, [1]=bed audio (if any), voiceover (if any), overlays, logo
    const inputs = [{ path: inputVideo, type: "video", label: "main" }];
    if (hasBed) inputs.push({ path: extraAudio, type: "audio", label: "audio" });
    if (voiceOver) inputs.push({ path: voiceOver, type: "audio", label: "voiceover" });
    inputs.push(
      ...overlayAssets.map((a, i) => ({
        ...a,
        label: a.label || `overlay_${i}`,
      })),
    );
    if (hasLogo) inputs.push({ path: logoPath, type: "image", label: "logo" });

    const inputIndex = (label) => {
      const index = inputs.findIndex((inp) => inp.label === label);
      if (index < 0) throw new Error(`Missing ffmpeg input: ${label}`);
      return index;
    };
    const overlayBaseIdx = hasBed ? (voiceOver ? 3 : 2) : voiceOver ? 2 : 1;

    const command = ffmpeg();
    inputs.forEach((inp) => addInput(command, inp, OVERLAY_DURATION));

    const fc = [];

    // zoompan ignores input PTS and re-stamps every output frame from its own
    // counter at fps=${OUT_FPS} spacing — on a 24fps source that silently
    // compresses the picture by fps-ratio (24/30 = 20%) and the video races
    // ahead of the audio. Converting to CFR at OUT_FPS BEFORE the split makes
    // zoompan's regenerated timestamps identical to the input timeline.
    const barCrop =
      blackBarPx > 0
        ? `crop=iw:'max(ih-${blackBarPx * 2},16)':0:${blackBarPx},`
        : "";
    fc.push(`[0:v]fps=${OUT_FPS},${barCrop}split=2[mainA][mainB]`);

    if (bandH > 0) {
      // — full-width letterbox chain —
      // blurred background covering the whole canvas (shows through the bands)
      fc.push(
        `[mainA]scale=${HALF_WIDTH}:${HALF_HEIGHT}:force_original_aspect_ratio=increase,crop=${HALF_WIDTH}:${HALF_HEIGHT},boxblur=${BLUR_STRENGTH},scale=${OUT_W}:${OUT_H},${gradeFilter}[mainbg]`,
      );
      // sharp foreground: takes the FULL window height (contentH), width
      // follows the source aspect ratio; rendered +2px because zoompan needs
      // even dimensions, then scaled to exact height and center-cropped to
      // canvas width when the proportional width overflows 1080
      const srcAR =
        meta.width && effH ? meta.width / effH : 16 / 9;
      const fgH = Math.max(8, Math.floor(contentH / 2) * 2); // even, = window height
      const rH = fgH + 2;
      const rW = Math.max(2, Math.floor((rH * srcAR) / 2) * 2); // natural width at full height
      fc.push(
        `[mainB]hflip,tmix=frames=3:weights='${FEATURES.tmixWeights}',scale=${rW * 1.5}:${rH * 1.5}:force_original_aspect_ratio=increase,zoompan=z='${FEATURES.zoompan.base}+${FEATURES.zoompan.swing}*sin(2*PI*in/${FEATURES.zoompan.period})':x='(iw-ow)/2':y='(ih-oh)/2':d=1:fps=${OUT_FPS}:s=${rW}x${rH},${gradeFilter},scale=-2:${fgH},crop='min(iw,${OUT_W})':${fgH}:(iw-ow)/2:0,setsar=1[mainfg]`,
      );
      // center it in the window (x centers when narrower than canvas; y between bands)
      fc.push(
        `[mainbg][mainfg]overlay=(W-w)/2:${bandH}+(${contentH}-h)/2[mainbase_orig]`,
      );
      fc.push(`[mainbase_orig]setpts=PTS/${SPEED_FACTOR}[mainbase]`);
      log(
        `Blur sections: video full window height ${fgH}px (src width ratio ${rW}px, cropped to <=${OUT_W}), ${bandH}px blurred bg bands top & bottom`,
      );
    } else {
      // — square chain: blurred background + center square crop foreground —
      fc.push(
        `[mainA]${squareCrop}scale=${HALF_WIDTH}:${HALF_HEIGHT}:force_original_aspect_ratio=increase,crop=${HALF_WIDTH}:${HALF_HEIGHT},boxblur=${BLUR_STRENGTH},scale=${OUT_W}:${OUT_H},${gradeFilter}[mainbg]`,
      );
      // zoompan needs even dimensions, so render at +2 then scale down to exact output
      fc.push(
        `[mainB]${squareCrop}hflip,tmix=frames=3:weights='${FEATURES.tmixWeights}',scale=${(OUT_W + 2) * 1.5}:${(OUT_H + 2) * 1.5}:force_original_aspect_ratio=increase,zoompan=z='${FEATURES.zoompan.base}+${FEATURES.zoompan.swing}*sin(2*PI*in/${FEATURES.zoompan.period})':x='(iw-ow)/2':y='(ih-oh)/2':d=1:fps=${OUT_FPS}:s=${OUT_W + 2}x${OUT_H + 2},${gradeFilter},scale=${OUT_W}:${OUT_H}[mainfg]`,
      );
      fc.push(`[mainbg][mainfg]overlay=(W-w)/2:(H-h)/2[mainbase_orig]`);
      fc.push(`[mainbase_orig]setpts=PTS/${SPEED_FACTOR}[mainbase]`);
    }
    let currentMainLabel = "[mainbase]";
    overlays.forEach((ov, idx) => {
      const overallInputIndex = overlayBaseIdx + ov.assetIndex;
      const overlayLabel = `[ov${idx}]`;
      fc.push(
        `[${overallInputIndex}:v]scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=increase,crop=${OUT_W}:${OUT_H},format=rgba,colorchannelmixer=aa=${OVERLAY_OPACITY}${overlayLabel}`,
      );
      const outLabel = `[mlayer${idx}]`;
      fc.push(
        `${currentMainLabel}${overlayLabel}overlay=0:0:enable='between(t,${ov.start},${ov.end})'${outLabel}`,
      );
      currentMainLabel = outLabel;
    });

    // branding text + fades (drawtext keeps SAR normalized)
    const tailFilters = [];
    if (showBottomText && hasFont) {
      tailFilters.push(
        `drawtext=text='${brandText}':fontfile='${drawtextFont}':fontcolor=white:fontsize=${fontSize}:borderw=2:bordercolor=black:x=(w-text_w)/2:y=h-text_h-10:fix_bounds=true:enable='gte(t,0)'`,
      );
    }
    // random hook text in the top blur band, vertically centered in the band
    // and LEFT-aligned at the band's left edge (logo stays pinned top-right)
    const hookMsgs = FEATURES.hookText.messages || [];
    if (FEATURES.hookText.enable && bandH > 0 && hasFont && hookMsgs.length) {
      const hookSize = Math.max(
        20,
        Math.floor(bandH * (FEATURES.hookText.fontSizeRatio || 0.42)),
      );
      // left margin: logo gap only matters as a minimum breathing room; the
      // hook starts at the band's left edge so it reads first (LTR scanning)
      const hookXPad = Math.max(
        FEATURES.branding.logoMargin,
        FEATURES.hookText.logoGap || 18,
      );
      const rotate =
        FEATURES.hookText.rotateSeconds > 0
          ? FEATURES.hookText.rotateSeconds
          : 0;
      const segments = [];
      if (rotate > 0) {
        for (let st = 0; st < mainDuration; st += rotate) {
          segments.push([st, Math.min(st + rotate, mainDuration)]);
        }
      } else {
        segments.push([0, mainDuration]);
      }
      const seen = [];
      for (const [st, en] of segments) {
        // random message per segment; avoid repeats while options remain
        const fresh = hookMsgs.map((_, i) => i).filter((i) => !seen.includes(i));
        const pool = fresh.length ? fresh : hookMsgs.map((_, i) => i);
        const pick = pool[getRandomNumber(0, pool.length - 1)];
        seen.push(pick);
        const hookColor =
          FEATURES.hookText.colors[
            getRandomNumber(0, FEATURES.hookText.colors.length - 1)
          ] || "yellow";
        const hookText = escapeDrawtext(
          // strip quote-breaking chars the drawtext parser can't handle
          // inside single-quoted values (apostrophes, curly quotes, colons)
          String(hookMsgs[pick]).replace(/['’‘:]/g, ""),
        );
        const enablePart =
          rotate > 0
            ? `:enable='between(t,${st.toFixed(2)},${en.toFixed(2)})'`
            : "";
        tailFilters.push(
          `drawtext=text='${hookText}':fontfile='${drawtextFont}':fontcolor=${hookColor}:fontsize=${hookSize}:borderw=3:bordercolor=black@0.85:shadowx=2:shadowy=2:shadowcolor=black@0.5:x=${hookXPad}:y=(${bandH}-text_h)/2${enablePart}`,
        );
        if (st === 0) {
          log(
            `Hook text: "${hookMsgs[pick]}" in top blur band (${segments.length} segment(s))`,
          );
        }
      }
    }
    if (FADE_SECONDS > 0) {
      tailFilters.push(`fade=t=in:st=0:d=${FADE_SECONDS}`);
      tailFilters.push(
        `fade=t=out:st=${Math.max(0, mainDuration - FADE_SECONDS).toFixed(3)}:d=${FADE_SECONDS}`,
      );
    }
    if (tailFilters.length) {
      const outLabel = `[maintail]`;
      fc.push(`${currentMainLabel}${tailFilters.join(",")},setsar=1${outLabel}`);
      currentMainLabel = outLabel;
    } else {
      fc.push(`${currentMainLabel}setsar=1[maintail]`);
      currentMainLabel = "[maintail]";
    }

    let finalVideoLabel = currentMainLabel;
    // logo
    if (hasLogo) {
      const logoInputIndex = inputIndex("logo");
      fc.push(
        `[${logoInputIndex}:v]scale=${FEATURES.branding.logoWidth}:-1,format=rgba[mainlogo]`,
      );
      fc.push(
        `${finalVideoLabel}[mainlogo]overlay=W-w-${FEATURES.branding.logoMargin}:${FEATURES.branding.logoMargin}[mainvwithlogo]`,
      );
      finalVideoLabel = "[mainvwithlogo]";
    }

    let finalAudioLabel;
    // amix divides loudness by input count unless normalize=0 — keep each
    // layer's own volume by disabling normalization.
    const norm = FEATURES.audio.amixNormalize ? 1 : 0;
    const mixOpts = `:duration=first:dropout_transition=2:normalize=${norm}`;
    const hasVoLayer = Boolean(voiceOver) && showVoiceover;
    const duckEnabled = FEATURES.audio.duck && hasAudio && hasBed;
    const sc = `sidechaincompress=${FEATURES.audio.duckStrength}`;
    const fmt = `aformat=sample_rates=${SAMPLE_RATE}:channel_layouts=stereo`; // keep sidechain inputs format-matched
    const dialogueVolume = (
      (voiceOver && showVoiceover
        ? FEATURES.audio.originalVolumeWithVoiceover
        : ORIGINAL_AUDIO_VOLUME) * (FEATURES.audio.dialogueBoost || 1)
    ).toFixed(3);

    if (hasAudio) {
      // Original movie audio: denoise + wider band, pitched, speed-matched.
      // Split the dialogue into the mix copy + sidechain keys that trigger ducking.
      const scCopies = duckEnabled ? (hasVoLayer ? 3 : 2) : 1;
      const splitStage =
        scCopies === 1
          ? ""
          : scCopies === 2
            ? ",asplit=2[mainorig][scBed]"
            : ",asplit=3[mainorig][scBed][scVo]";
      fc.push(
        `[0:a]aresample=${SAMPLE_RATE},asetrate=${SAMPLE_RATE}*${VOICE_PITCH},${FEATURES.audio.originalClean},${atempoFilters(SPEED_FACTOR / VOICE_PITCH)},volume=${dialogueVolume},aresample=${SAMPLE_RATE},${fmt}${splitStage || "[mainorig]"}`,
      );
      if (hasBed) {
        fc.push(`[1:a]atempo=1,${fmt},volume=${BED_AUDIO_VOLUME}[bedraw]`);
        if (duckEnabled) {
          // bed ducks automatically while the movie speaks
          fc.push(`[bedraw][scBed]${sc}[mainbed]`);
        } else {
          fc.push(`[bedraw]anull[mainbed]`);
        }
        if (hasVoLayer) {
          const voiceOverInputIndex = inputIndex("voiceover");
          fc.push(
            `[${voiceOverInputIndex}:a]atempo=1,${fmt},${FEATURES.audio.denoise},volume=${VOICEOVER_VOLUME}[voraw]`,
          );
          if (duckEnabled) {
            fc.push(`[voraw][scVo]${sc}[voiceovermix]`);
          } else {
            fc.push(`[voraw]anull[voiceovermix]`);
          }
          fc.push(
            `[mainorig][mainbed][voiceovermix]amix=inputs=3${mixOpts}[premix]`,
          );
        } else {
          fc.push(
            `[mainorig][mainbed]amix=inputs=2${mixOpts}[premix]`,
          );
        }
      } else if (hasVoLayer) {
        // No bed music available: dialogue + voiceover still mix
        const voiceOverInputIndex = inputIndex("voiceover");
        fc.push(
          `[${voiceOverInputIndex}:a]atempo=1,${fmt},${FEATURES.audio.denoise},volume=${VOICEOVER_VOLUME}[voiceovermix]`,
        );
        fc.push(`[mainorig][voiceovermix]amix=inputs=2${mixOpts}[premix]`);
      } else {
        fc.push(`[mainorig]anull[premix]`);
      }
      finalAudioLabel = "[premix]";
    } else if (hasBed) {
      // Silent input video (or --no-audio): bed is the main content — play it
      // at the louder silent-source level; nothing competes with it.
      fc.push(
        `[1:a]atempo=1,${fmt},volume=${FEATURES.audio.bedVolumeSilentSource}[mainbed]`,
      );
      if (hasVoLayer) {
        const voiceOverInputIndex = inputIndex("voiceover");
        fc.push(
          `[${voiceOverInputIndex}:a]atempo=1,${fmt},${FEATURES.audio.denoise},volume=${VOICEOVER_VOLUME}[voiceovermix]`,
        );
        fc.push(
          `[mainbed][voiceovermix]amix=inputs=2${mixOpts}[premix]`,
        );
      } else {
        fc.push(`[mainbed]anull[premix]`);
      }
      finalAudioLabel = "[premix]";
    } else {
      // No source audio and no bed music: generate silence so [outa] exists
      fc.push(
        `anullsrc=channel_layout=stereo:sample_rate=${SAMPLE_RATE},atrim=end=${mainDuration.toFixed(3)}[premix]`,
      );
      finalAudioLabel = "[premix]";
    }

    // Master safety: hard ceiling so dialogue+music never clips
    fc.push(
      `${finalAudioLabel}alimiter=limit=${FEATURES.audio.maxMixGain}[mixeda]`,
    );
    finalAudioLabel = "[mixeda]";

    // Trim mixed audio to video duration to prevent desync / trailing playback.
    // Fades run on the un-collapsed timeline (same as video fades), then the
    // audio drops the SAME periodic windows as the video select filter.
    fc.push(
      `${finalAudioLabel}atrim=end=${mainDuration.toFixed(3)},asetpts=PTS-STARTPTS[atrimmed]`,
    );
    if (FADE_SECONDS > 0) {
      fc.push(
        `[atrimmed]afade=t=in:st=0:d=${FADE_SECONDS},afade=t=out:st=${Math.max(0, mainDuration - FADE_SECONDS).toFixed(3)}:d=${FADE_SECONDS}[afaded]`,
      );
    } else {
      fc.push(`[atrimmed]anull[afaded]`);
    }
    if (FEATURES.contentMod.enable) {
      // Mirror of the video select: cut cmDrop seconds of every cmEvery so
      // audio and video stay frame-locked. N/SR/TB renumbers samples so the
      // dropped windows leave no timestamp gaps (same as video's N/FRAME_RATE/TB)
      fc.push(
        `[afaded]aselect='if(gte(mod(t,${cmEvery}),${cmDrop}),1,0)',asetpts=N/SR/TB[finala]`,
      );
    } else {
      fc.push(`[afaded]anull[finala]`);
    }

    // Video final: optional periodic removal (drop N sec every M sec), then trim
    if (FEATURES.contentMod.enable) {
      fc.push(
        `${finalVideoLabel}select='if(gte(mod(t,${cmEvery}),${cmDrop}),1,0)',setpts=N/FRAME_RATE/TB[filteredv]`,
      );
      fc.push(
        `[filteredv]trim=end=${mainDuration.toFixed(3)},setpts=PTS-STARTPTS[finalv]`,
      );
    } else {
      fc.push(
        `${finalVideoLabel}trim=end=${mainDuration.toFixed(3)},setpts=PTS-STARTPTS[finalv]`,
      );
    }
    fc.push(`[finalv]null[outv]`);
    fc.push(`[finala]anull[outa]`);

    const filterComplex = fc.join(";");

    const outputOptions = [
      "-map", "[outv]",
      "-map", "[outa]",
      "-c:v", "libx264",
      "-crf", CRF,
      "-preset", X264_PRESET,
      "-threads", "0",
      "-c:a", "aac",
      "-b:a", FEATURES.audio.bitrate,
      "-ar", String(FEATURES.audio.sampleRate),
      "-ac", "2",
      "-r", String(OUT_FPS),
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      "-map_metadata", "-1",
      "-shortest",
      "-metadata", `title=${fileBaseName} | short video`,
      "-metadata", "description=Short video clip featuring cinematic scenes, cartoon animations, or video game moments curated for social media and short-form content.",
      "-metadata", "comment=Produced by NHRepon",
      "-metadata", "artist=Md. Nur Hossain Repon",
      "-metadata", "album_artist=Md. Nur Hossain Repon",
      "-metadata", "publisher=NHRepon",
      "-metadata", "genre=Short Video Content",
      "-metadata", "language=en",
      "-metadata", "encoder=Lavf/NHRepon Video Processor",
      "-metadata", "composer=NHRepon",
      "-metadata", "album=Movie Clip & Animation Collection",
      "-metadata", "track=1",
      "-metadata", "network=NHRepon",
      "-metadata", "synopsis=Cinematic movie clip, cartoon animation, or video game scene created for social sharing and short-form video publishing.",
      "-metadata", `keywords=${[
        "movie clip", "film scene", "cinematic", "viral clip", "short video",
        "entertainment", "movie highlights", "animation clip", "cartoon clip",
        "tom and jerry clip", "nhrepon",
      ].join(",")}`,
      "-metadata", `date=${new Date().toISOString().slice(0, 10)}`,
      "-metadata", "copyright=NHRepon",
    ];

    await withRetry(`encode ${outputFileName}`, () =>
      new Promise((resolve, reject) => {
        let lastLoggedPercent = -1;
        try {
          fs.rmSync(outputVideo, { force: true }); // remove partial from previous attempt
        } catch {
          /* ignore */
        }
        command
          .complexFilter(filterComplex)
          .outputOptions(...outputOptions)
          .output(outputVideo)
          .on("start", () => log("🎬 FFmpeg started"))
          .on("progress", (progress) => {
            const elapsed = timemarkToSeconds(progress.timemark);
            if (elapsed === null || mainDuration <= 0) return;
            const safeTotal = Math.max(mainDuration, elapsed, 0.001);
            const percent = Math.min((elapsed / safeTotal) * 100, 99.4);
            const rounded = Math.floor(percent);
            if (rounded <= lastLoggedPercent) return;
            lastLoggedPercent = rounded;
            log(
              `Progress: ${percent.toFixed(1)}% (${elapsed.toFixed(1)}s of ${mainDuration.toFixed(1)}s)`,
            );
          })
          .on("end", resolve)
          .on("error", (err, stdout, stderr) => {
            if (stderr) log(`ffmpeg stderr tail: ${String(stderr).slice(-400)}`);
            reject(err);
          })
          .run();
      }),
    );

    // Verify the finished file before declaring success
    await verifyOutput(outputVideo, finalDuration);

    const hash = await fileSha256Hex(outputVideo);
    log(`✅ ${outputVideo} (sha256 ${hash.slice(0, 12)}…)`);
    return outputVideo;
  }

  return processVideo();
}

module.exports = { videoProcessor, splitVideo, run, FEATURES, planParts };

// Run directly (node src/scripts/movie.js), not when required by a test.
if (require.main === module) {
  run().catch((err) => {
    log(`FATAL: ${err && err.message ? err.message : err}`);
    if (err && err.stack) warn(err.stack);
    process.exitCode = 1;
  });
}
