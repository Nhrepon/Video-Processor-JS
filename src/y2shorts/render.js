/**
 * Render a vertical (1080x1920) Short from a source video.
 *
 * - Object stays centered: scale-to-fill then centre-crop, so the middle of the
 *   frame (where the subject usually is) is preserved with no letterboxing.
 * - A copyright-free music bed from audio/youtube is mixed under the original
 *   audio at a low volume.
 * - The video title is drawn along the top of the frame.
 */
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("@ffmpeg-installer/ffmpeg").path;
const ffprobePath = require("@ffprobe-installer/ffprobe").path;
const fs = require("fs");
const path = require("path");
const os = require("os");
const { getAudioFiles, getRandomNumber } = require("../utility/utility");
const { planTitle } = require("./text");

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

const feature = {
    removeOriginalAudio: false,
    addMusicBed: true,
    addTitleText: true,
    minShortDuration: 60,
    maxShortDuration: 120,
    trimStart: 50,
    trimEnd: 50,
    numberOfClips: 3,
}

const OUTPUT_WIDTH = 1080;
const OUTPUT_HEIGHT = 1920;
const OUTPUT_FPS = 30;
const X264_PRESET = "fast";
const CRF = "23";
const ORIGINAL_AUDIO_VOLUME = 1.0;
const MUSIC_BED_VOLUME = 0.15; // low-volume background music
const TOP_BAND = 300; // reserved for the title overlay (blurred bg behind)
const BOTTOM_BAND = 300; // blurred-bg footer band
const MAIN_HEIGHT = OUTPUT_HEIGHT - TOP_BAND - BOTTOM_BAND; // sharp video band (1320)

function log(line) {
  console.log(`[y2shorts:render] ${line}`);
}

function getMediaDuration(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        reject(new Error(`ffprobe failed for ${filePath}: ${err.message}`));
        return;
      }
      const dur = Number(metadata?.format?.duration);
      if (!Number.isFinite(dur)) {
        reject(new Error(`Could not determine duration for ${filePath}`));
        return;
      }
      resolve(dur);
    });
  });
}

function pickMusic(musicDir) {
  const files = getAudioFiles(musicDir);
  if (files.length === 0) return null;
  return files[getRandomNumber(0, files.length - 1)];
}

/**
 * Per-Short length: an explicit duration wins; otherwise the source is clamped
 * into [minShortDuration, maxShortDuration] and never exceeds the source.
 */
function clampDuration(sourceDuration, duration) {
  if (duration && duration > 0) return Math.min(duration, sourceDuration);
  let target = sourceDuration;
  if (feature.maxShortDuration > 0)
    target = Math.min(target, feature.maxShortDuration);
  if (feature.minShortDuration > 0)
    target = Math.max(target, feature.minShortDuration);
  return Math.min(target, sourceDuration);
}

/**
 * Plan `feature.numberOfClips` separate Shorts from one source. Each plan is a
 * contiguous { start, duration } cut; the N cuts are spread across equal slots
 * of the trim window (with jitter) so every Short shows different footage.
 * The window is the source minus trimStart (intro) and trimEnd (outro).
 *
 * @returns {Array<{start: number, duration: number}>}
 */
function planShorts(
  sourceDuration,
  { duration, start, trimStart, trimEnd } = {},
) {
  const count = Math.max(1, Math.round(feature.numberOfClips || 1));
  // CLI values override the feature defaults.
  const intro = Math.max(
    0,
    Number(trimStart != null ? trimStart : feature.trimStart) || 0,
  );
  const outro = Math.max(
    0,
    Number(trimEnd != null ? trimEnd : feature.trimEnd) || 0,
  );
  const winStart = Math.min(intro, sourceDuration);
  const winEnd = Math.max(winStart, sourceDuration - outro);
  const windowLen = winEnd - winStart;
  if (windowLen <= 0) {
    throw new Error(
      `Empty trim window: trimStart=${intro}s + trimEnd=${outro}s leaves nothing ` +
        `of a ${sourceDuration.toFixed(1)}s video`,
    );
  }

  const wanted = clampDuration(windowLen, duration);
  // Ideal share of the window per Short. When the window cannot fit `count`
  // disjoint Shorts of the configured minimum length, the minimum wins and
  // neighbouring Shorts overlap a little instead of coming out too short.
  const ideal = windowLen / count;
  // Each Short gets its own random length inside [min, max] (capped to the
  // window), so a batch of Shorts doesn't look mechanically identical. An
  // explicit --duration overrides and makes them all the same length.
  const lo = Math.min(
    feature.minShortDuration > 0 ? feature.minShortDuration : 0,
    windowLen,
  );
  const hi = Math.min(
    Math.max(feature.maxShortDuration > 0 ? feature.maxShortDuration : windowLen, lo),
    windowLen,
  );
  const durations = [];
  for (let i = 0; i < count; i += 1) {
    durations.push(
      duration && duration > 0
        ? wanted
        : Math.round((lo + Math.random() * (hi - lo)) * 10) / 10,
    );
  }
  const meanPer = durations.reduce((a, b) => a + b, 0) / count;
  const overlapping = count > 1 && meanPer > ideal;
  // Even spread: first Short starts at the window start, last one ends at the
  // window end. Degenerates to 0 step when the window is exactly one Short.
  const step = count > 1 ? Math.max(0, (windowLen - meanPer) / (count - 1)) : 0;

  const plans = [];
  for (let i = 0; i < count; i += 1) {
    const raw = count === 1 ? (start != null ? start : winStart) : winStart + i * step;
    const clamped = Math.min(
      Math.max(raw, winStart),
      Math.max(winStart, winEnd - durations[i]),
    );
    plans.push({
      start: Math.round(clamped * 10) / 10,
      duration: durations[i],
    });
  }
  log(
    `plan: ${count} short(s) from window ` +
      `${winStart.toFixed(1)}-${winEnd.toFixed(1)}s` +
      `${overlapping ? " (window too small for disjoint clips, overlaps)" : ""} ` +
      `| ${plans
        .map((p, i) => `#${i + 1} ${p.duration.toFixed(1)}s @${p.start.toFixed(1)}`)
        .join(" | ")}`,
  );
  return plans;
}

/**
 * @param {object} opts
 * @param {string} opts.videoPath   source video
 * @param {string} opts.outputPath  destination mp4
 * @param {string} opts.musicDir    directory of copyright-free music beds
 * @param {string} opts.fontPath    drawtext font file
 * @param {string} opts.title       title text to draw at the top
 * @param {number} [opts.duration]  optional max output duration (seconds)
 * @param {number} [opts.start]     optional start offset (seconds) for a single clip
 */
function renderShort({
  videoPath,
  outputPath,
  musicDir,
  fontPath,
  title,
  duration,
  start,
}) {
  return new Promise(async (resolve, reject) => {
    try {
      if (!fs.existsSync(videoPath)) {
        throw new Error(`Input video not found at ${videoPath}`);
      }
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });

      const musicPath = feature.addMusicBed ? pickMusic(musicDir) : null;
      if (feature.addMusicBed && !musicPath) {
        throw new Error(`No copyright-free music found in ${musicDir}`);
      }
      if (musicPath) log(`music bed: ${path.basename(musicPath)}`);

      const sourceDuration = await getMediaDuration(videoPath);

      // One Short = one contiguous cut [start, start + duration]. Deciding HOW
      // MANY Shorts a source yields is planShorts()'s job (see numberOfClips).
      const clipLen = clampDuration(sourceDuration, duration);
      const clipStart = Math.min(
        Math.max(start != null ? start : 0, 0),
        Math.max(0, sourceDuration - clipLen),
      );
      log(
        `plan: 1 clip x ${clipLen.toFixed(1)}s starting at ${clipStart.toFixed(1)}s`,
      );

      const drawtextFont = fontPath
        .replace(/\\/g, "\\\\")
        .replace(/:/g, "\\:");

      // Only pull in the music-bed input when the feature is on and a bed exists.
      const hasBed = feature.addMusicBed && fs.existsSync(musicPath);

      // Wrap the title and write it to a temp file. drawtext's textfile= renders
      // real newlines and needs no text escaping, which avoids the filtergraph
      // parse break that raw quotes/apostrophes in text='...' cause.
      let titleFile = null;
      let titlePlan = null;
      if (feature.addTitleText && title) {
        titlePlan = planTitle(title, OUTPUT_WIDTH, TOP_BAND);
        if (titlePlan) {
          titleFile = path.join(os.tmpdir(), `y2shorts-title-${Date.now()}.txt`);
          fs.writeFileSync(titleFile, titlePlan.lines.join("\n"), "utf8");
        }
      }
      const cleanupTitle = () => {
        if (titleFile) {
          try {
            fs.unlinkSync(titleFile);
          } catch {
            /* ignore */
          }
        }
      };

      const command = ffmpeg().input(videoPath);
      if (hasBed) {
        command.input(musicPath).inputOptions(["-stream_loop", "-1"]);
      }

      const fc = [];

      // Cut the chosen segment into single video/audio streams ([vc] / [ac])
      // that the rest of the graph consumes.
      fc.push(
        `[0:v]trim=start=${clipStart.toFixed(3)}:end=${(clipStart + clipLen).toFixed(3)},` +
          `setpts=PTS-STARTPTS[vc]`,
      );
      if (!feature.removeOriginalAudio) {
        fc.push(
          `[0:a]atrim=start=${clipStart.toFixed(3)}:end=${(clipStart + clipLen).toFixed(3)},` +
            `asetpts=PTS-STARTPTS[ac]`,
        );
      }

      // Blurred, slightly darkened full-frame background fills the top/bottom
      // bands; the sharp video is centre-cropped into the middle band so the
      // subject stays centred.
      fc.push(`[vc]split=2[bgs][fgs]`);
      fc.push(
        `[bgs]scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=increase,` +
          `crop=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT},boxblur=20:2,eq=brightness=-0.05[bg]`,
      );
      fc.push(
        `[fgs]scale=${OUTPUT_WIDTH}:${MAIN_HEIGHT}:force_original_aspect_ratio=increase,` +
          `crop=${OUTPUT_WIDTH}:${MAIN_HEIGHT}:(in_w-${OUTPUT_WIDTH})/2:(in_h-${MAIN_HEIGHT})/2,` +
          `setsar=1[fg]`,
      );
      fc.push(
        `[bg][fg]overlay=x=0:y=${TOP_BAND}:eof_action=pass,fps=${OUTPUT_FPS}[vbase]`,
      );

      if (titleFile && titlePlan) {
        const titleFilePath = titleFile
          .replace(/\\/g, "\\\\")
          .replace(/:/g, "\\:");
        // A full-width translucent banner across the top band gives the title a
        // clean, consistent backing regardless of how bright the blur behind is.
        fc.push(
          `[vbase]drawbox=x=0:y=0:w=iw:h=${TOP_BAND}:color=black@0.35:t=fill[vband]`,
        );
        fc.push(
          `[vband]drawtext=fontfile='${drawtextFont}':textfile='${titleFilePath}':` +
            `fontcolor=white:fontsize=${titlePlan.fontsize}:` +
            `borderw=4:bordercolor=black@0.85:` +
            `line_spacing=${titlePlan.lineSpacing}:` +
            // Quoted so the comma inside max() is not read as a filter separator.
            `x=(w-text_w)/2:y='max(8,(${TOP_BAND}-text_h)/2)'[vout]`,
        );
      } else {
        fc.push(`[vbase]null[vout]`);
      }

      // Audio graph honours the feature flags:
      //   removeOriginalAudio + bed   -> bed only
      //   removeOriginalAudio + none  -> silent (-an)
      //   keep original       + bed   -> amix(original, bed)
      //   keep original       + none  -> original only
      let audioOutLabel = null;
      if (hasBed) {
        fc.push(
          `[1:a]volume=${MUSIC_BED_VOLUME},atrim=duration=${clipLen.toFixed(3)},asetpts=PTS-STARTPTS[abed]`,
        );
        if (feature.removeOriginalAudio) {
          audioOutLabel = "[abed]";
        } else {
          fc.push(`[ac]volume=${ORIGINAL_AUDIO_VOLUME}[aorig]`);
          fc.push(
            `[aorig][abed]amix=inputs=2:duration=first:dropout_transition=0,` +
              `atrim=duration=${clipLen.toFixed(3)}[aout]`,
          );
          audioOutLabel = "[aout]";
        }
      } else if (!feature.removeOriginalAudio) {
        // [ac] is already trimmed to the target length by the concat above.
        fc.push(`[ac]volume=${ORIGINAL_AUDIO_VOLUME}[aout]`);
        audioOutLabel = "[aout]";
      }

      const outOpts = ["-map", "[vout]"];
      if (audioOutLabel) {
        outOpts.push("-map", audioOutLabel, "-c:a", "aac", "-b:a", "192k");
      } else {
        outOpts.push("-an");
      }
      outOpts.push(
        "-c:v",
        "libx264",
        "-crf",
        CRF,
        "-preset",
        X264_PRESET,
        "-threads",
        "0",
        "-r",
        String(OUTPUT_FPS),
        "-pix_fmt",
        "yuv420p",
        "-t",
        clipLen.toFixed(3),
        "-movflags",
        "+faststart",
        "-metadata",
        `title=${title || "Short"}`,
        "-y",
      );

      command
        .complexFilter(fc.join(";"))
        .outputOptions(outOpts)
        .output(outputPath)
        .on("progress", (progress) => {
          if (progress.percent) {
            process.stdout.write(
              `\r[y2shorts:render] encoding ${progress.percent.toFixed(1)}%`,
            );
          }
        })
        .on("error", (err) => {
          console.log("");
          cleanupTitle();
          reject(new Error(`ffmpeg render failed: ${err.message}`));
        })
        .on("end", () => {
          console.log("");
          cleanupTitle();
          log(`output: ${outputPath} (${OUTPUT_WIDTH}x${OUTPUT_HEIGHT})`);
          resolve(outputPath);
        })
        .run();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { renderShort, planShorts };
