/**
 * Stage 6-7: reframe the picture and mux the English audio + subtitles.
 *
 * Visual treatment is deliberately a re-framing of the source you supplied --
 * crop to the target aspect, add slow Ken Burns motion, colour grade, and
 * optional brand/overlay elements from your existing asset folders. Reuse of
 * the underlying footage remains subject to whatever rights you have in it;
 * see README.md.
 *
 * Run:  node src/B2E/reframe.js --video <src.mp4> --audio <english.wav> \
 *         --srt <english.srt> --out <out.mp4>
 */
const fs = require("fs");
const path = require("path");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("@ffmpeg-installer/ffmpeg").path;
const ffprobePath = require("@ffprobe-installer/ffprobe").path;
const { escapeDrawtext, timemarkToSeconds } = require("../utility/utility");

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

const ASSETS_DIR = path.join(__dirname, "..", "assets");

const FRAME = {
  // 16:9 landscape is the default. Vertical 1080x1920 is available via
  // --width/--height for Shorts/Reels.
  width: 1920,
  height: 1080,
  fps: 30,
  crf: "22",
  preset: "medium",
  // Ken Burns: gentle zoom + drift so static shots do not look like a still.
  kenBurns: true,
  zoomStart: 1.0,
  zoomEnd: 1.12,
  // Logo removal. Percentages of each edge to crop off BEFORE scaling, so corner
  // watermarks and channel bugs never reach the output frame. A bottom-strip
  // default is applied for 9:16 output, where a bug sits in the bottom band.
  cropTop: 0,
  cropBottom: 0,
  cropLeft: 0,
  cropRight: 0,
  // Skip this many seconds from the start / end of the source.
  trimStart: 0,
  trimEnd: 0,
  // Slight grade so the output is visually distinct from the source.
  grade: "eq=contrast=1.05:brightness=0.012:saturation=1.04",
  brandText: process.env.B2E_BRAND_TEXT || "",
  logo: fs.existsSync(path.join(ASSETS_DIR, "logo.png")),
};

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
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

/** Parse a percentage ("6", "6%") or a fraction ("0.06") into 0..1. */
function asFraction(v) {
  if (v === undefined || v === true) return 0;
  const n = parseFloat(String(v));
  if (!Number.isFinite(n) || n < 0) return 0;
  return n > 1 ? n / 100 : n;
}

function probe(file) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(file, (err, meta) => {
      if (err) return reject(new Error(`ffprobe failed for ${file}: ${err.message}`));
      resolve(meta);
    });
  });
}

/**
 * Crop the logo margins off the source, then scale to cover and centre-crop to
 * the target aspect.
 *
 * The margin crop happens FIRST, on the source, which is what makes it effective:
 * a watermark in a corner is removed from the picture entirely rather than being
 * scaled up and then cropped away at the target aspect, which would not remove it
 * (it only removes whatever falls outside the target aspect).
 *
 * Sizes are computed from the source dimensions because the crop must land on real
 * source pixels, and a percentage of the source is the only resolution-independent
 * way to express "remove the bug band".
 */
function buildMarginCrop(w, h) {
  const left = Math.round(w * FRAME.cropLeft);
  const right = Math.round(w * FRAME.cropRight);
  const top = Math.round(h * FRAME.cropTop);
  const bottom = Math.round(h * FRAME.cropBottom);
  if (!left && !right && !top && !bottom) return null;
  const cw = w - left - right;
  const ch = h - top - bottom;
  if (cw < 16 || ch < 16) {
    throw new Error(
      `[reframe] crop removes too much: ${cw}x${ch} would be left of a ${w}x${h} source`,
    );
  }
  return { expr: `crop=${cw}:${ch}:${left}:${top}`, cw, ch };
}

function buildVideoChain(source, duration, srcW, srcH) {
  const { width, height, kenBurns, zoomStart, zoomEnd } = FRAME;

  const pre = [];
  const margin = buildMarginCrop(srcW, srcH);
  if (margin) {
    pre.push(margin.expr);
    console.log(
      `[reframe] logo crop: removing ${FRAME.cropLeft * 100}%/${FRAME.cropRight * 100}% ` +
        `sides, ${FRAME.cropTop * 100}%/${FRAME.cropBottom * 100}% top/bottom ` +
        `(${srcW}x${srcH} -> ${margin.cw}x${margin.ch})`,
    );
  }
  const prefix = pre.length ? `${pre.join(",")},` : "";

  const cover = `${prefix}scale=${width}:${height}:force_original_aspect_ratio=increase`;
  const crop = `crop=${width}:${height}`;

  if (!kenBurns) return `${cover},${crop},setsar=1,${FRAME.grade}`;

  // zoompan runs on its own timeline; feeding it `d` frames per second and a
  // total frame count keeps the motion smooth and deterministic.
  // Commas inside zoompan expressions must be escaped or ffmpeg treats them as
  // filter separators.
  const totalFrames = Math.max(2, Math.round(duration * FRAME.fps));
  const z = `(min(1+(${zoomEnd}-${zoomStart})*on/${totalFrames}\\,1.5))`;
  return (
    `${cover},` +
    `zoompan=z=${z}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'` +
    `:d=1:s=${width}x${height}:fps=${FRAME.fps},` +
    `setsar=1,${FRAME.grade}`
  );
}

function buildSubtitleFilter(srtPath) {
  const escaped = srtPath.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
  // force_style keeps subs readable over bright footage.
  return (
    `subtitles='${escaped}':charenc=UTF-8:` +
    `force_style='FontName=Arial,FontSize=17,PrimaryColour=&H00FFFFFF,` +
    `OutlineColour=&H00000000,BorderStyle=1,Outline=2,Shadow=1,Alignment=2,MarginV=90'`
  );
}

function main() {
  const args = parseArgs(process.argv);
  const video = args.video;
  const audio = args.audio;
  const out = args.out || path.join(__dirname, "output", "b2e_english.mp4");

  // Output size is overridable so the pipeline is not welded to one aspect.
  // --width/--height accept plain numbers, or a shorthand like 1080x1920
  // supplied to either flag. b2e.js forwards its own --width/--height.
  if (args.width) {
    const m = String(args.width).match(/^(\d+)x(\d+)$/);
    if (m) {
      FRAME.width = Number(m[1]);
      FRAME.height = Number(m[2]);
    } else {
      FRAME.width = Number(args.width);
    }
  }
  if (args.height) {
    const m = String(args.height).match(/^(\d+)x(\d+)$/);
    if (m) {
      FRAME.width = Number(m[1]);
      FRAME.height = Number(m[2]);
    } else {
      FRAME.height = Number(args.height);
    }
  }
  if (!Number.isFinite(FRAME.width) || !Number.isFinite(FRAME.height) ||
      FRAME.width < 16 || FRAME.height < 16) {
    console.error("[reframe] --width/--height must be sensible pixel dimensions");
    process.exit(1);
  }
  if (args.crf) FRAME.crf = String(args.crf);
  if (args.preset) FRAME.preset = String(args.preset);

  // Logo-removal margins, as a percentage of each source edge.
  FRAME.cropTop = asFraction(args["crop-top"]);
  FRAME.cropBottom = asFraction(args["crop-bottom"]);
  FRAME.cropLeft = asFraction(args["crop-left"]);
  FRAME.cropRight = asFraction(args["crop-right"]);
  // A single --crop <pct> applies to all four edges, which is the common case
  // (a logo bug inset by the same amount on every side).
  if (args.crop !== undefined) {
    const all = asFraction(args.crop);
    if (all > 0) {
      FRAME.cropTop = FRAME.cropBottom = FRAME.cropLeft = FRAME.cropRight = all;
    }
  }
  // Trim, in seconds, from the start and the end.
  FRAME.trimStart = Math.max(0, parseFloat(args["trim-start"]) || 0);
  FRAME.trimEnd = Math.max(0, parseFloat(args["trim-end"]) || 0);

  if (!video || !fs.existsSync(video)) {
    console.error("[reframe] --video must point at an existing file");
    process.exit(1);
  }
  if (!audio || !fs.existsSync(audio)) {
    console.error("[reframe] --audio must point at the assembled English track");
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(out), { recursive: true });

  const srt = args.srt && fs.existsSync(args.srt) ? args.srt : null;

  probe(video)
    .then(async (meta) => {
      const rawDuration = Number(meta?.format?.duration) || 0;
      const hasVideo = (meta.streams || []).some((s) => s.codec_type === "video");
      if (!hasVideo) throw new Error("source has no video stream");

      const srcStream = (meta.streams || []).find((s) => s.codec_type === "video");
      const srcDims = srcStream ? `${srcStream.width}x${srcStream.height}` : "unknown";

      // Trim the picture to the same window b2e.js trimmed the audio to. The audio
      // arriving here is already trimmed, so the video must be cut identically or the
      // dub slides out of step by exactly trimStart.
      let duration = rawDuration;
      if (FRAME.trimStart > 0 || FRAME.trimEnd > 0) {
        const start = Math.min(FRAME.trimStart, Math.max(0, rawDuration - 0.5));
        const length = Math.max(0.5, rawDuration - start - FRAME.trimEnd);
        duration = length;
        console.log(
          `[reframe] trim: skipping ${start.toFixed(2)}s from the head and ` +
            `${FRAME.trimEnd.toFixed(2)}s from the tail of a ${rawDuration.toFixed(2)}s ` +
            `source -> ${length.toFixed(2)}s`,
        );
      }
      console.log(`[reframe] source: ${srcDims} ${duration.toFixed(2)}s (output ${FRAME.width}x${FRAME.height})`);

      // Warn only when the source genuinely lacks the detail the output needs.
      //
      // Comparing raw heights is wrong: a 1920x1080 landscape source cropped to 9:16
      // is scaled to 3413x1920 and centre-cropped down to 1080x1920, so the output
      // is taller than the source by design and still perfectly sharp. Comparing
      // aspect ratios alone is also wrong, because it says nothing about absolute
      // resolution (a 640x360 source has the same aspect as 1080p).
      //
      // The measure that matters: scale so the source COVERS the output, then how
      // many source pixels end up in one output pixel. Below 1.0 means real
      // upscaling.
      //
      // Note that even a 1080p landscape source is a ~1.8x upscale to 1080x1920,
      // because 9:16 is much taller than 16:9. That is simply the cost of vertical
      // video and it looks fine, so the threshold is deliberately loose: it only
      // fires for sources that are clearly short of detail (2x+ upscale), which
      // is the case worth telling someone about.
      if (srcStream) {
        const scale = Math.max(
          FRAME.width / srcStream.width,
          FRAME.height / srcStream.height,
        );
        if (scale >= 2.0) {
          console.log(
            `[reframe] NOTE: source ${srcStream.width}x${srcStream.height} is being ` +
              `upscaled ${scale.toFixed(2)}x to ${FRAME.width}x${FRAME.height}, so it ` +
              `will look soft. Re-ingest at a higher --quality if the source offers one.`,
          );
        }
      }

      // One continuous video chain: commas link filters to the previous output.
      // Using ";" here would start a new chain and lose the reframed picture.
      const filters = [buildVideoChain(video, duration, srcStream.width, srcStream.height)];
      if (srt) {
        filters.push(buildSubtitleFilter(srt));
        console.log(`[reframe] burning subtitles from ${path.basename(srt)}`);
      }
      if (FRAME.brandText) {
        const font = escapeDrawtext(
          path.join(ASSETS_DIR, "RacingSansOne-Regular.ttf"),
        );
        const text = escapeDrawtext(FRAME.brandText);
        filters.push(
          `drawtext=text='${text}':fontfile='${font}':fontcolor=white:fontsize=44:` +
            `borderw=2:bordercolor=black:x=(w-text_w)/2:y=40:fix_bounds=true`,
        );
      }

      // Two inputs are mapped, so the video chain must be explicitly anchored
      // to [0:v]; otherwise ffmpeg has no video input to bind the first filter to.
      const videoChain = `[0:v]${filters.join(",")}[vout]`;

      await new Promise((resolve, reject) => {
        let lastLogged = -1;
        const cmd = ffmpeg(video);
        // Seek the video input to the trim point so the first frame matches the
        // first sample of the already-trimmed audio.
        if (FRAME.trimStart > 0) cmd.inputOptions(["-ss", FRAME.trimStart.toFixed(3)]);
        cmd
          .input(audio)
          .complexFilter(videoChain)
          .outputOptions([
            "-map", "[vout]",
            "-map", "1:a:0",
            // Pin the output length to the source duration. zoompan emits its own
            // frame timeline and can run slightly long (observed: +2.04s on a 249s
            // clip, ~61 frames), and -shortest does not contain it because the
            // buffered video stream still reports a longer duration. An explicit
            // -t is deterministic; the audio is already trimmed to the same length
            // by the assemble/music stages, so both tracks end together.
            "-t", duration.toFixed(3),
            "-c:v", "libx264",
            "-crf", FRAME.crf,
            "-preset", FRAME.preset,
            "-pix_fmt", "yuv420p",
            "-r", String(FRAME.fps),
            "-c:a", "aac",
            "-b:a", "192k",
            "-ar", "44100",
            "-shortest",
            "-movflags", "+faststart",
            // Strip source metadata so the original's tags are not carried over.
            "-map_metadata", "-1",
          ])
          .output(out)
          .on("progress", (p) => {
            const elapsed = timemarkToSeconds(p.timemark);
            if (elapsed === null || duration <= 0) return;
            const pct = Math.min((elapsed / duration) * 100, 99.5);
            const rounded = Math.floor(pct);
            if (rounded <= lastLogged) return;
            lastLogged = rounded;
            console.log(`[reframe] ${pct.toFixed(1)}%`);
          })
          .on("end", resolve)
          .on("error", (err, _stdout, stderr) => {
            if (stderr) console.error(stderr);
            reject(err);
          })
          .run();
      });

      const finalMeta = await probe(out);
      // Dimensions live on the video stream, not on format.
      const vStream = (finalMeta.streams || []).find((s) => s.codec_type === "video");
      const dims = vStream ? `${vStream.width}x${vStream.height}` : "unknown";
      console.log(
        `[reframe] done -> ${out} (${dims}, ` +
          `${Number(finalMeta.format.duration).toFixed(2)}s)`,
      );
      if (srt) console.log(`[reframe] standalone subtitles kept at: ${srt}`);

      // Report per-stream durations. A video track that outruns the audio means the
      // last few seconds are silent picture, and burned-in subtitles would drift
      // out of step, so say so rather than let it ship unnoticed.
      const vDur = Number(vStream?.duration) || 0;
      const aStream = (finalMeta.streams || []).find((s) => s.codec_type === "audio");
      const aDur = Number(aStream?.duration) || 0;
      if (vDur && aDur && Math.abs(vDur - aDur) > 0.5) {
        console.log(
          `[reframe] WARNING: video ${vDur.toFixed(2)}s vs audio ${aDur.toFixed(2)}s ` +
            `(${Math.abs(vDur - aDur).toFixed(2)}s apart) - they should match.`,
        );
      }
    })
    .catch((err) => {
      console.error(`[reframe] FAILED: ${err.message}`);
      process.exit(1);
    });
}

main();
