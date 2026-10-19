/**
 * Shared text helpers for the y2shorts pipeline.
 *
 * drawtext needs two different kinds of escaping: the text itself (backslash,
 * colon, quote, percent) and the filtergraph separator characters (comma,
 * semicolon) which would otherwise split the filter chain.
 */

function escapeDrawtext(text) {
  return String(text)
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/%/g, "\\%")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

/**
 * Word-wrap a title so it fits the 1080px-wide frame at the chosen font size.
 * Returns RAW (unescaped) lines. The caller writes them to a temp file and uses
 * drawtext's textfile= option, which renders real newlines and needs no text
 * escaping (embedding raw text in the filtergraph breaks on quotes/apostrophes).
 */
function wrapTitleLines(title, maxCharsPerLine = 20, maxLines = 3) {
  const words = String(title || "").replace(/\s+/g, " ").trim().split(" ");
  const lines = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxCharsPerLine) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    current = word.length > maxCharsPerLine ? word.slice(0, maxCharsPerLine) : word;
    if (lines.length === maxLines) break;
  }

  if (current && lines.length < maxLines) lines.push(current);

  // If the title was truncated, make the last line end with an ellipsis so the
  // overlay never looks like a half-finished sentence.
  if (lines.length === maxLines) {
    const rest = words.join(" ");
    const shown = lines.join(" ").replace(/\s+/g, " ");
    if (rest.length > shown.length) {
      lines[maxLines - 1] = `${lines[maxLines - 1].slice(0, maxCharsPerLine - 1)}…`;
    }
  }

  return lines;
}

/**
 * Clean a YouTube title for use in a Windows filename.
 */
function sanitizeFileName(title, fallback = "short") {
  const safe = String(title || "")
    .replace(/[<>:"/\\|?*]/g, " ")
    .replace(/[\x00-\x1f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 70)
    .replace(/[. ]+$/, "");
  return safe || fallback;
}

/**
 * Plan a title overlay that always fits its band, whatever the text.
 *
 * Wraps to at most 3 lines, then picks the largest font size that satisfies both
 * the band height and the usable width, so long/short titles never overflow or
 * get clipped. Returns null when there is nothing to draw.
 */
const TITLE_MAX_LINES = 3;
const TITLE_MAX_FONT = 76;
const TITLE_MIN_FONT = 30;
const TITLE_LINE_SPACING = 10;
const TITLE_SIDE_MARGIN = 16; // minimal gutter; the title hugs the frame edges
const TITLE_V_PADDING = 14;
const CHAR_WIDTH_RATIO = 0.58; // approx avg glyph width as a fraction of font size
// A rendered line is taller than its font size (ascent + descent). Ignoring this
// made multi-line titles overflow the band and clip at the top edge.
const LINE_HEIGHT_RATIO = 1.25;

function planTitle(title, frameWidth = 1080, bandHeight = 200) {
  const usableWidth = frameWidth - 2 * TITLE_SIDE_MARGIN;
  const usableHeight = bandHeight - 2 * TITLE_V_PADDING;
  const normalized = String(title || "").replace(/\s+/g, " ").trim();
  if (!normalized) return null;

  // Prefer the smallest line count that shows the title in FULL and fits the
  // band; wrapping at exactly the char count the font can fit across
  // usableWidth makes the block span (nearly) the whole width instead of
  // leaving big empty gutters.
  let fallback = null;
  for (let lineCount = 1; lineCount <= TITLE_MAX_LINES; lineCount += 1) {
    const fontsize = Math.min(
      TITLE_MAX_FONT,
      Math.floor(
        (usableHeight - (lineCount - 1) * TITLE_LINE_SPACING) /
          (lineCount * LINE_HEIGHT_RATIO),
      ),
    );
    if (fontsize < TITLE_MIN_FONT) break;
    const maxChars = Math.max(
      8,
      Math.floor(usableWidth / (CHAR_WIDTH_RATIO * fontsize)),
    );
    const lines = wrapTitleLines(title, maxChars, lineCount);
    if (lines.length === 0 || lines.length > lineCount) continue;
    const widest = Math.max(...lines.map((l) => l.length));
    if (CHAR_WIDTH_RATIO * fontsize * widest > usableWidth) continue;
    // Keep the latest (most lines = most title shown) viable layout in case no
    // line count can show the title in full.
    fallback = { lines, fontsize };
    // Nothing was ellipsised away -> this is the layout we want.
    const shown = lines.join(" ").trim();
    if (!shown.endsWith("…") && shown === normalized) {
      return { lines, fontsize, lineSpacing: TITLE_LINE_SPACING };
    }
  }

  if (fallback) {
    return {
      lines: fallback.lines,
      fontsize: fallback.fontsize,
      lineSpacing: TITLE_LINE_SPACING,
    };
  }

  // Fallback: smallest font, max lines (very long titles get ellipsised).
  const maxChars = Math.max(
    8,
    Math.floor(usableWidth / (CHAR_WIDTH_RATIO * TITLE_MIN_FONT)),
  );
  const lines = wrapTitleLines(title, maxChars, TITLE_MAX_LINES);
  if (lines.length === 0) return null;
  return { lines, fontsize: TITLE_MIN_FONT, lineSpacing: TITLE_LINE_SPACING };
}

module.exports = {
  escapeDrawtext,
  wrapTitleLines,
  sanitizeFileName,
  planTitle,
};
