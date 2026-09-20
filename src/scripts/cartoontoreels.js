/**
 * cartoonToReels.js
 * ─────────────────
 * Transform raw Tom & Jerry source clips into FB-Reels-ready 9:16 content.
 *
 * WHAT IT DOES:
 *   • 9:16 vertical (1080×1920) from source — full-bleed cover fit
 *   • NHREPON watermark area covered by opaque hook banner (top)
 *   • Variable speed (0.9x–1.25x) — varies fingerprint + keeps audience guessing
 *   • Warm vibrant color grade — distinct look from raw source
 *   • Random horizontal flip (~30%) — alters fingerprint significantly
 *   • Burned-in subtitles (auto-generated SRT) — drives muted-watch retention
 *   • Reaction / commentary text overlay at bottom — drives comments = FB signal
 *   • Random voiceover from src/audio/voiceover/ — transforms audio fingerprint
 *   • Loudnorm audio (-14 LUFS)
 *   • 15–40s output clips (shorter = harder copyright match, better retention)
 *   • NO nhrepon.com / logo / self-promotion watermark (FB suppresses these)
 *
 * INPUT  : src/output/cartoonBug/tom and jerry funny video (1).mp4
 * OUTPUT : src/autopost/video/cartoonmornings-{slug}-{n}.mp4
 *
 * USAGE:
 *   node src/scripts/cartoonToReels.js
 *   node src/scripts/cartoonToReels.js --input "src/output/cartoonBug/tom and jerry funny video (1).mp4"
 *   node src/scripts/cartoonToReels.js --part 25     # target clip length in seconds
 *   node src/scripts/cartoonToReels.js --parts 3     # split a long source into 3 reels
 */

const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("@ffmpeg-installer/ffmpeg").path;
const ffprobePath = require("@ffprobe-installer/ffprobe").path;
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

// ─── paths ───────────────────────────────────────────────────────────────────

const INPUT_DIR   = path.join(__dirname, "..", "input");
const OUTPUT_DIR  = path.join(__dirname, "..", "autopost", "video");
const TEMP_DIR    = path.join(__dirname, "..", "output", "tempCartoonReels");
const ASSETS_DIR  = path.join(__dirname, "..", "assets");
const FONT_FILE  = path.join(ASSETS_DIR, "RacingSansOne-Regular.ttf");
const VOICEOVER_DIR = path.join(__dirname, "..", "audio", "voiceover");
const BGMUSIC_DIR  = path.join(__dirname, "..", "audio");

const RUN_ID = `${Date.now().toString(36)}-${process.pid}`;
const VIDEO_EXT = new Set([".mp4", ".mov", ".mkv", ".webm"]);

// ─── reel config ─────────────────────────────────────────────────────────────

const CFG = {
  width:         1080,
  height:        1920,
  fps:           30,
  crf:           "21",
  preset:        "fast",

  // Variable speed — random per reel (0.9x to 1.25x)
  speedOptions:  [0.9, 0.95, 1.0, 1.05, 1.1, 1.15, 1.25],
  speedFactor:   1.10,  // default if not randomized

  // Shorter clips = better retention + harder copyright match
  targetSeconds:  25,
  minSeconds:     15,
  maxSeconds:     40,

  // Flip ~30% of reels (mirror = alters fingerprint)
  flipChance:     0.30,

  // Color grade variations (warm, vibrant — distinct from raw source)
  grades: [
    "eq=contrast=1.12:brightness=0.03:saturation=1.18:gamma_r=1.04:gamma_g=1.00:gamma_b=0.92",
    "eq=contrast=1.15:brightness=0.05:saturation=1.22:gamma_r=1.06:gamma_g=1.02:gamma_b=0.94",
    "eq=contrast=1.10:brightness=0.02:saturation=1.15:gamma_r=1.02:gamma_g=0.98:gamma_b=0.90",
    "eq=contrast=1.18:brightness=0.04:saturation=1.20:gamma_r=1.08:gamma_g=1.04:gamma_b=0.96",
  ],

  // Audio
  origVol:       0.55,        // original audio volume (reduced for voiceover)
  voiceVol:      0.25,        // voiceover volume
  bgVol:         0.18,        // background music volume (if present)
  lufs:         "-14",
  truePeak:      "-1.5",
  lra:           "11",

  // Banner (covers NHREPON watermark top-right area)
  bannerHeight:  340,
  bannerPadH:    40,
  bannerPadB:    20,
  bannerOpacity: 0.95,

  // Subtitle styling
  subFont:       "Racing Sans One",
  subSize:       56,
  subColor:      "#FFFFFF",
  subOutline:    "#000000",
  subOutlineW:   3,
  subMarginV:    480,
  subAlpha:      "&H00FFFFFF",

  // Reaction/commentary text at bottom
  reactSize:     48,
  reactMarginB:  160,
  reactFade:     0.4,
};

// ─── hook banner library ──────────────────────────────────────────────────────
// Variety: POV, challenge, nostalgia, open loop, pattern interrupt

const HOOK_LINES = [
  // POV format
  ["POV: You're Jerry and Tom just set a trap 🪤", "WATCH WHAT HAPPENS NEXT 😱"],
  ["POV: You're the mouse who always wins 🐭", "THIS IS YOUR ENERGY 👑"],
  ["POV: You're Tom planning at 3AM 🤯", "THE PLAN BACKFIRED 😂"],

  // Challenge/rate
  ["RATE THIS CHASE 1-10 💥", "BE HONEST 😤"],
  ["WHO IS WINNING THIS?! 👀", "WAIT FOR THE END 🔥"],
  ["PRANK LEVEL: 100 💀", "JERRY'S RESPONSE: LEGENDARY 👑"],
  ["THE COMEDY TIMING IS ELITE 🏆", "RATE IT 1-10 BELOW 👇"],

  // Nostalgia
  ["THIS WAS MY CHILDHOOD 🌙", "90s KIDS WILL REMEMBER 🥺"],
  ["CHILDHOOD MEMORY UNLOCKED 🎟️", "WHO ELSE WATCHED ON REPEAT? 🐭"],
  ["THE RIVALRY THAT TAUGHT US PETTINESS 🎨", "90s KIDS RAISED US 👑"],
  ["GROW UP ON THESE CARTOONS? 🥺", "SAVE THIS FOR NOSTALGIA 🌙"],

  // Open loop / pattern interrupt
  ["WAIT FOR THE PLOT TWIST 🤯", "JERRY DOESN'T MISS 😱"],
  ["HE SET A TRAP FOR JERRY 🪤", "THINK HE GOT HIM? 😏"],
  ["THIS CLIP IS PURE CHAOS 💀", "AND IT GETS WORSE 😂"],
  ["TOM'S FACE SAYS IT ALL 😤", "THE CONFIDENCE THOUGH 💀"],
  ["INVISIBLE ATTACK 💨", "JERRY STRIKES AGAIN 😂"],

  // Save/share bait
  ["SAVE THIS FOR YOUR NEXT BAD DAY 😭", "YOU'LL THANK ME LATER 👑"],
  ["TAG SOMEONE WHO'D APPRECIATE THIS 😂", "THEY NEED TO SEE IT 🐭"],
  ["SEND THIS TO YOUR CHAOS BUDDY 💀", "NO CHILL AT 3AM 🕒"],
  ["BOOKMARK FOR WHEN YOU NEED A LAUGH 😂", "TRUST ME ON THIS 👑"],

  // Relatable / meme
  ["JERRY SAID NOT TODAY 💪", "THE AUDACITY THOUGH 💀"],
  ["TOM.EXE HAS STOPPED WORKING 😤", "THE NEMESIS IS TOO POWERFUL 😂"],
  ["JERRY'S CONFIDENCE >>> MONDAY ENERGY 💪", "SEND TO SOMEONE WHO NEEDS IT 😂"],
  ["WHEN THE TINY HERO WINS AGAIN 🏆", "PROVE IN COMMENTS JERRY IS GOAT 🐭"],

  // "The X seconds when..." urgency
  ["THE 15 SECONDS WHEN TOM LOST IT 😂", "WATCH TILL THE END 🔥"],
  ["THE SECOND JERRY BECAME LEGEND 👑", "NOBODY EXPECTED THIS 😱"],
  ["THAT ONE SECOND TOM REGRETS EVERYTHING 😤", "CHILDHOOD TRAUMA UNLOCKED 💀"],
];

// Reaction / commentary text segments (bottom of screen) — front-loaded at 1.5s
const REACTIONS = [
  "when they try so hard 😭",
  "and he still fails 😂",
  "JERRY SAID NAH 💪",
  "the confidence though 💀",
  "no chill at 3am 🕒",
  "tom.exe has stopped working 😤",
  "the AUDACITY 😂",
  "this is art 🎨",
  "prank king behavior 👑",
  "he fell for it AGAIN 💀",
  "poor baby just wanted the cheese 🧀",
  "chaos is my comfort zone 🐭",
  "and tom just sat there 💢",
  "the nemesis is too powerful 😂",
  "he rlly thought he had him 😏",
  "save this for later 🔖",
  "tag your chaos buddy 🐭",
  "this is peak comedy 🏆",
  "the timing is elite 👑",
  "90s kids know the vibe 🥺",
];

// ─── helpers ─────────────────────────────────────────────────────────────────

function safeName(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
}

function escapeFilterPath(filePath) {
  return filePath.replace(/\\/g, "/");
}

function fileSha256Hex(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("error", reject);
    hash.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.pipe(hash, { end: true });
  });
}

function safeUnlink(filePath, label = "temp") {
  try {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log(`  removed ${label}: ${path.basename(filePath)}`);
    }
  } catch (e) {
    console.warn(`  could not remove ${label} ${filePath}: ${e.message}`);
  }
}

function getDuration(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, meta) => {
      if (err) return reject(err);
      const d = Number(meta?.format?.duration);
      resolve(Number.isFinite(d) && d > 0 ? d : 0);
    });
  });
}

// ─── voiceover selection ─────────────────────────────────────────────────────

function pickVoiceover() {
  try {
    const files = fs.readdirSync(VOICEOVER_DIR)
      .filter(f => /\.(mp3|m4a|wav|aac|ogg)$/i.test(f))
      .map(f => path.join(VOICEOVER_DIR, f));
    if (files.length === 0) return null;
    return files[Math.floor(Math.random() * files.length)];
  } catch {
    return null;
  }
}

function pickBGMusic() {
  try {
    const files = fs.readdirSync(BGMUSIC_DIR)
      .filter(f => /\.(mp3|m4a|mp4|wav|aac|ogg)$/i.test(f) && !f.startsWith("voiceOver") && f !== "voiceover")
      .map(f => path.join(BGMUSIC_DIR, f));
    if (files.length === 0) return null;
    return files[Math.floor(Math.random() * files.length)];
  } catch {
    return null;
  }
}

// ─── banner generation (PIL — no drawtext font issues on Windows) ─────────────

function makeBannerPath() {
  return path.join(TEMP_DIR, `banner-${RUN_ID}.png`);
}

async function generateBanner(hookTop, hookBot, bottomText) {
  const { execSync } = require("child_process");
  const pyBin = "C:/Users/RHYTHM CARE LTD/AppData/Local/Programs/Python/Python314/python.exe";
  const script = `
import sys
from PIL import Image, ImageDraw, ImageFont

def load_font(size):
    for fp in [r"${FONT_FILE.replace(/\\/g, "\\\\")}", r"C:\\\\Windows\\\\Fonts\\\\arialbd.ttf"]:
        try: return ImageFont.truetype(fp, size)
        except: pass
    return ImageFont.load_default()

def fit_font(draw, text, max_w, start, minimum):
    size = start
    while size > minimum:
        f = load_font(size)
        if draw.textlength(text, font=f) <= max_w:
            return f
        size -= 4
    return load_font(minimum)

# --- top banner (hook) ---
W, H = ${CFG.width}, ${CFG.bannerHeight}
img = Image.new("RGBA", (W, H), (0, 0, 0, int(255 * ${CFG.bannerOpacity})))
d = ImageDraw.Draw(img)
top = "${hookTop.replace(/"/g, '\\"')}"
bot = "${hookBot.replace(/"/g, '\\"')}"

font_top = fit_font(d, top, W - 80, 72, 40)
font_bot = fit_font(d, bot, W - 80, 56, 34)

tb_w = d.textlength(top, font=font_top)
tb_h = font_top.size
d.text(((W-tb_w)//2, (H//2)-tb_h-14), top, font=font_top, fill=(255,255,255,255))

bb_w = d.textlength(bot, font=font_bot)
bb_h = font_bot.size
d.text(((W-bb_w)//2, (H//2)+8), bot, font=font_bot, fill=(255,224,102,255))

img.save(sys.argv[1], "PNG")

# --- bottom banner (reaction) ---
BW, BH = ${CFG.width}, 220
bimg = Image.new("RGBA", (BW, BH), (0, 0, 0, 0))
bd = ImageDraw.Draw(bimg)
for y in range(40):
    a = int(255 * (y / 40) * 0.92)
    bd.line([(0, y), (BW, y)], fill=(0, 0, 0, a))
bd.rectangle([(0, 40), (BW, BH)], fill=(0, 0, 0, int(255 * 0.92)))
font_r = load_font(${CFG.reactSize})
rt = "${bottomText.replace(/"/g, '\\"')}"
rw = bd.textlength(rt, font=font_r)
bd.text(((BW-rw)//2, 40 + (BH-40-${CFG.reactSize})//2), rt, font=font_r, fill=(255,255,255,255))
bimg.save(sys.argv[2], "PNG")
`.trim();

  const scriptPath = path.join(TEMP_DIR, `banner-gen-${RUN_ID}.py`);
  const bannerPath = makeBannerPath();
  const bottomBannerPath = path.join(TEMP_DIR, `banner-bot-${RUN_ID}.png`);
  fs.writeFileSync(scriptPath, script);
  execSync(`"${pyBin}" "${scriptPath}" "${bannerPath}" "${bottomBannerPath}"`, { windowsHide: true });
  safeUnlink(scriptPath, "banner-gen script");
  return { bannerPath, bottomBannerPath };
}

// ─── reaction overlay plan ────────────────────────────────────────────────────
// Front-loaded: reactions start at 1.5s instead of 4s for better retention

function planReactions(totalDuration) {
  const segments = [];
  let cursor = 1.5;  // front-load action
  const minGap = 5;
  const maxGap = 12;
  const segDur = 3.0;
  const maxReact = 15;

  while (segments.length < maxReact && cursor + segDur < totalDuration - 2) {
    const text = REACTIONS[Math.floor(Math.random() * REACTIONS.length)];
    segments.push({ start: cursor, end: cursor + segDur, text });
    cursor += segDur + minGap + Math.random() * (maxGap - minGap);
  }
  return segments;
}

// ─── pick most dynamic section ───────────────────────────────────────────────

async function pickDynamicStart(videoPath, totalDur, windowDur, scopeStart = 0, scopeEnd = null) {
  const scopeHi = scopeEnd === null ? totalDur : Math.min(scopeEnd, totalDur);
  const scopeLen = scopeHi - scopeStart;
  if (scopeLen <= windowDur) return Math.max(0, scopeStart);

  const ffBin = ffmpegPath;
  const { execFileSync } = require("child_process");
  const samples = 12;
  const scores = [];
  for (let i = 0; i < samples; i++) {
    const t = scopeStart + (scopeLen / samples) * i;
    try {
      const out = execFileSync(ffBin, [
        "-ss", t.toFixed(2),
        "-i", videoPath,
        "-frames:v", "1",
        "-vf", "signalstats,metadata=print:file=-",
        "-f", "null",
        "-",
      ], { timeout: 8000, windowsHide: true }).toString();
      const m = out.match(/YAVG=([0-9.]+)/);
      scores.push({ t, score: m ? Number(m[1]) : 0 });
    } catch {
      scores.push({ t, score: 0 });
    }
  }

  let bestStart = scopeStart;
  let bestScore = -1;
  for (let s = 0; s < samples; s++) {
    const startT = scopeStart + (scopeLen / samples) * s;
    if (startT + windowDur > scopeHi) break;
    const covered = scores.filter((sc) => sc.t >= startT && sc.t < startT + windowDur);
    if (covered.length === 0) continue;
    const mean = covered.reduce((a, b) => a + b.score, 0) / covered.length;
    if (mean > bestScore) {
      bestScore = mean;
      bestStart = startT;
    }
  }
  return Math.max(scopeStart, Math.min(bestStart, scopeHi - windowDur));
}

// ─── main video processor ───────────────────────────────────────────────────

async function processReel({ videoPath, outputPath, targetSeconds, startOffset: forcedStart, hookTop = null, hookBot = null }) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });

  const dur = await getDuration(videoPath);
  if (dur <= 0) throw new Error(`Cannot probe duration of ${videoPath}`);

  // Random transform parameters for this reel
  const speedFactor = CFG.speedOptions[Math.floor(Math.random() * CFG.speedOptions.length)];
  const flip = Math.random() < CFG.flipChance;
  const grade = CFG.grades[Math.floor(Math.random() * CFG.grades.length)];
  const voiceover = pickVoiceover();
  const bgmusic = pickBGMusic();

  const useDur = Math.min(dur, targetSeconds || CFG.targetSeconds);
  let startOffset = dur > useDur ? (dur - useDur) / 2 : 0;
  if (forcedStart !== undefined && forcedStart !== null) {
    startOffset = Math.max(0, Math.min(forcedStart, dur - useDur));
  } else {
    try {
      startOffset = await pickDynamicStart(videoPath, dur, useDur);
    } catch (e) {
      console.log(`  (dynamic-start fallback: ${e.message})`);
    }
  }

  // Pick hook banner text + reaction text (use provided hook if available)
  const [finalHookTop, finalHookBot] = hookTop && hookBot ? [hookTop, hookBot] : HOOK_LINES[Math.floor(Math.random() * HOOK_LINES.length)];
  const reactText = REACTIONS[Math.floor(Math.random() * REACTIONS.length)];

  // Generate banners
  const { bannerPath, bottomBannerPath } = await generateBanner(finalHookTop, finalHookBot, reactText);
  if (!fs.existsSync(bannerPath)) throw new Error(`Banner generation failed: ${bannerPath}`);

  // Plan reaction text overlays
  const reactions = planReactions(useDur / speedFactor);

  // Build filter graph
  const fc = [];

  // 1. Input video: scale to cover 9:16, speed up, random flip
  let videoFilters = `[0:v]setpts=PTS/${speedFactor},` +
    `scale=${CFG.width}:${CFG.height}:force_original_aspect_ratio=increase,` +
    `crop=${CFG.width}:${CFG.height},` +
    `${grade},` +
    `setsar=1`;

  if (flip) {
    videoFilters += `,hflip`;
  }
  videoFilters += `[main]`;
  fc.push(videoFilters);

  // 2. Banner overlay — covers NHREPON watermark area
  fc.push(`[1:v]format=rgba[bnr]`);
  fc.push(`[main][bnr]overlay=0:0[m1]`);

  // 3. Bottom reaction banner (PIL-rendered)
  let cur = "[m1]";
  if (fs.existsSync(bottomBannerPath)) {
    fc.push(`[2:v]format=rgba[btm]`);
    fc.push(`${cur}[btm]overlay=0:H-h[m1b]`);
    cur = "[m1b]";
  }

  fc.push(`${cur}setsar=1[vout]`);

  // 4. Audio: original + voiceover + bgmusic mix (transforms audio fingerprint)
  const hasVoiceover = voiceover && fs.existsSync(voiceover);
  const hasBGMusic = bgmusic && fs.existsSync(bgmusic);

  if (hasVoiceover && hasBGMusic) {
    // All three: original + voiceover + bgmusic
    fc.push(`[0:a]highpass=f=80,lowpass=f=8000,volume=${CFG.origVol},aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[origa]`);
    fc.push(`[3:a]aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,volume=${CFG.voiceVol},asetpts=PTS-STARTPTS[voa]`);
    fc.push(`[4:a]aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,volume=${CFG.bgVol},asetpts=PTS-STARTPTS[bga]`);
    fc.push(`[origa][voa][bga]amix=inputs=3:duration=first,volume=3.0[mixa]`);
    fc.push(`[mixa]loudnorm=I=${CFG.lufs}:TP=${CFG.truePeak}:LRA=${CFG.lra}:print_format=summary[aout]`);
  } else if (hasVoiceover) {
    // Original + voiceover
    fc.push(`[0:a]highpass=f=80,lowpass=f=8000,volume=${CFG.origVol},aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[origa]`);
    fc.push(`[3:a]aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,volume=${CFG.voiceVol},asetpts=PTS-STARTPTS[voa]`);
    fc.push(`[origa][voa]amix=inputs=2:duration=first,volume=2.0[mixa]`);
    fc.push(`[mixa]loudnorm=I=${CFG.lufs}:TP=${CFG.truePeak}:LRA=${CFG.lra}:print_format=summary[aout]`);
  } else if (hasBGMusic) {
    // Original + bgmusic
    fc.push(`[0:a]highpass=f=80,lowpass=f=8000,volume=${CFG.origVol},aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[origa]`);
    fc.push(`[3:a]aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,volume=${CFG.bgVol},asetpts=PTS-STARTPTS[bga]`);
    fc.push(`[origa][bgmusic]amix=inputs=2:duration=first,volume=2.0[mixa]`);
    fc.push(`[mixa]loudnorm=I=${CFG.lufs}:TP=${CFG.truePeak}:LRA=${CFG.lra}:print_format=summary[aout]`);
  } else {
    // Original only
    fc.push(`[0:a]highpass=f=80,lowpass=f=8000,volume=${CFG.origVol},aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[maina]`);
    fc.push(`[maina]loudnorm=I=${CFG.lufs}:TP=${CFG.truePeak}:LRA=${CFG.lra}:print_format=summary[aout]`);
  }

  // ── assemble command ──────────────────────────────────────────────────────
  const effectiveDur = useDur / speedFactor;
  const fgPath = path.join(TEMP_DIR, `fg-${RUN_ID}.txt`);
  fs.writeFileSync(fgPath, fc.join(";"));

  const ffBin = ffmpegPath;
  const outputOptions = [
    "-map", "[vout]",
    "-map", "[aout]",
    "-c:v", "libx264",
    "-crf", CFG.crf,
    "-preset", CFG.preset,
    "-profile:v", "high",
    "-level", "4.1",
    "-pix_fmt", "yuv420p",
    "-r", String(CFG.fps),
    "-g", String(CFG.fps * 2),
    "-keyint_min", String(CFG.fps),
    "-sc_threshold", "0",
    "-threads", "0",
    "-c:a", "aac",
    "-b:a", "192k",
    "-ar", "48000",
    "-ac", "2",
    "-movflags", "+faststart",
    "-map_metadata", "-1",
    "-y",
  ];

  const args = [
    "-ss", startOffset.toFixed(2),
    "-t", useDur.toFixed(2),
    "-i", videoPath,
    "-i", bannerPath,
    "-i", bottomBannerPath,
  ];
  if (hasVoiceover) {
    args.push("-i", voiceover);
  }
  if (hasBGMusic) {
    args.push("-i", bgmusic);
  }
  args.push("-filter_complex_script", fgPath, ...outputOptions, outputPath);

  const { spawn } = require("child_process");
  const proc = spawn(ffBin, args);

  let stderrData = "";
  let lastPct = -1;

  proc.stderr.on("data", (d) => {
    const line = d.toString();
    stderrData += line;
    const m = line.match(/time=(\d{2}:\d{2}:\d{2}\.\d+)/);
    if (m && effectiveDur > 0) {
      const parts = m[1].split(":").map(Number);
      const elapsed = parts[0] * 3600 + parts[1] * 60 + parts[2];
      const pct = Math.min((elapsed / effectiveDur) * 100, 99.4);
      if (Math.floor(pct) > lastPct) {
        lastPct = Math.floor(pct);
        process.stdout.write(`  ${pct.toFixed(1)}%\r`);
      }
    }
  });

  return new Promise((resolve, reject) => {
    proc.on("close", (code) => {
      safeUnlink(fgPath, "filter graph");
      if (code === 0 && fs.existsSync(outputPath)) {
        fileSha256Hex(outputPath).then((hash) => {
          console.log(`  100% → ${path.basename(outputPath)} (sha256 ${hash.slice(0, 12)})`);
          safeUnlink(bannerPath, "banner");
          safeUnlink(bottomBannerPath, "bottom banner");
          resolve(outputPath);
        });
      } else {
        const err = stderrData.includes("Invalid argument")
          ? "ffmpeg filter_complex_script: Invalid argument (check graph)"
          : `ffmpeg exited code ${code}`;
        reject(new Error(err + "\n" + stderrData.slice(-500)));
      }
    });
    proc.on("error", (err) => {
      safeUnlink(fgPath, "filter graph");
      reject(err);
    });
  });
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const inputArg = args.find((a) => !a.startsWith("--"));
  const partIdx = args.indexOf("--part");
  const targetSec = partIdx >= 0 && args[partIdx + 1] ? Number(args[partIdx + 1]) : null;
  const partsIdx = args.indexOf("--parts");
  const partsCount = partsIdx >= 0 && args[partsIdx + 1] ? Math.max(1, Math.min(60, Number(args[partsIdx + 1]) || 1)) : 1;

  // Skip intro/outro — trim N seconds from start and end of each source
  const skipStartIdx = args.indexOf("--skip-start");
  const skipStart = skipStartIdx >= 0 && args[skipStartIdx + 1] ? Math.max(0, Number(args[skipStartIdx + 1])) : 60;
  const skipEndIdx = args.indexOf("--skip-end");
  const skipEnd = skipEndIdx >= 0 && args[skipEndIdx + 1] ? Math.max(0, Number(args[skipEndIdx + 1])) : 30;

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.mkdirSync(TEMP_DIR, { recursive: true });

  let inputFiles;
  if (inputArg && fs.existsSync(inputArg)) {
    inputFiles = [path.resolve(inputArg)];
  } else if (inputArg) {
    console.error(`Input not found: ${inputArg}`);
    process.exit(1);
  } else {
    inputFiles = (fs.readdirSync(INPUT_DIR) || [])
      .filter((f) => VIDEO_EXT.has(path.extname(f).toLowerCase()))
      .map((f) => path.join(INPUT_DIR, f))
      .sort();
  }

  if (inputFiles.length === 0) {
    console.error(`No video files found in ${INPUT_DIR}`);
    process.exit(1);
  }

  // Calculate random target length per source
  const randomTarget = targetSec || CFG.targetSeconds + Math.floor(Math.random() * (CFG.maxSeconds - CFG.minSeconds));

  console.log(`cartoonToReels — ${inputFiles.length} source file(s)`);
  console.log(`Output: ${OUTPUT_DIR}`);
  console.log(`Skip: ${skipStart}s start, ${skipEnd}s end | Target length: ${randomTarget}s | Speed: variable | Flip chance: ${CFG.flipChance * 100}% | Parts per source: ${partsCount}`);

  let ok = 0, fail = 0;

  for (const inputVideo of inputFiles) {
    const base = safeName(path.parse(inputVideo).name);
    const slug = base.replace(/tom_and_jerry_funny_video[_-]*/gi, "tmj-").replace(/_+/g, "-").slice(0, 50);

    // Get actual duration and compute trimmed range (skip intro/outro)
    const actualDur = await getDuration(inputVideo).catch(() => 0);
    if (actualDur <= 0) {
      console.error(`  ✗ Cannot probe duration: ${path.basename(inputVideo)}`);
      fail++;
      continue;
    }

    const trimStart = Math.min(skipStart, actualDur * 0.3);  // never skip more than 30% from start
    const trimEnd = Math.min(skipEnd, actualDur * 0.2);      // never skip more than 20% from end
    const usableDur = actualDur - trimStart - trimEnd;

    if (usableDur < CFG.minSeconds) {
      console.error(`  ✗ Too short after trim (${usableDur.toFixed(0)}s): ${path.basename(inputVideo)}`);
      fail++;
      continue;
    }

    let scopes = [null];
    if (partsCount > 1) {
      // Divide the trimmed range into equal parts
      const segLen = usableDur / partsCount;
      scopes = [];
      for (let p = 0; p < partsCount; p++) {
        scopes.push({
          start: trimStart + segLen * p,
          end: trimStart + segLen * (p + 1),
        });
      }
    } else {
      // Single part: use the full trimmed range
      scopes = [{ start: trimStart, end: actualDur - trimEnd }];
    }

    for (let p = 0; p < scopes.length; p++) {
      const partSec = targetSec || CFG.minSeconds + Math.floor(Math.random() * (CFG.maxSeconds - CFG.minSeconds));
      const n = String(ok + fail + 1).padStart(2, "0");
      const partTag = scopes.length > 1 ? `p${String(p + 1).padStart(2, "0")}-` : "";

      // Use hook text as filename (SEO-friendly)
      const [hookTop, hookBot] = HOOK_LINES[Math.floor(Math.random() * HOOK_LINES.length)];
      const hookSlug = hookTop
        .replace(/[^\w\s-]/g, "")
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
        .toLowerCase()
        .slice(0, 50);
      const outputPath = path.join(OUTPUT_DIR, `cartoonmornings-${hookSlug}-${partTag}${n}.mp4`);

      console.log(`\n▶ ${path.basename(inputVideo)}${scopes.length > 1 ? ` (part ${p + 1}/${scopes.length})` : ""}`);
      console.log(`  → ${path.basename(outputPath)} (target ${partSec}s, scope ${scopes[p].start.toFixed(0)}–${scopes[p].end.toFixed(0)}s)`);

      let forcedStart = null;
      if (scopes[p]) {
        try {
          const useDur = Math.min(usableDur, partSec);
          forcedStart = await pickDynamicStart(inputVideo, actualDur, useDur, scopes[p].start, scopes[p].end);
          console.log(`  scope ${scopes[p].start.toFixed(0)}–${scopes[p].end.toFixed(0)}s → cut @ ${forcedStart.toFixed(0)}s`);
        } catch (e) {
          console.log(`  (part-scan fallback: ${e.message})`);
          forcedStart = scopes[p].start;
        }
      }

      try {
        await processReel({ videoPath: inputVideo, outputPath, targetSeconds: partSec, startOffset: forcedStart, hookTop, hookBot });
        ok++;
      } catch (err) {
        fail++;
        console.error(`  ✗ ${err.message}`);
      }
    }
  }

  console.log(`\n${ok} succeeded, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;

  try {
    const tmpFiles = fs.readdirSync(TEMP_DIR);
    for (const f of tmpFiles) safeUnlink(path.join(TEMP_DIR, f), "temp");
  } catch (_) {}
}

main().catch((e) => { console.error(e); process.exit(1); });
