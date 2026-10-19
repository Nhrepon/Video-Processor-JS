// node src/scripts/cartoonToReels.js --parts 5

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
const OUTPUT_DIR  = path.join(__dirname, "..", "output");
const TEMP_DIR    = path.join(__dirname, "..", "output", "temp");
const ASSETS_DIR  = path.join(__dirname, "..", "assets");
const FONT_FILE  = path.join(ASSETS_DIR, "RacingSansOne-Regular.ttf");
const VOICEOVER_DIR = path.join(__dirname, "..", "audio", "voiceover");
const BGMUSIC_DIR  = path.join(__dirname, "..", "audio");
const CONTENT_JSON = path.join(__dirname, "cartoonToReels.content.json");

// Locate a Chromium-family browser for HTML→PNG banner rendering. Falls back to
// the PIL renderer if none is found.
function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  ].filter(Boolean);
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch (_) {}
  }
  return null;
}
const CHROME_BIN = findChrome();

const RUN_ID = `${Date.now().toString(36)}-${process.pid}`;
const VIDEO_EXT = new Set([".mp4", ".mov", ".mkv", ".webm"]);

// ─── reel config ─────────────────────────────────────────────────────────────

const Config = {
  width:         1080,
  height:        1920,
  fps:           30,
  crf:           "21",
  preset:        "fast",
  // Shorter clips = better retention + harder copyright match
  targetSeconds:  25,
  minSeconds:     15,
  maxSeconds:     45,
  // Skip intro/outro — seconds trimmed off the start and end of each input
  // video before cutting reels (avoids title cards, watermarks, credits).
  // Overridable per-run with --skip-start / --skip-end.
  trimStart:      50,
  trimEnd:        50,
  // Splice the reel from N separate short clips (montage = better retention +
  // harder copyright match). 1 = single continuous cut.
  clips:          3,
  showBanner:     true,   // top hook banner + bottom reaction banner overlays
  showLogo:       true,   // brand logo overlay
  // Layout when banner is on:
  //   true  = STACKED — the hook banner takes its own top band (bannerHeight) and
  //           the reaction banner takes a bottom band (bottomBannerHeight); the
  //           video is fit into the space between them (nothing hidden).
  //   false = OVERLAY — video fills the whole frame and the banners sit on top of it.
  bannerStacked:  true,

    // Banner (covers NHREPON watermark top-right area)
  bannerHeight:  400,
  bottomBannerHeight: 220,   // reserved bottom band for the reaction pill (stacked mode)
  bannerPadH:    40,
  bannerPadB:    20,
  bannerOpacity: 0.95,
  bannerTopPad:  165,   // gap from top of banner before the hook text (clears the logo)

  // Logo overlay (only when showLogo) — pinned to the top-right corner
  logoPath:     path.join(__dirname, "..", "assets", "cartoon-mornings.png"),
  logoWidth:    150,
  logoMargin:   20,

  // Variable speed — random per reel (0.9x to 1.25x)
  speedOptions:  [0.9, 0.95, 1.0, 1.05, 1.1, 1.15, 1.25],
  speedFactor:   1.10,  // default if not randomized

  // Flip ~30% of reels (mirror = alters fingerprint)
  flipChance:     0.30,

  // Grab a random section of the source every run (true), or always use the
  // most dynamic window the scan finds (false).
  randomStart:    true,

  // Color grade variations (warm, vibrant — distinct from raw source)
  grades: [
    "eq=contrast=1.12:brightness=0.03:saturation=1.18:gamma_r=1.04:gamma_g=1.00:gamma_b=0.92",
    "eq=contrast=1.15:brightness=0.05:saturation=1.22:gamma_r=1.06:gamma_g=1.02:gamma_b=0.94",
    "eq=contrast=1.10:brightness=0.02:saturation=1.15:gamma_r=1.02:gamma_g=0.98:gamma_b=0.90",
    "eq=contrast=1.18:brightness=0.04:saturation=1.20:gamma_r=1.08:gamma_g=1.04:gamma_b=0.96",
  ],

  // Audio
  origVol:       0.85,        // original audio volume (reduced for voiceover)
  voiceVol:      0.35,        // voiceover volume
  bgVol:         0.09,        // background music volume (if present)
  lufs:         "-14",
  truePeak:      "-1.5",
  lra:           "11",


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

const BUILTIN_HOOKS = [
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
const BUILTIN_REACTIONS = [
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

// ─── content library (hooks, reactions, themes) ──────────────────────────────
// Prefer cartoonToReels.content.json (copy can be edited/expanded without
// touching code); fall back to the built-in arrays above if the file is missing.

const BUILTIN_THEMES = [
  { name: "neon-pink", grad: ["#ff2d95", "#7b2ff7"], accent: "#ffe066", glow: "rgba(255,45,149,0.55)" },
  { name: "inferno",   grad: ["#f83600", "#fe8c00"], accent: "#fff3b0", glow: "rgba(248,54,0,0.5)" },
  { name: "electric",  grad: ["#00c6ff", "#0072ff"], accent: "#a6ff00", glow: "rgba(0,198,255,0.5)" },
];

function loadContent() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONTENT_JSON, "utf8"));
    return {
      hooks:     Array.isArray(raw.hooks)     && raw.hooks.length     ? raw.hooks     : BUILTIN_HOOKS,
      reactions: Array.isArray(raw.reactions) && raw.reactions.length ? raw.reactions : BUILTIN_REACTIONS,
      themes:    Array.isArray(raw.themes)    && raw.themes.length    ? raw.themes    : BUILTIN_THEMES,
    };
  } catch (e) {
    console.warn(`  content JSON not loaded (${e.message}) — using built-in copy`);
    return { hooks: BUILTIN_HOOKS, reactions: BUILTIN_REACTIONS, themes: BUILTIN_THEMES };
  }
}

const CONTENT    = loadContent();
const HOOK_LINES = CONTENT.hooks;
const REACTIONS  = CONTENT.reactions;
const THEMES     = CONTENT.themes;

function pickRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function pickTheme() { return pickRandom(THEMES); }

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
W, H = ${Config.width}, ${Config.bannerHeight}
img = Image.new("RGBA", (W, H), (0, 0, 0, int(255 * ${Config.bannerOpacity})))
d = ImageDraw.Draw(img)
top = "${hookTop.replace(/"/g, '\\"')}"
bot = "${hookBot.replace(/"/g, '\\"')}"

font_top = fit_font(d, top, W - 80, 72, 40)
font_bot = fit_font(d, bot, W - 80, 56, 34)

tb_w = d.textlength(top, font=font_top)
tb_h = font_top.size
d.text(((W-tb_w)//2, ${Config.bannerTopPad}), top, font=font_top, fill=(255,255,255,255))

bb_w = d.textlength(bot, font=font_bot)
bb_h = font_bot.size
d.text(((W-bb_w)//2, ${Config.bannerTopPad} + tb_h + 10), bot, font=font_bot, fill=(255,224,102,255))

img.save(sys.argv[1], "PNG")

# --- bottom banner (reaction) ---
BW, BH = ${Config.width}, 220
bimg = Image.new("RGBA", (BW, BH), (0, 0, 0, 0))
bd = ImageDraw.Draw(bimg)
for y in range(40):
    a = int(255 * (y / 40) * 0.92)
    bd.line([(0, y), (BW, y)], fill=(0, 0, 0, a))
bd.rectangle([(0, 40), (BW, BH)], fill=(0, 0, 0, int(255 * 0.92)))
font_r = load_font(${Config.reactSize})
rt = "${bottomText.replace(/"/g, '\\"')}"
rw = bd.textlength(rt, font=font_r)
bd.text(((BW-rw)//2, 40 + (BH-40-${Config.reactSize})//2), rt, font=font_r, fill=(255,255,255,255))
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

// ─── HTML banner overlay (Chrome headless → transparent full-canvas PNG) ──────
// Renders the top hook banner, bottom reaction pill and brand logo onto ONE
// 1080×1920 transparent PNG using HTML/CSS, so we get gradients, rounded
// corners, glow and proper color-emoji — then ffmpeg overlays it once. Falls
// back to PIL (no Chrome) which composes a simpler full-canvas PNG.

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fileUrl(p) {
  return "file:///" + p.replace(/\\/g, "/").replace(/ /g, "%20");
}

// Pick a readable font-size that keeps the line inside the banner width.
function hookSize(text, big, small) {
  const n = text.length;
  if (n > 46) return small;
  if (n > 30) return Math.round((big + small) / 2);
  return big;
}

function buildOverlayHTML({ hookTop, hookBot, bottomText, theme, showBanner, showLogo, logoPath, stacked }) {
  const g0 = theme.grad[0], g1 = theme.grad[1] || theme.grad[0];
  const accent = theme.accent, glow = theme.glow, text = "#ffffff";
  const topSize = hookSize(hookTop, 58, 40);
  const botSize = hookSize(hookBot, 42, 30);
  const rSize   = Config.reactSize;

  // STACKED → banner is a fixed-height band that exactly matches the reserved
  // area in ffmpeg (square corners so no black peeks through). OVERLAY → banner
  // grows to fit text and has rounded bottom corners that sit over the video.
  const topBoxCss = stacked
    ? `height:${Config.bannerHeight}px;overflow:hidden;`
    : `min-height:${Config.bannerHeight}px;border-bottom-left-radius:36px;border-bottom-right-radius:36px;`;
  const topPadCss = stacked
    ? `padding:0 ${Config.bannerPadH}px;justify-content:center;`
    : `padding:${Config.bannerTopPad}px ${Config.bannerPadH}px 46px;justify-content:flex-start;`;

  // STACKED → reaction is its own fixed-height bottom band (dark, centered pill).
  // OVERLAY → reaction fades in over the video bottom (gradient to transparent).
  const botCss = stacked
    ? `.bot{position:absolute;left:0;bottom:0;width:100%;height:${Config.bottomBannerHeight}px;overflow:hidden;
  background:linear-gradient(to bottom,rgba(0,0,0,.9),rgba(0,0,0,.96));
  box-shadow:inset 0 3px 0 rgba(255,255,255,.18);
  display:flex;align-items:center;justify-content:center;text-align:center;}`
    : `.bot{position:absolute;left:0;bottom:0;width:100%;padding:90px ${Config.bannerPadH}px ${Config.reactMarginB}px;
  background:linear-gradient(to top,rgba(0,0,0,.92) 50%,rgba(0,0,0,0));text-align:center;}`;

  const topBlock = showBanner ? `
    <div class="top">
      <div class="h1">${escapeHtml(hookTop)}</div>
      <div class="h2">${escapeHtml(hookBot)}</div>
    </div>` : "";

  const botBlock = showBanner ? `
    <div class="bot"><span class="r">${escapeHtml(bottomText)}</span></div>` : "";

  const logoBlock = (showLogo && logoPath) ? `<img class="logo" src="${fileUrl(logoPath)}">` : "";

  return `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:'RSO';src:url('${fileUrl(FONT_FILE)}');}
html,body{margin:0;padding:0;width:${Config.width}px;height:${Config.height}px;background:transparent;}
*{font-family:'RSO','Segoe UI','Segoe UI Emoji',Arial,sans-serif;-webkit-font-smoothing:antialiased;box-sizing:border-box;}
.top{position:absolute;left:0;top:0;width:100%;${topBoxCss}${topPadCss}
  background:linear-gradient(135deg,${g0},${g1});
  box-shadow:0 12px 44px ${glow},inset 0 -3px 0 rgba(255,255,255,.28),inset 0 3px 0 rgba(255,255,255,.22);
  display:flex;flex-direction:column;align-items:center;text-align:center;}
.top .h1{font-size:${topSize}px;line-height:1.04;font-weight:800;text-transform:uppercase;color:${text};
  letter-spacing:.5px;text-shadow:0 3px 0 rgba(0,0,0,.35),0 0 26px rgba(0,0,0,.45);}
.top .h2{margin-top:16px;font-size:${botSize}px;font-weight:800;text-transform:uppercase;color:${accent};
  line-height:1.05;text-shadow:0 2px 8px rgba(0,0,0,.55);}
${botCss}
.bot .r{display:inline-block;font-size:${rSize}px;font-weight:800;color:#fff;padding:12px 30px;
  border:3px solid ${accent};border-radius:999px;background:rgba(0,0,0,.4);
  box-shadow:0 0 26px ${glow};text-shadow:0 2px 10px rgba(0,0,0,.85);}
.logo{position:absolute;top:${Config.logoMargin}px;right:${Config.logoMargin}px;width:${Config.logoWidth}px;height:auto;z-index:5;
  filter:drop-shadow(0 3px 9px rgba(0,0,0,.65));}
</style></head><body>
${topBlock}
${botBlock}
${logoBlock}
</body></html>`;
}

function renderOverlayHTML(opts, outPath, htmlPath) {
  const { execFileSync } = require("child_process");
  fs.writeFileSync(htmlPath, buildOverlayHTML(opts), "utf8");
  execFileSync(CHROME_BIN, [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    "--default-background-color=00000000",
    "--allow-file-access-from-files",
    "--virtual-time-budget=4000",
    `--window-size=${Config.width},${Config.height}`,
    `--screenshot=${outPath}`,
    fileUrl(htmlPath),
  ], { windowsHide: true, timeout: 60000 });
  if (!fs.existsSync(outPath)) throw new Error("Chrome produced no screenshot");
}

// PIL fallback: single full-canvas PNG (solid translucent banner boxes + text,
// no emoji/gradient) so the ffmpeg graph stays identical whether Chrome is used
// or not.
function renderOverlayPIL(opts, outPath) {
  const { execSync } = require("child_process");
  const pyBin = "C:/Users/RHYTHM CARE LTD/AppData/Local/Programs/Python/Python314/python.exe";
  const g0 = opts.theme.grad[0], accent = opts.theme.accent;
  const hexA = (hex) => {
    const h = hex.replace("#", "");
    const v = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
    return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
  };
  const [ar, ag, ab] = hexA(accent);
  const script = `
import sys
from PIL import Image, ImageDraw, ImageFont

W, H = ${Config.width}, ${Config.height}
img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

def load_font(size):
    for fp in [r"${FONT_FILE.replace(/\\/g, "\\\\")}", r"C:\\\\Windows\\\\Fonts\\\\arialbd.ttf"]:
        try: return ImageFont.truetype(fp, size)
        except: pass
    return ImageFont.load_default()

def wrap(draw, text, font, max_w):
    words, lines, cur = text.split(" "), [], ""
    for w in words:
        t = (cur + " " + w).strip()
        if draw.textlength(t, font=font) <= max_w: cur = t
        else:
            if cur: lines.append(cur)
            cur = w
    if cur: lines.append(cur)
    return lines

SHOW_BANNER = ${opts.showBanner ? "True" : "False"}
SHOW_LOGO = ${opts.showLogo ? "True" : "False"}
if SHOW_BANNER:
    BH = ${Config.bannerHeight}
    d.rectangle([(0, 0), (W, BH)], fill=(${g0.slice(1, 3) ? hexA(g0).join(",") : "0,0,0"}, ${int(255 * Config.bannerOpacity)}))
    top = ${JSON.stringify(opts.hookTop)}
    bot = ${JSON.stringify(opts.hookBot)}
    ft = load_font(60)
    y = ${Config.bannerTopPad}
    for line in wrap(d, top, ft, W - 120):
        lw = d.textlength(line, font=ft)
        d.text(((W - lw) // 2, y), line, font=ft, fill=(255, 255, 255, 255))
        y += ft.size + 6
    fb = load_font(44)
    for line in wrap(d, bot, fb, W - 120):
        lw = d.textlength(line, font=fb)
        d.text(((W - lw) // 2, y), line, font=fb, fill=(${ar}, ${ag}, ${ab}, 255))
        y += fb.size + 4
    # bottom reaction bar
    RH = 220
    d.rectangle([(0, H - RH), (W, H)], fill=(0, 0, 0, ${int(255 * 0.92)}))
    rt = ${JSON.stringify(opts.bottomText)}
    fr = load_font(${Config.reactSize})
    lw = d.textlength(rt, font=fr)
    d.text(((W - lw) // 2, H - RH + (RH - ${Config.reactSize}) // 2), rt, font=fr, fill=(255, 255, 255, 255))
if SHOW_LOGO:
    lp = r"${(opts.logoPath || "").replace(/\\/g, "\\\\")}"
    try:
        logo = Image.open(lp).convert("RGBA")
        lw_px = ${Config.logoWidth}
        lh_px = int(logo.height * (lw_px / logo.width))
        logo = logo.resize((lw_px, lh_px))
        img.paste(logo, (W - lw_px - ${Config.logoMargin}, ${Config.logoMargin}), logo)
    except Exception:
        pass

img.save(sys.argv[1], "PNG")
`.trim();
  const scriptPath = path.join(TEMP_DIR, `overlay-pil-${RUN_ID}.py`);
  fs.writeFileSync(scriptPath, script, "utf8");
  execSync(`"${pyBin}" "${scriptPath}" "${outPath}"`, { windowsHide: true });
  safeUnlink(scriptPath, "overlay-pil script");
  if (!fs.existsSync(outPath)) throw new Error("PIL produced no overlay");
}

// Entry point: render one full-canvas overlay PNG for a reel.
async function renderOverlay(opts) {
  const outPath = path.join(TEMP_DIR, `overlay-${RUN_ID}-${Date.now().toString(36)}.png`);
  if (CHROME_BIN) {
    const htmlPath = path.join(TEMP_DIR, `overlay-${RUN_ID}-${Date.now().toString(36)}.html`);
    try {
      renderOverlayHTML(opts, outPath, htmlPath);
      safeUnlink(htmlPath, "overlay html");
      return outPath;
    } catch (e) {
      console.warn(`  HTML overlay failed (${e.message}) — falling back to PIL`);
      safeUnlink(htmlPath, "overlay html");
    }
  }
  renderOverlayPIL(opts, outPath);
  return outPath;
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

// ─── pick a random section (varies every run) ────────────────────────────────
// The dynamic-start scan always returns the same window for a given source, so
// every run would reuse the exact same frames. Picking a random start within
// the scope gives fresh footage each run (and a different copyright match).
function pickRandomStart(totalDur, windowDur, scopeStart = 0, scopeEnd = null) {
  const hi = scopeEnd === null ? totalDur : Math.min(scopeEnd, totalDur);
  const lo = Math.max(0, scopeStart);
  const maxStart = Math.max(lo, hi - windowDur);
  if (maxStart <= lo) return lo;
  return lo + Math.random() * (maxStart - lo);
}

// Resolve the best start for a window: random per run (Config.randomStart),
// otherwise the most dynamic section.
async function pickStart(videoPath, totalDur, windowDur, scopeStart = 0, scopeEnd = null) {
  if (Config.randomStart) return pickRandomStart(totalDur, windowDur, scopeStart, scopeEnd);
  return pickDynamicStart(videoPath, totalDur, windowDur, scopeStart, scopeEnd);
}

// ─── main video processor ───────────────────────────────────────────────────

async function processReel({ videoPath, outputPath, targetSeconds, startOffset: forcedStart, clipStarts = null, hookTop = null, hookBot = null }) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });

  const dur = await getDuration(videoPath);
  if (dur <= 0) throw new Error(`Cannot probe duration of ${videoPath}`);

  // Random transform parameters for this reel
  const speedFactor = Config.speedOptions[Math.floor(Math.random() * Config.speedOptions.length)];
  const flip = Math.random() < Config.flipChance;
  const grade = Config.grades[Math.floor(Math.random() * Config.grades.length)];
  const voiceover = pickVoiceover();
  const bgmusic = pickBGMusic();

  const useDur = Math.min(dur, targetSeconds || Config.targetSeconds);
  let startOffset = dur > useDur ? (dur - useDur) / 2 : 0;
  if (forcedStart !== undefined && forcedStart !== null) {
    startOffset = Math.max(0, Math.min(forcedStart, dur - useDur));
  } else {
    try {
      startOffset = await pickStart(videoPath, dur, useDur);
    } catch (e) {
      console.log(`  (dynamic-start fallback: ${e.message})`);
    }
  }

  // Resolve clip segments: montage of N short cuts, or a single continuous cut.
  // clipStarts (from main) is [{ start, dur }...]; fall back to one segment.
  const clipSegs = (clipStarts && clipStarts.length)
    ? clipStarts.map((s) => ({
        start: Math.max(0, Math.min(s.start, dur - s.dur)),
        dur: Math.min(s.dur, dur),
      }))
    : [{ start: startOffset, dur: useDur }];
  const multiClip = clipSegs.length > 1;
  const inSs = Math.min(...clipSegs.map((s) => s.start));
  const inEnd = Math.max(...clipSegs.map((s) => s.start + s.dur));
  const readT = inEnd - inSs;

  // Pick hook banner text + reaction text (use provided hook if available)
  const [finalHookTop, finalHookBot] = hookTop && hookBot ? [hookTop, hookBot] : pickRandom(HOOK_LINES);
  const reactText = pickRandom(REACTIONS);
  const theme = pickTheme();

  const useBanner = Config.showBanner;
  const useLogo = Config.showLogo && fs.existsSync(Config.logoPath);
  // Stacked layout reserves a bannerHeight band at the top and fits the video
  // into the space below it (only meaningful when the banner is actually shown).
  const stackedBand = Config.bannerStacked && useBanner;
  const bandH = stackedBand ? Config.bannerHeight : 0;
  const bottomBandH = stackedBand ? Config.bottomBannerHeight : 0;

  // Render ONE full-canvas transparent overlay PNG (top banner + bottom reaction
  // pill + brand logo). HTML/CSS via Chrome when available, else PIL fallback.
  let overlayPath = null;
  if (useBanner || useLogo) {
    overlayPath = await renderOverlay({
      hookTop: finalHookTop,
      hookBot: finalHookBot,
      bottomText: reactText,
      theme,
      showBanner: useBanner,
      showLogo: useLogo,
      logoPath: Config.logoPath,
      stacked: stackedBand,
    });
    if (!overlayPath || !fs.existsSync(overlayPath)) throw new Error(`Overlay generation failed: ${overlayPath}`);
  }

  // Plan reaction text overlays
  const reactions = planReactions(useDur / speedFactor);

  // ── input index map (overlay / voiceover / bgmusic are optional) ──
  let nextIdx = 1; // 0 = main video
  const hasVoiceover = voiceover && fs.existsSync(voiceover);
  const hasBGMusic = bgmusic && fs.existsSync(bgmusic);
  const overlayIdx  = overlayPath ? nextIdx++ : null;
  const voIdx       = hasVoiceover ? nextIdx++ : null;
  const bgIdx       = hasBGMusic   ? nextIdx++ : null;

  // Build filter graph
  const fc = [];

  // 1. Video: scale to cover the frame, color grade, random flip. In STACKED
  //    mode the video only fills the space BETWEEN the top banner band and the
  //    bottom reaction band (height minus bandH minus bottomBandH) and is padded
  //    down by bandH, so nothing sits behind either banner.
  //    For a montage we trim N short segments and concat them; else one cut.
  const videoH = Config.height - bandH - bottomBandH;
  const vfBase =
    `scale=${Config.width}:${videoH}:force_original_aspect_ratio=increase,` +
    `crop=${Config.width}:${videoH},` +
    `${grade},` +
    `setsar=1` +
    (flip ? `,hflip` : ``) +
    (bandH > 0 || bottomBandH > 0 ? `,pad=${Config.width}:${Config.height}:0:${bandH}:color=black` : ``);

  if (multiClip) {
    const labels = [];
    clipSegs.forEach((s, i) => {
      const a = (s.start - inSs).toFixed(3);
      const b = (s.start - inSs + s.dur).toFixed(3);
      fc.push(`[0:v]trim=start=${a}:end=${b},setpts=(PTS-STARTPTS)/${speedFactor},${vfBase}[c${i}]`);
      labels.push(`[c${i}]`);
    });
    fc.push(`${labels.join("")}concat=n=${clipSegs.length}:v=1:a=0[main]`);
  } else {
    fc.push(`[0:v]setpts=PTS/${speedFactor},${vfBase}[main]`);
  }

  // 2. Overlay the single full-canvas PNG (top banner + bottom reaction + logo).
  //    The PNG is Config.width×Config.height, so a 0:0 overlay aligns exactly.
  let cur = "[main]";
  if (overlayIdx !== null) {
    fc.push(`[${overlayIdx}:v]format=rgba,setsar=1[ovl]`);
    fc.push(`${cur}[ovl]overlay=0:0:format=auto:eof_action=pass[vout]`);
  } else {
    fc.push(`${cur}setsar=1[vout]`);
  }

  // 4. Audio: original (concat'd per clip when montaged) + voiceover + bgmusic mix.
  const origAudioChain = `highpass=f=80,lowpass=f=8000,volume=${Config.origVol},aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo`;

  if (multiClip) {
    const alabels = [];
    clipSegs.forEach((s, i) => {
      const a = (s.start - inSs).toFixed(3);
      const b = (s.start - inSs + s.dur).toFixed(3);
      fc.push(`[0:a]atrim=start=${a}:end=${b},asetpts=PTS-STARTPTS,atempo=${speedFactor}[ac${i}]`);
      alabels.push(`[ac${i}]`);
    });
    fc.push(`${alabels.join("")}concat=n=${clipSegs.length}:v=0:a=1[acat]`);
    fc.push(`[acat]${origAudioChain}[origa]`);
  } else {
    fc.push(`[0:a]${origAudioChain}[origa]`);
  }

  if (hasVoiceover && hasBGMusic) {
    fc.push(`[${voIdx}:a]aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,volume=${Config.voiceVol},asetpts=PTS-STARTPTS[voa]`);
    fc.push(`[${bgIdx}:a]aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,volume=${Config.bgVol},asetpts=PTS-STARTPTS[bga]`);
    fc.push(`[origa][voa][bga]amix=inputs=3:duration=first,volume=3.0[mixa]`);
    fc.push(`[mixa]loudnorm=I=${Config.lufs}:TP=${Config.truePeak}:LRA=${Config.lra}:print_format=summary[aout]`);
  } else if (hasVoiceover) {
    fc.push(`[${voIdx}:a]aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,volume=${Config.voiceVol},asetpts=PTS-STARTPTS[voa]`);
    fc.push(`[origa][voa]amix=inputs=2:duration=first,volume=2.0[mixa]`);
    fc.push(`[mixa]loudnorm=I=${Config.lufs}:TP=${Config.truePeak}:LRA=${Config.lra}:print_format=summary[aout]`);
  } else if (hasBGMusic) {
    fc.push(`[${bgIdx}:a]aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,volume=${Config.bgVol},asetpts=PTS-STARTPTS[bga]`);
    fc.push(`[origa][bga]amix=inputs=2:duration=first,volume=2.0[mixa]`);
    fc.push(`[mixa]loudnorm=I=${Config.lufs}:TP=${Config.truePeak}:LRA=${Config.lra}:print_format=summary[aout]`);
  } else {
    fc.push(`[origa]loudnorm=I=${Config.lufs}:TP=${Config.truePeak}:LRA=${Config.lra}:print_format=summary[aout]`);
  }

  // ── assemble command ──────────────────────────────────────────────────────
  const sumClipDur = clipSegs.reduce((a, s) => a + s.dur, 0);
  const effectiveDur = sumClipDur / speedFactor;
  const fgPath = path.join(TEMP_DIR, `fg-${RUN_ID}.txt`);
  fs.writeFileSync(fgPath, fc.join(";"));

  const ffBin = ffmpegPath;
  const outputOptions = [
    "-map", "[vout]",
    "-map", "[aout]",
    "-c:v", "libx264",
    "-crf", Config.crf,
    "-preset", Config.preset,
    "-profile:v", "high",
    "-level", "4.1",
    "-pix_fmt", "yuv420p",
    "-r", String(Config.fps),
    "-g", String(Config.fps * 2),
    "-keyint_min", String(Config.fps),
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
    "-ss", inSs.toFixed(2),
    "-t", readT.toFixed(2),
    "-i", videoPath,
  ];
  if (overlayIdx !== null) {
    // looped still image → streams for the whole clip, overlay stops at main EOF
    args.push("-loop", "1", "-framerate", String(Config.fps), "-i", overlayPath);
  }
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
          safeUnlink(overlayPath, "overlay");
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

// ─── source trim (intro/outro) ───────────────────────────────────────────────
// Physically cut trimStart seconds off the head and trimEnd off the tail of a
// source into a fast stream-copied working file, so the reel process runs on the
// already-trimmed video (shorts never include the skipped intro/outro). The
// working file lands in TEMP_DIR and is cleaned up at the end of the run.
function trimSource(inputVideo, trimStart, trimEnd) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("md5").update(`${inputVideo}|${trimStart}|${trimEnd}`).digest("hex").slice(0, 10);
    const outPath = path.join(TEMP_DIR, `trimmed-${hash}.mp4`);
    getDuration(inputVideo).then((dur) => {
      const keep = Math.max(1, dur - trimStart - trimEnd);
      const args = [
        "-ss", trimStart.toFixed(2),
        "-i", inputVideo,
        "-t", keep.toFixed(2),
        "-c", "copy",
        "-avoid_negative_ts", "make_zero",
        "-map", "0", "-dn", "-sn",
        "-y", outPath,
      ];
      const { spawn } = require("child_process");
      const proc = spawn(ffmpegPath, args);
      let err = "";
      proc.stderr.on("data", (d) => (err += d.toString()));
      proc.on("close", (code) => {
        if (code === 0 && fs.existsSync(outPath)) resolve(outPath);
        else reject(new Error(`ffmpeg trim exit ${code}: ${err.slice(-200)}`));
      });
      proc.on("error", reject);
    }).catch(reject);
  });
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  // The first token that isn't a flag OR the value of a flag is the input path.
  // (Otherwise `--parts 3` would mistake "3" for the input file.)
  const VALUE_FLAGS = new Set(["--part", "--parts", "--skip-start", "--skip-end"]);
  let inputArg = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      if (VALUE_FLAGS.has(a)) i++; // skip this flag's value
      continue;
    }
    inputArg = a;
    break;
  }
  const partIdx = args.indexOf("--part");
  const targetSec = partIdx >= 0 && args[partIdx + 1] ? Number(args[partIdx + 1]) : null;
  const partsIdx = args.indexOf("--parts");
  const partsCount = partsIdx >= 0 && args[partsIdx + 1] ? Math.max(1, Math.min(60, Number(args[partsIdx + 1]) || 1)) : 1;

  // Skip intro/outro — trim N seconds from start and end of each source.
  // Defaults come from Config.trimStart / Config.trimEnd; --skip-start/--skip-end override.
  const skipStartIdx = args.indexOf("--skip-start");
  const skipStart = skipStartIdx >= 0 && args[skipStartIdx + 1] ? Math.max(0, Number(args[skipStartIdx + 1])) : Math.max(0, Config.trimStart || 0);
  const skipEndIdx = args.indexOf("--skip-end");
  const skipEnd = skipEndIdx >= 0 && args[skipEndIdx + 1] ? Math.max(0, Number(args[skipEndIdx + 1])) : Math.max(0, Config.trimEnd || 0);

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
  const randomTarget = targetSec || Config.targetSeconds + Math.floor(Math.random() * (Config.maxSeconds - Config.minSeconds));

  console.log(`cartoonToReels — ${inputFiles.length} source file(s)`);
  console.log(`Output: ${OUTPUT_DIR}`);
  console.log(`Skip: ${skipStart}s start, ${skipEnd}s end | Target length: ${randomTarget}s | Clips/reel: ${Config.clips} | Start: ${Config.randomStart ? "random" : "dynamic"} | Speed: variable | Flip chance: ${Config.flipChance * 100}% | Banner: ${Config.showBanner}${Config.showBanner ? ` (${Config.bannerStacked ? `stacked ${Config.bannerHeight}px band` : "overlay"})` : ``} | Logo: ${Config.showLogo} | Parts per source: ${partsCount}`);

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

    if (usableDur < Config.minSeconds) {
      console.error(`  ✗ Too short after trim (${usableDur.toFixed(0)}s): ${path.basename(inputVideo)}`);
      fail++;
      continue;
    }

    // Physically trim intro/outro into a working file, then run the reel process
    // on that trimmed video (so shorts never include the skipped head/tail).
    let srcPath, srcDur;
    try {
      srcPath = await trimSource(inputVideo, trimStart, trimEnd);
      srcDur = await getDuration(srcPath);
      console.log(`  trimmed ${trimStart.toFixed(0)}s intro + ${trimEnd.toFixed(0)}s outro → ${srcDur.toFixed(0)}s working file`);
    } catch (e) {
      console.error(`  ✗ Trim failed: ${e.message}`);
      fail++;
      continue;
    }
    if (srcDur < Config.minSeconds) {
      console.error(`  ✗ Working file too short (${srcDur.toFixed(0)}s): ${path.basename(inputVideo)}`);
      fail++;
      continue;
    }

    let scopes;
    if (partsCount > 1) {
      // Divide the trimmed working file into equal parts
      const segLen = srcDur / partsCount;
      scopes = [];
      for (let p = 0; p < partsCount; p++) {
        scopes.push({ start: segLen * p, end: segLen * (p + 1) });
      }
    } else {
      // Single part: the whole trimmed working file
      scopes = [{ start: 0, end: srcDur }];
    }

    for (let p = 0; p < scopes.length; p++) {
      const partSec = targetSec || Config.minSeconds + Math.floor(Math.random() * (Config.maxSeconds - Config.minSeconds));
      const n = String(ok + fail + 1).padStart(2, "0");
      const partTag = scopes.length > 1 ? `p${String(p + 1).padStart(2, "0")}-` : "";

      // Use hook text as filename (SEO-friendly), with source-file hash
      // to prevent cross-source overwrite (counter resets per run, so
      // source-1's p01-01 overwrites source-2's p01-01 without a hash).
      const srcHash = crypto.createHash("md5").update(inputVideo).digest("hex").slice(0, 6);
      const [hookTop, hookBot] = HOOK_LINES[Math.floor(Math.random() * HOOK_LINES.length)];
      const hookSlug = hookTop
        .replace(/[^\w\s-]/g, "")
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
        .toLowerCase()
        .slice(0, 40);
      const outputPath = path.join(OUTPUT_DIR, `cartoonmornings-${hookSlug}-${srcHash}-${partTag}${n}.mp4`);

      console.log(`\n▶ ${path.basename(inputVideo)}${scopes.length > 1 ? ` (part ${p + 1}/${scopes.length})` : ""}`);
      console.log(`  → ${path.basename(outputPath)} (target ${partSec}s, scope ${scopes[p].start.toFixed(0)}–${scopes[p].end.toFixed(0)}s)`);

      const clipCount = Math.max(1, Config.clips || 1);
      let forcedStart = null;
      let clipStarts = null;
      const scope = scopes[p] || { start: 0, end: srcDur };

      if (clipCount > 1) {
        // Montage: divide this part's scope into N chunks and grab a window from
        // each (random per run when Config.randomStart), so the reel splices N
        // short cuts.
        const clipDur = Math.max(2, (partSec / clipCount));
        const chunkLen = (scope.end - scope.start) / clipCount;
        clipStarts = [];
        for (let c = 0; c < clipCount; c++) {
          const chunkStart = scope.start + chunkLen * c;
          const chunkEnd = scope.start + chunkLen * (c + 1);
          let cs = chunkStart;
          try {
            cs = await pickStart(srcPath, srcDur, clipDur, chunkStart, chunkEnd);
          } catch (e) {
            cs = chunkStart;
          }
          cs = Math.max(0, Math.min(cs, srcDur - clipDur));
          clipStarts.push({ start: cs, dur: clipDur });
        }
        console.log(`  montage ${clipCount}×${clipDur.toFixed(1)}s @ ${clipStarts.map((s) => s.start.toFixed(0)).join(", ")}s`);
      } else if (scopes[p]) {
        try {
          const useDur = Math.min(srcDur, partSec);
          forcedStart = await pickStart(srcPath, srcDur, useDur, scopes[p].start, scopes[p].end);
          console.log(`  scope ${scopes[p].start.toFixed(0)}–${scopes[p].end.toFixed(0)}s → cut @ ${forcedStart.toFixed(0)}s`);
        } catch (e) {
          console.log(`  (part-scan fallback: ${e.message})`);
          forcedStart = scopes[p].start;
        }
      }

      try {
        await processReel({ videoPath: srcPath, outputPath, targetSeconds: partSec, startOffset: forcedStart, clipStarts, hookTop, hookBot });
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
