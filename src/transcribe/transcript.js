#!/usr/bin/env node
/**
 * transcript.js -- a YouTube URL in, a transcript out. Nothing else.
 *
 * Deliberately narrow: no translation, no synthesis, no re-framing, no encoding.
 * It downloads (or reuses) the video, pulls the audio, runs Whisper, writes the
 * transcript as .srt / .txt / .json, and prints the plain text to stdout.
 *
 * It exists because `--stop-after transcribe` on the full pipeline still makes you
 * know all the other flags, and because checking what Whisper actually heard should
 * be cheap -- see the transcript before spending a translation and TTS pass on it.
 *
 * Usage:
 *   node src/transcribe/transcript.js https://youtu.be/hXNpj2RzZeg
 *   node src/transcribe/transcript.js <url> --lang en --model large-v3
 *   node src/transcribe/transcript.js <url> --model small --quiet
 */
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

// This tool lives in src/transcribe but reaches into the B2E pipeline for two
// things: ingest.js (the shared YouTube downloader, so a video is never fetched
// twice) and the downloaded media cache. The Whisper engine is the transcribe.py
// sitting next to this file.
const SRC_DIR = path.join(__dirname, "..");
const B2E_DIR = path.join(SRC_DIR, "B2E");
const INPUT_DIR = path.join(SRC_DIR, "input");
const DEFAULT_OUT_ROOT = path.join(__dirname, "out");

function log(line) {
  console.error(`[transcript] ${line}`);
}

function fail(line) {
  console.error(`[transcript] ERROR: ${line}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      out._.push(a);
      continue;
    }
    const key = a.slice(2);
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

// Our stdout is reserved for the transcript so it can be piped or redirected.
// Children (ingest.js, transcribe.py, ffmpeg) all log to stdout, so their stdout
// goes to stderr; otherwise `node transcript.js <url> > out.txt` would capture the
// download and transcribe logs along with the transcript.
function run(cmd, cmdArgs, label) {
  log(`${label}: ${cmd} ${cmdArgs.join(" ")}`);
  const r = spawnSync(cmd, cmdArgs, {
    encoding: "utf-8",
    maxBuffer: 1024 * 1024 * 64,
    stdio: ["ignore", process.stderr, process.stderr],
  });
  if (r.error) fail(`${label} could not start: ${r.error.message}`);
  if (r.status !== 0) fail(`${label} failed (exit ${r.status})`);
  return r;
}

/** ingest.js downloads into src/input/youtube/, so look there. */
function findDownloaded(meta) {
  const dir = path.join(INPUT_DIR, "youtube");
  const exact = path.join(dir, `${meta.title}.mp4`);
  if (fs.existsSync(exact)) return exact;
  if (!fs.existsSync(dir)) fail(`ingest.js did not create ${dir}`);
  const candidates = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".mp4"))
    .map((f) => path.join(dir, f));
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    // Prefer the most recently written: that is the one just downloaded.
    candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    return candidates[0];
  }
  fail(`no downloaded video found in ${dir}`);
}

function extractAudio(input, outDir) {
  const wav = path.join(outDir, "audio.wav");
  const ffmpeg = require("@ffmpeg-installer/ffmpeg").path;
  run(
    ffmpeg,
    [
      "-y", "-hide_banner", "-loglevel", "error", "-i", input,
      "-vn", "-ac", "1", "-ar", "16000",
      // Same normalisation the full pipeline uses, so transcripts match.
      "-af", "highpass=f=100,loudnorm=I=-16:TP=-1.5:LRA=11,alimiter=limit=0.97",
      "-c:a", "pcm_s16le", wav,
    ],
    "extract audio",
  );
  if (!fs.existsSync(wav)) fail(`audio extraction produced nothing at ${wav}`);
}

function usage(url) {
  console.log(`transcript.js -- a YouTube URL in, a transcript out

Usage:
  node src/transcribe/transcript.js <youtube url> [options]

Options:
  --lang <code>    spoken language, Whisper is forced to it (default en)
  --model <name>   whisper model (default small; large-v3 is better but slower)
  --out <dir>      output directory (default src/transcribe/out/<video id>)
  --quality <q>    download cap (default 720; only audio is needed)
  --force          re-download and re-transcribe
  --no-video       audio only, skips the video download (faster)
  --quiet          write files, print nothing to stdout

Writes <out>/transcript.srt, <out>/transcript.txt and <out>/segments.json, and
prints the plain-text transcript to stdout unless --quiet is given.
`);
  process.exit(url ? 0 : 1);
}

function main() {
  const opts = parseArgs(process.argv);
  const url = opts._[0];
  if (!url || opts.help) usage(url);

  const lang = opts.lang || "en";
  const model = opts.model || "small";
  const quiet = !!opts.quiet;
  const force = !!opts.force;

  const meta = resolveMeta(url);
  log(`id=${meta.id}  title="${meta.title}"  ${meta.duration.toFixed(1)}s`);

  const outDir = opts.out && opts.out !== true
    ? path.resolve(opts.out)
    : path.join(DEFAULT_OUT_ROOT, meta.id);
  fs.mkdirSync(outDir, { recursive: true });

  // 1. media
  let source;
  if (opts["no-video"]) {
    const audioOnly = path.join(outDir, "source.m4a");
    if (force || !fs.existsSync(audioOnly)) {
      run("yt-dlp", ["-f", "bestaudio/best", "--no-playlist", "-o", audioOnly, url], "audio");
    } else {
      log("audio: cached");
    }
    source = audioOnly;
  } else {
    const dlDir = path.join(INPUT_DIR, "youtube");
    const exact = path.join(dlDir, `${meta.title}.mp4`);
    if (!force && fs.existsSync(exact)) {
      log("download: cached");
    } else {
      const args = [path.join(B2E_DIR, "ingest.js"), "--url", url];
      if (opts.quality) args.push("--quality", opts.quality);
      if (force) args.push("--force");
      run("node", args, "download");
    }
    source = findDownloaded(meta);
  }

  // 2. audio + 3. transcribe
  extractAudio(source, outDir);
  const segJson = path.join(outDir, "segments.json");
  run(
    "python",
    [
      path.join(__dirname, "transcribe.py"),
      "--audio", path.join(outDir, "audio.wav"),
      "--out", segJson,
      "--model", model,
      "--language", lang,
    ],
    "transcribe",
  );

  // transcribe.py wrote segments.srt/.txt beside the JSON; rename for clarity.
  for (const ext of ["srt", "txt"]) {
    const from = path.join(outDir, `segments.${ext}`);
    if (fs.existsSync(from)) {
      fs.renameSync(from, path.join(outDir, `transcript.${ext}`));
    }
  }

  const txt = path.join(outDir, "transcript.txt");
  const srt = path.join(outDir, "transcript.srt");

  // stdout carries the transcript and nothing else, so it can be piped.
  if (!quiet && fs.existsSync(txt)) {
    process.stdout.write(fs.readFileSync(txt, "utf-8"));
  }
  log("---");
  log(`text:      ${txt}`);
  log(`subtitles: ${srt}`);
  log(`json:      ${segJson}`);

  // Clean up only the scratch files this tool created. The ingest.js download
  // lives in src/input/youtube/ and is shared with the full pipeline's cache, so
  // it must NOT be deleted here.
  for (const f of [path.join(outDir, "audio.wav")]) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* already gone */
    }
  }
  if (opts["no-video"]) {
    // The audio-only download is ours alone, so it is safe to drop.
    try {
      fs.unlinkSync(source);
    } catch {
      /* already gone */
    }
  }
}

main();

function resolveMeta(url) {
  const r = spawnSync(
    "yt-dlp",
    ["--no-warnings", "--print", "%(id)s\t%(title)s\t%(duration)s", url],
    { encoding: "utf-8", maxBuffer: 1024 * 1024 * 8 },
  );
  if (r.error || r.status !== 0) {
    fail(
      "yt-dlp could not read that URL. Install/update it with:\n" +
        "         python -m pip install -U yt-dlp",
    );
  }
  const line = (r.stdout || "").trim().split("\n").pop() || "";
  const [id, title, duration] = line.split("\t");
  if (!id) fail(`could not resolve a video id from: ${url}`);
  return { id, title: title || id, duration: Number(duration) || 0 };
}
