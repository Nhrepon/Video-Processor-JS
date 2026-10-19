#!/usr/bin/env node
/**
 * b2e.js -- re-dub a video into English. Orchestrator.
 *
 * Wires the stages together end to end:
 *
 *   ingest    -> yt-dlp download of a YouTube URL (or use --input for a local file)
 *   extract   -> source.mp4 to 16 kHz mono WAV, applying --trim-start/--trim-end
 *   transcribe-> faster-whisper, word timestamps, VAD + anti-hallucination
 *   translate -> source language to English, segment count preserved
 *   synthesize-> edge-tts per segment + time-fit ratios
 *   assemble  -> fit and place clips on a silent timeline
 *   music     -> optional ducked music bed
 *   reframe   -> logo crop, target aspect, motion, subs, audio mux
 *
 * Usage:
 *   node src/B2E/b2e.js --url "https://youtu.be/VIDEO_ID" --source-lang bn \
 *     --provider local --voice natural --music "Taking Flight"
 *   node src/B2E/b2e.js --input src/input/bangla.mp4 --stop-after translate
 *   node src/B2E/b2e.js --input in.mp4 --force          # ignore cache
 *
 * Stages are cached in src/B2E/work/<basename>/, so a re-run only redoes what
 * changed. See README.md for the full option list.
 */
const { spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("@ffmpeg-installer/ffmpeg").path;
const ffprobePath = require("@ffprobe-installer/ffprobe").path;
const { getMediaDuration, fileSha256Hex } = require("../utility/utility");

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

const B2E_DIR = __dirname;
// transcribe.py lives with its standalone tool in src/transcribe/ rather than
// here, since it is useful on its own (see src/transcribe/README.md).
const TRANSCRIBE_PY = path.join(B2E_DIR, "..", "transcribe", "transcribe.py");
const WORK_ROOT = path.join(B2E_DIR, "work");
const OUTPUT_DIR = path.join(B2E_DIR, "output");

const STAGES = ["extract", "transcribe", "translate", "synthesize", "assemble", "music", "reframe"];

function log(line) {
  console.log(`[b2e] ${line}`);
}

function fail(line) {
  console.error(`[b2e] ERROR: ${line}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);

    // A value may be either "--key value" or "--key=value". The inline form is
    // what makes paths containing spaces usable: without it, "--music Good Vibes.mp4"
    // is parsed as --music="Good" and a stray positional "Vibes.mp4".
    const eq = key.indexOf("=");
    if (eq !== -1) {
      out[key.slice(0, eq)] = key.slice(eq + 1);
      continue;
    }

    // Collect the following tokens that are not new flags, so an unquoted
    // multi-word value is rejoined rather than truncated at the first space.
    const parts = [];
    let j = i + 1;
    while (j < argv.length && !argv[j].startsWith("--")) {
      parts.push(argv[j]);
      j += 1;
    }
    if (parts.length === 0) {
      out[key] = true;
    } else {
      out[key] = parts.join(" ");
      i = j - 1;
    }
  }
  return out;
}

function run(cmd, cmdArgs, label) {
  log(`${label}: ${cmd} ${cmdArgs.join(" ")}`);
  const r = spawnSync(cmd, cmdArgs, { encoding: "utf-8", maxBuffer: 1024 * 1024 * 32 });
  if (r.error) fail(`${label} could not start: ${r.error.message}`);
  if (r.status !== 0) {
    fail(`${label} failed (exit ${r.status}):\n${(r.stdout || "")}${(r.stderr || "")}`);
  }
  return r;
}

function fresh(stagePath) {
  if (fs.existsSync(stagePath)) {
    fs.rmSync(stagePath, { force: true, recursive: true });
  }
  fs.mkdirSync(stagePath, { recursive: true });
  return stagePath;
}

// Stages write their artifacts to the work-dir root (segments.json, english.wav,
// ...), not into a per-stage marker directory. So cache validity has to be judged
// from those artifacts. An earlier version used "is the marker dir non-empty",
// which never held for the JSON/wav stages and silently re-ran them every time --
// including the ~10 minute transcription on CPU.
function isFreshFile(file, minBytes = 1) {
  try {
    return fs.statSync(file).size >= minBytes;
  } catch {
    return false;
  }
}

function isFreshJson(file, key) {
  if (!isFreshFile(file)) return false;
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf-8").replace(/^﻿/, ""));
    const list = data[key];
    return Array.isArray(list) ? list.length > 0 : true;
  } catch {
    return false; // truncated/partial write: treat as not cached
  }
}

function cached(outputs, force) {
  if (force) return false;
  return outputs.every((o) => (o.json ? isFreshJson(o.file, o.json) : isFreshFile(o.file, o.min)));
}

/**
 * Resolve the trim window (seconds to drop from the head and tail of the source).
 *
 * Trimming happens HERE, on the extracted audio, not only on the picture. That is
 * deliberate: if the head were removed from the video alone, every transcribed
 * segment would still carry a timestamp measured from the original start, so the
 * English dub would be offset by exactly trimStart. Trimming the audio first makes
 * all downstream timings relative to the trimmed zero point, and reframe.js then
 * cuts the video to match.
 */
function resolveTrim(opts, sourceDur) {
  const start = Math.max(0, parseFloat(opts["trim-start"]) || 0);
  let end = Math.max(0, parseFloat(opts["trim-end"]) || 0);
  if (opts.duration) {
    // --duration wins over --trim-end: it states the length directly.
    const dur = parseFloat(opts.duration);
    if (Number.isFinite(dur) && dur > 0) end = start + dur;
  }
  if (!start && !end) return { start: 0, end: 0, length: sourceDur };

  const length = sourceDur - start - end;
  if (length <= 0.5) {
    fail(
      `trim removes the whole clip: source is ${sourceDur.toFixed(2)}s but you asked to ` +
        `skip ${start}s from the start and ${end}s from the end.`,
    );
  }
  if (end > sourceDur - start) {
    log(
      `trim: --trim-end ${end}s exceeds what is left after skipping ${start}s ` +
        `of a ${sourceDur.toFixed(2)}s source; clamping to the end of the clip.`,
    );
  }
  return { start, end: Math.min(end, sourceDur - start), length: sourceDur - start - Math.min(end, sourceDur - start) };
}

function stageExtract(input, workDir, force, trim) {
  const out = path.join(workDir, "audio.wav");

  // The trim window is part of the extract result, so a cached audio.wav is only
  // valid for the trim that produced it. Without recording the window, changing
  // --trim-start would silently reuse audio trimmed for a different range and
  // shift the whole dub.
  let cachedTrim = null;
  if (fs.existsSync(out)) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(workDir, "extract.json"), "utf-8"));
      cachedTrim = { start: Number(meta.start) || 0, end: Number(meta.end) || 0 };
    } catch {
      cachedTrim = null; // no marker: treat as not cached
    }
  }
  const trimMatches =
    cachedTrim &&
    Math.abs(cachedTrim.start - trim.start) < 0.01 &&
    Math.abs(cachedTrim.end - trim.end) < 0.01;

  if (cached([{ file: out, min: 1024 }], force) && trimMatches) {
    log("extract: cached");
    return out;
  }
  if (cachedTrim && !trimMatches) {
    log(
      `extract: cached audio was trimmed -${cachedTrim.start.toFixed(2)}s/-${cachedTrim.end.toFixed(2)}s ` +
        `but you asked for -${trim.start.toFixed(2)}s/-${trim.end.toFixed(2)}s; re-extracting`,
    );
  }
  fresh(path.dirname(out));

  // -ss before -i is a fast seek and is accurate for audio extraction; -t caps
  // the length. Together they define the window the whole pipeline works on.
  const seek = trim.start > 0 ? ["-ss", trim.start.toFixed(3)] : [];
  const cap = ["-t", trim.length.toFixed(3)];

  run(
    ffmpegPath,
    // Normalise before transcribing. Source videos are frequently clipped
    // (peaks pinned at 0 dB) and loud, which is the main trigger for Whisper
    // hallucination/repetition loops on Bengali. highpass drops rumble that
    // hurts VAD, loudnorm sets a speech-friendly level, alimiter stops the
    // loudnorm output from clipping again.
    ["-y", "-hide_banner", "-loglevel", "error", "-i", input,
     ...seek,
     "-vn", "-ac", "1", "-ar", "16000",
     "-af", "highpass=f=100,loudnorm=I=-16:TP=-1.5:LRA=11,alimiter=limit=0.97",
     ...cap,
     "-c:a", "pcm_s16le", out],
    "extract",
  );
  if (trim.start || trim.end) {
    log(`extract: trimmed -${trim.start.toFixed(2)}s head, -${trim.end.toFixed(2)}s tail -> ${trim.length.toFixed(2)}s`);
  }
  // Record the window so a later run can tell whether the cached audio matches.
  fs.writeFileSync(
    path.join(workDir, "extract.json"),
    JSON.stringify({ start: trim.start, end: trim.end, length: trim.length }, null, 2),
  );
  log(`extract: ${out}`);
  return out;
}

// Keep this in step with synthesize.py's own default, so the cache check compares
// like with like. Changing the default here means existing cached clips are
// re-rendered once rather than silently reused.
const DEFAULT_VOICE = "en-US-GuyNeural";

/**
 * Candidate narrator voices, best-first for a natural, attractive,
 * young-to-middle-aged male read.
 *
 * The edge-tts default (en-US-GuyNeural) is a "News, Novel / Passion" anchor
 * voice -- deliberately booming and formal. It suits a re-dub because it matches
 * the source register, but it is not what most people mean when they ask for a
 * "natural" narrator, so it is listed last rather than first.
 *
 * Descriptions are taken from the voice list itself; the ordering is judgement.
 */
const VOICE_PRESETS = [
  { name: "en-US-BrianNeural", note: "approachable, casual, sincere - most conversational" },
  { name: "en-GB-RyanNeural", note: "friendly, positive, youthful British" },
  { name: "en-US-AndrewNeural", note: "warm, confident, authentic" },
  { name: "en-GB-ThomasNeural", note: "friendly, measured British" },
  { name: "en-CA-LiamNeural", note: "friendly Canadian" },
  { name: "en-US-RogerNeural", note: "lively, presenter-like" },
  { name: "en-US-ChristopherNeural", note: "reliable, authority" },
  { name: "en-US-GuyNeural", note: "news anchor, passionate (edge-tts default)" },
];

// Short aliases, so the common intent is one word to type.
const VOICE_ALIASES = {
  natural: "en-US-BrianNeural",
  casual: "en-US-BrianNeural",
  young: "en-GB-RyanNeural",
  british: "en-GB-RyanNeural",
  warm: "en-US-AndrewNeural",
  confident: "en-US-AndrewNeural",
  friendly: "en-GB-ThomasNeural",
  news: "en-US-RogerNeural",
  anchor: "en-US-GuyNeural",
};

function resolveVoice(opts) {
  const raw = opts.voice && opts.voice !== true ? opts.voice : null;
  if (!raw) return null;
  const key = raw.toLowerCase().trim();
  if (VOICE_ALIASES[key]) {
    const mapped = VOICE_ALIASES[key];
    log(`voice: "${raw}" -> ${mapped}`);
    return mapped;
  }
  return raw; // an explicit full voice name, used as-is
}

function listVoices() {
  console.log("Narrator voices for --voice:\n");
  for (const v of VOICE_PRESETS) {
    console.log(`  ${v.name.padEnd(24)} ${v.note}`);
  }
  const aliases = Object.entries(VOICE_ALIASES)
    .map(([a, v]) => `${a}=${v.replace("Neural", "")}`)
    .join(", ");
  console.log(`\nAliases: ${aliases}\n`);
  console.log("Any other edge-tts name also works, e.g. --voice en-US-JennyNeural");
  console.log("(`edge-tts --list-voices` shows the full catalogue.)");
}

function stageTranscribe(workDir, opts, force) {
  const out = path.join(workDir, "segments.json");
  if (cached([{ file: out, json: "segments" }], force)) {
    log("transcribe: cached");
    return out;
  }
  fresh(path.join(workDir, "transcribe"));
  const args = [
    TRANSCRIBE_PY,
    "--audio", path.join(workDir, "audio.wav"),
    "--out", out,
  ];
  // --whisper-model is the explicit form; --model is kept as a legacy alias.
  // Resolving to one value here stops both being forwarded as a duplicate
  // `--model` pair, where argparse would silently honour the last one.
  const whisperModel = opts["whisper-model"] || opts.model;
  if (whisperModel && whisperModel !== true) args.push("--model", whisperModel);
  // Bangla-specific steering text; only forward when the caller supplied one so
  // transcribe.py's own default stays in charge otherwise.
  if (opts.prompt && opts.prompt !== true) args.push("--prompt", opts.prompt);
  // Source language matters: transcribe.py defaults to "bn", so an English (or
  // any other) source would be force-decoded as Bangla and produce nonsense.
  if (opts["source-lang"] && opts["source-lang"] !== true) {
    args.push("--language", opts["source-lang"]);
  }
  run("python", args, "transcribe");
  return out;
}

function stageTranslate(workDir, opts, force) {
  const out = path.join(workDir, "translated.json");
  // The provider (and language pair) determine the text, so a cached translation
  // is only valid for the one that produced it. Without this, switching from
  // mymemory to a local LLM would silently reuse the old wording.
  const wanted = {
    provider: opts.provider || "mymemory",
    source: opts["source-lang"] || "bn",
    target: opts["target-lang"] || "en",
    model: opts["local-model"] || opts["translate-model"] || opts.model || "",
  };
  let providerOk = false;
  if (fs.existsSync(out)) {
    try {
      const prev = JSON.parse(fs.readFileSync(out, "utf-8").replace(/^﻿/, ""));
      const p = prev.translate_provider || {};
      providerOk =
        p.provider === wanted.provider &&
        p.source_lang === wanted.source &&
        p.target_lang === wanted.target &&
        String(p.model || "") === String(wanted.model);
      if (!providerOk) {
        log(
          `translate: cached output was made by ${p.provider || "?"} ` +
            `(${p.source_lang}->${p.target_lang}${p.model ? `, ${p.model}` : ""}); ` +
            `now ${wanted.provider} (${wanted.source}->${wanted.target}` +
            `${wanted.model ? `, ${wanted.model}` : ""}) -- re-translating`,
        );
      }
    } catch {
      providerOk = false;
    }
  }
  if (cached([{ file: out, json: "segments" }], force) && providerOk) {
    log("translate: cached");
    return out;
  }
  fresh(path.join(workDir, "translate"));
  const args = [
    path.join(B2E_DIR, "translate.py"),
    "--segments", path.join(workDir, "segments.json"),
    "--out", out,
    "--provider", opts.provider || "mymemory",
  ];
  // Only meaningful for the openai provider; mymemory has no model to select.
  // Without this guard `--model large-v3` (the Whisper model) leaked in as the
  // translation model and produced a confusing 404.
  if (opts["translate-model"] && opts["translate-model"] !== true) {
    args.push("--model", opts["translate-model"]);
  } else if (opts.model && opts.provider === "openai") {
    args.push("--model", opts.model);
  }
  if (opts["local-base-url"]) args.push("--local-base-url", opts["local-base-url"]);
  if (opts["local-model"]) args.push("--local-model", opts["local-model"]);
  // Keep the language pair consistent with transcription, so an English source is
  // not translated as though it were Bangla.
  if (opts["source-lang"] && opts["source-lang"] !== true) {
    args.push("--source-lang", opts["source-lang"]);
  }
  if (opts["target-lang"] && opts["target-lang"] !== true) {
    args.push("--target-lang", opts["target-lang"]);
  }
  run("python", args, "translate");
  return out;
}

function stageSynthesize(workDir, opts, force) {
  const out = path.join(workDir, "tts.json");
  const clips = path.join(workDir, "clips");
  const voice = resolveVoice(opts);

  // A cached manifest is only usable if the mp3s it points at still exist on disk.
  // Deleting `clips/` by hand while keeping tts.json is easy to do and used to
  // yield a silently silent english.wav.
  let clipsOk = fs.existsSync(clips) && fs.readdirSync(clips).some((f) => f.endsWith(".mp3"));
  if (clipsOk) {
    try {
      const manifest = JSON.parse(fs.readFileSync(out, "utf-8").replace(/^﻿/, ""));
      const withAudio = (manifest.segments || []).filter((s) => s.audio);
      clipsOk = withAudio.length > 0 && withAudio.every((s) => fs.existsSync(s.audio));

      // The cache must also match the voice that produced it. synthesize.py writes
      // the voice it used into the manifest, so comparing against it means changing
      // --voice actually re-renders the clips instead of silently reusing the old
      // narrator -- which is otherwise very confusing to debug.
      const cachedVoice = manifest.voice;
      const wantedVoice = voice || DEFAULT_VOICE;
      if (clipsOk && cachedVoice !== wantedVoice) {
        log(`synthesize: cached clips use "${cachedVoice}", re-rendering with "${wantedVoice}"`);
        clipsOk = false;
      }
    } catch {
      clipsOk = false;
    }
  }
  if (cached([{ file: out, json: "segments" }], force) && clipsOk) {
    log("synthesize: cached");
    return { manifest: out, clips, voice };
  }
  fresh(clips);
  const args = [
    path.join(B2E_DIR, "synthesize.py"),
    "--segments", path.join(workDir, "translated.json"),
    "--outdir", clips,
    "--out", out,
  ];
  // resolved above, alongside the cache check that depends on it
  if (voice) args.push("--voice", voice);
  if (opts.rate) args.push("--rate", opts.rate);
  if (opts.pitch) args.push("--pitch", opts.pitch);
  if (opts["min-ratio"]) args.push("--min-ratio", opts["min-ratio"]);
  if (opts["max-ratio"]) args.push("--max-ratio", opts["max-ratio"]);
  run("python", args, "synthesize");
  return { manifest: out, clips, voice };
}

function stageAssemble(workDir, force) {
  const out = path.join(workDir, "english.wav");
  if (cached([{ file: out, min: 1024 }], force)) {
    log("assemble: cached");
    return out;
  }
  fresh(path.join(workDir, "assemble"));
  run(
    "python",
    [path.join(B2E_DIR, "assemble_audio.py"),
     "--manifest", path.join(workDir, "tts.json"), "--out", out],
    "assemble",
  );
  return out;
}

// Music lives in src/audio/youtube (drop-in folder: just add files). src/audio is
// searched as a fallback so a track parked elsewhere still works.
//
// src/audio also holds non-music material (cartoon voiceover clips, short-form
// extracts) which must never be picked up as a bed, so it is only consulted when
// an explicit --music is given -- never during auto-discovery.
// Music for the bed lives in src/audio/youtube/ -- drop files in and they are
// picked up, no config and no flag needed. src/audio/ also holds non-music
// material (cartoon voiceover clips, short-form extracts, stems) which must never
// be chosen automatically, so it is reachable only via an explicit --music.
const MUSIC_ROOT = path.join(B2E_DIR, "..", "audio", "youtube");
const AUDIO_ROOT = path.join(B2E_DIR, "..", "audio");
const AUDIO_EXTS = new Set([".mp3", ".m4a", ".wav", ".aac", ".flac", ".ogg", ".opus", ".mp4"]);

function collectAudio(root, maxDepth, skipDirs) {
  const found = [];
  const seen = new Set();
  const walk = (current, depth) => {
    if (depth > maxDepth) return;
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(current, e.name);
      if (e.isDirectory()) {
        if (skipDirs && skipDirs.test(e.name)) continue;
        walk(full, depth + 1);
      } else if (AUDIO_EXTS.has(path.extname(e.name).toLowerCase())) {
        if (seen.has(full)) continue;
        seen.add(full);
        found.push(full);
      }
    }
  };
  if (fs.existsSync(root)) walk(root, 0);
  return found.sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
}

// Always-on exclusions: build output and dotfiles are never music.
const NEVER_DIRS = /^(node_modules|work|output|__pycache__|\.)/i;
// Additional folders inside the music root that hold dialogue/SFX rather than beds.
const NON_MUSIC_DIRS = /^(voiceover|voice|sfx|sound|short|shorts|clip|clips)$/i;

/**
 * Candidate music beds: everything under src/audio/youtube except folders that
 * clearly hold speech or effects. Sorted so an auto-pick is reproducible.
 */
function listMusic() {
  return collectAudio(MUSIC_ROOT, 2, new RegExp(`${NEVER_DIRS.source}|${NON_MUSIC_DIRS.source}`, "i"));
}

/**
 * Every audio file under src/audio, with no music-only filtering.
 *
 * Used only to resolve an explicit --music, so an SFX or voiceover clip can still
 * be referenced on purpose -- just never chosen automatically.
 */
function searchAllAudio() {
  return collectAudio(AUDIO_ROOT, 3, NEVER_DIRS);
}

/**
 * Turn whatever the user passed into a real file path.
 *
 * Accepts an absolute/relative path, a bare filename, or a loose fragment of the
 * title ("flip" -> "On The Flip - The Grey Room _ Density & Time.mp3"). Without
 * this, every track would have to be typed out in full and re-typed whenever it
 * is moved.
 */
function resolveMusic(opts) {
  const wanted = opts.music && opts.music !== true ? opts.music : null;
  const available = listMusic();

  if (wanted) {
    if (fs.existsSync(wanted) && fs.statSync(wanted).isFile()) {
      return { file: path.resolve(wanted), explicit: true, available };
    }
    const lower = wanted.toLowerCase();
    // An explicit request may target anything under src/audio (including the
    // voiceover/SFX folders), so search the full tree, not just the music folder.
    const all = searchAllAudio();
    const matches = all.filter((f) => {
      const base = path.basename(f).toLowerCase();
      return base === lower || base === `${lower}.mp3` || base.includes(lower);
    });
    if (matches.length === 1) return { file: matches[0], explicit: true, available };
    if (matches.length > 1) {
      log(`--music "${wanted}" matched ${matches.length} files, using the first:`);
      matches.forEach((m) => log(`    ${m}`));
      return { file: matches[0], explicit: true, available };
    }
    fail(
      `--music "${wanted}" not found. Available audio:\n  ` +
        `${all.join("\n  ") || "(none)"}`,
    );
  }

  // No --music given: use the only track if there is exactly one, otherwise pick
  // the first alphabetically and say so, so the behaviour is never a surprise.
  if (available.length === 0) {
    return { file: null, explicit: false, available };
  }
  if (available.length === 1) {
    log(`music: using the only track available -> ${path.basename(available[0])}`);
  } else {
    log(`music: no --music given, ${available.length} tracks available; using the first:`);
    log(`    ${path.basename(available[0])}`);
  }
  return { file: available[0], explicit: false, available };
}

/**
 * Bed a music track under the finished voice track.
 *
 * Optional: without a track the assembled English wav is passed straight through,
 * so this stage costs nothing when the bed is not wanted. The mixed track is
 * written to a separate file rather than overwriting english.wav, which keeps
 * english.wav as a pure-voice reference for re-mixing at a different level
 * without re-running the (network-bound) TTS stage.
 */
async function stageMusic(workDir, opts, force, sourceDur) {
  const voice = path.join(workDir, "english.wav");

  const { file: music, available } = resolveMusic(opts);
  if (!music) {
    log("music: skipped (no tracks found in src/audio/youtube)");
    return { file: voice, mixed: false };
  }

  // Auto-loop when the track is shorter than the video. Without this the bed
  // stops part-way and the remainder is silence, which reads as a mistake.
  let loop = !!opts.loop;
  if (!loop) {
    const musicDur = await getMediaDuration(music).catch(() => 0);
    if (musicDur && sourceDur && musicDur < sourceDur - 1) {
      log(
        `music: "${path.basename(music)}" is ${musicDur.toFixed(1)}s but the ` +
          `video is ${sourceDur.toFixed(1)}s; auto-enabling --loop`,
      );
      loop = true;
    }
  }

  const out = path.join(workDir, "english_music.wav");
  if (cached([{ file: out, min: 1024 }], force) && !loop) {
    log("music: cached");
    return { file: out, mixed: true, track: music };
  }
  fresh(path.join(workDir, "music"));

  const args = [
    path.join(B2E_DIR, "music_bed.py"),
    "--voice", voice,
    "--music", music,
    "--out", out,
  ];
  if (opts["music-db"]) args.push("--music-db", opts["music-db"]);
  if (opts.duck) args.push("--duck", opts.duck);
  if (opts["duck-db"]) args.push("--duck-db", opts["duck-db"]);
  if (loop) args.push("--loop");
  run("python", args, "music");
  return { file: out, mixed: true, track: music };
}

// Resolve --url to a local file via ingest.js so the rest of the pipeline is
// unchanged: every later stage just consumes a local mp4.
function resolveInput(opts) {
  if (opts.input && opts.input !== true) return opts.input;
  if (!opts.url || opts.url === true) return null;

  const args = [path.join(B2E_DIR, "ingest.js"), "--url", opts.url];
  if (opts.quality) args.push("--quality", opts.quality);
  if (opts.force) args.push("--force");
  log(`url:   ${opts.url}`);
  const r = run("node", args, "ingest");

  // ingest.js prints progress on stderr and the resolved path as the final line
  // of stdout, so take the last non-empty stdout line as the file path.
  const lines = (r.stdout || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const resolved = lines[lines.length - 1];
  if (!resolved || !fs.existsSync(resolved)) {
    fail(`ingest did not produce a usable file (got: ${JSON.stringify(resolved)})`);
  }
  return resolved;
}

async function main() {
  const opts = parseArgs(process.argv);

  // Handy when the folder has grown: shows exactly what the resolver can see, so
  // "it used the wrong track" is answerable without reading the source.
  if (opts["list-voices"]) {
    listVoices();
    process.exit(0);
  }

  // List the models the configured local endpoint actually offers. Model ids on
  // these proxies are case-sensitive and a wrong one 404s mid-run, so being able
  // to check the exact spelling first is worth having.
  if (opts["list-models"]) {
    const probe = spawnSync(
      "python",
      [path.join(B2E_DIR, "translate.py"), "--list-models", "--provider", "local"],
      { stdio: ["ignore", "inherit", "inherit"] },
    );
    process.exit(probe.status === 0 ? 0 : 1);
  }

  if (opts["list-music"]) {
    const tracks = listMusic();
    if (tracks.length === 0) {
      console.log("No music found. Add files to src/audio/youtube/");
      process.exit(0);
    }
    console.log(`Music available (${tracks.length}) -- pass a fragment to --music:\n`);
    for (const t of tracks) {
      console.log(`  ${t}`);
    }
    process.exit(0);
  }

  if ((!opts.input || opts.input === true) && (!opts.url || opts.url === true)) {
    console.log(`B2E -- re-dub a video into English

Usage:
  node src/B2E/b2e.js --input <source.mp4> [options]
  node src/B2E/b2e.js --url <youtube url> [options]

Options:
  --input <path>        Source video (local)
  --url <url>           YouTube URL to download first (uses yt-dlp)
  --quality <q>         best | 2160 | 1440 | 1080 | 720 | 480  (default 1080)
  --width <n>           output width      (default 1920)
  --height <n>          output height     (default 1080)
  --crop <pct>          crop this % off ALL four edges (logo removal)
  --crop-top <pct>      crop this % off the top edge
  --crop-bottom <pct>   crop this % off the bottom edge
  --crop-left <pct>     crop this % off the left edge
  --crop-right <pct>    crop this % off the right edge
  --trim-start <s>      skip this many seconds at the start (default 0)
  --trim-end <s>        skip this many seconds at the end   (default 0)
  --duration <s>        keep exactly this many seconds (overrides --trim-end)
  --crf <n>             x264 quality, lower = better (default 22)
  --preset <name>       x264 preset, e.g. veryfast (default medium)
  --voice <name>        narrator voice: an alias (natural, warm, young,
                        friendly, news, anchor) or any edge-tts name.
                        Run --list-voices.  (default en-US-GuyNeural)
  --list-voices         show narrator voices and aliases, then exit
  --rate <+/-n%>        base speaking rate  (default +0%)
  --pitch <+/-nHz>      voice pitch         (default +0Hz)
  --provider <name>     mymemory | openai | local  (default mymemory)
                        local = any OpenAI-compatible local LLM (Ollama, LM Studio)
  --local-base-url <u>  endpoint for provider=local (default: auto-detect)
  --local-model <name>  model for provider=local      (default: auto-detect)
  --translate-model <n> translation model for provider=openai
  --whisper-model <n>   whisper model       (default large-v3; alias: --model)
  --prompt <text>       initial prompt for Whisper, helps with music-heavy audio
  --source-lang <code> language of the SOURCE   (default bn) e.g. --source-lang en
  --target-lang <code> language to translate to (default en)
  --music <name>       music track: a path, filename, or title fragment.
                        Searched in src/audio/youtube/ then src/audio/.
                        Omit to auto-pick the first track found.
  --list-music         list available tracks and exit
  --music-db <f>        music level in dB   (default -22; -30 is very subtle)
  --duck <f>            sidechain ratio for the bed (default 6; 0 disables)
  --duck-db <f>         sidechain key depth in dB (default -12)
  --loop                force the music to repeat (auto-enabled when too short)
  --min-ratio <f>       time-fit floor      (default 0.85)
  --max-ratio <f>       time-fit ceiling    (default 1.18)
  --stop-after <stage>  run up to: ${STAGES.join(", ")}
  --force               ignore all cached stages
`);
    process.exit(0);
  }

  const input = resolveInput(opts);
  if (!input) fail("provide either --input <path> or --url <youtube url>");
  if (!fs.existsSync(input)) fail(`input not found: ${input}`);

  const ext = path.extname(input);
  const base = path.basename(input, ext);
  const workDir = path.join(WORK_ROOT, `${base}-${crypto.createHash("md5").update(input).digest("hex").slice(0, 6)}`);
  const force = !!opts.force;

  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const sourceDur = await getMediaDuration(input);
  const sourceHash = await fileSha256Hex(input);
  log(`source: ${base} ${sourceDur.toFixed(2)}s sha256=${sourceHash.slice(0, 12)}`);
  log(`work:   ${workDir}`);

  const stopAfter = opts["stop-after"] && opts["stop-after"] !== true ? opts["stop-after"] : null;
  if (stopAfter && !STAGES.includes(stopAfter)) {
    fail(`--stop-after must be one of: ${STAGES.join(", ")}`);
  }
  const reached = (stage) => !stopAfter || STAGES.indexOf(stage) <= STAGES.indexOf(stopAfter);

  const trim = resolveTrim(opts, sourceDur);
  // When the trim window changes, everything downstream of extract is stale: the
  // segments, translations, clips and mix were all timed against the old window.
  // Caching them would play the old dub against the new picture.
  const trimChanged = (() => {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(workDir, "extract.json"), "utf-8"));
      return (
        Math.abs(Number(meta.start) - trim.start) > 0.01 ||
        Math.abs(Number(meta.end) - trim.end) > 0.01
      );
    } catch {
      return false;
    }
  })();
  const effectiveForce = force || trimChanged;

  stageExtract(input, workDir, effectiveForce, trim);
  if (!reached("transcribe")) return finishEarly(workDir);

  stageTranscribe(workDir, opts, effectiveForce);
  if (!reached("translate")) return finishEarly(workDir);

  stageTranslate(workDir, opts, effectiveForce);
  if (!reached("synthesize")) return finishEarly(workDir);

  stageSynthesize(workDir, opts, effectiveForce);
  if (!reached("assemble")) return finishEarly(workDir);

  stageAssemble(workDir, effectiveForce);
  if (!reached("music")) return finishEarly(workDir);

  const mixed = await stageMusic(workDir, opts, effectiveForce, trim.length);
  if (!reached("reframe")) return finishEarly(workDir);

  const outFile = path.join(OUTPUT_DIR, `${base}_english.mp4`);
  const srtFile = path.join(workDir, "english.srt");
  const reframeArgs = [path.join(B2E_DIR, "reframe.js"), "--video", input, "--audio", mixed.file, "--out", outFile];
  if (fs.existsSync(srtFile)) reframeArgs.push("--srt", srtFile);
  if (opts.width) reframeArgs.push("--width", opts.width);
  if (opts.height) reframeArgs.push("--height", opts.height);
  if (opts.crf) reframeArgs.push("--crf", opts.crf);
  if (opts.preset) reframeArgs.push("--preset", opts.preset);
  // Trim the picture to the same window the audio was trimmed to, so the two stay
  // in step. --trim-start is the important one: without it here the video would
  // start before the audio does.
  if (trim.start > 0) reframeArgs.push("--trim-start", trim.start.toFixed(3));
  if (trim.end > 0) reframeArgs.push("--trim-end", trim.end.toFixed(3));
  // Logo removal margins.
  for (const key of ["crop", "crop-top", "crop-bottom", "crop-left", "crop-right"]) {
    if (opts[key] && opts[key] !== true) reframeArgs.push(`--${key}`, opts[key]);
  }
  const r = spawnSync("node", reframeArgs, { stdio: "inherit" });
  if (r.status !== 0) fail("reframe failed");

  log("---");
  log(`output:     ${outFile}`);
  log(`subtitles:  ${srtFile}`);
  log(`scratch:    ${workDir}`);
  log(`voice only: ${path.join(workDir, "english.wav")}`);
  if (mixed.mixed) {
    log(`muxed audio (voice+music): ${mixed.file}`);
    if (mixed.track) log(`music track: ${mixed.track}`);
  }
}

function finishEarly(workDir) {
  log(`stopped early. inspect ${workDir}, then re-run to continue.`);
}

main().catch((err) => fail(err.stack || err.message));
