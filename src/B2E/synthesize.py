"""
Stage 4: synthesise English speech per segment and measure time-fit.

Each English segment is rendered to its own mp3 via edge-tts, then measured.
The ratio tells the orchestrator what `atempo` to apply so the clip lands in the
same time slot as the original Bangla speech. Since atempo=X produces a clip of
length (tts_duration / X), the factor is:

    ratio = english_clip_duration / original_slot_duration

  ratio > 1  English is too long  -> speed up (atempo > 1)
  ratio < 1  English is too short -> slow down (atempo < 1)

Either way the result is (tts / ratio) == original slot duration.

Segments whose ratio falls outside --min-ratio/--max-ratio are flagged
`needs_review` and clamped to the band edge. A robotic voice across every line is
worse than a small amount of drift, so the guard is deliberate.

Run:
  python src/B2E/synthesize.py --segments <translated.json> \
      --outdir <dir> --out <tts.json>
"""

import argparse
import asyncio
import json
import os
import sys
import time

# Windows consoles default to a legacy code page (cp1252), so printing Bengali or
# other non-Latin text raises UnicodeEncodeError and kills the run.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except (AttributeError, ValueError):  # pragma: no cover
    pass

from edge_tts import Communicate


def parse_args():
    p = argparse.ArgumentParser(description="Synthesise English speech per segment.")
    p.add_argument("--segments", required=True)
    p.add_argument("--outdir", required=True, help="directory for per-segment mp3s")
    p.add_argument("--out", required=True, help="output manifest JSON")
    p.add_argument("--voice", default=os.environ.get("B2E_VOICE", "en-US-GuyNeural"))
    p.add_argument("--rate", default="+0%", help="base TTS speaking rate")
    p.add_argument("--pitch", default="+0Hz")
    p.add_argument("--min-ratio", type=float, default=0.85)
    p.add_argument("--max-ratio", type=float, default=1.18)
    p.add_argument("--min-english-chars", type=int, default=2)
    return p.parse_args()


async def synth_one(text, voice, rate, pitch, out_path):
    """Render one segment. Returns True on success."""
    await Communicate(text, voice, rate=rate, pitch=pitch).save(out_path)
    return True


async def synth_all(segments, args, results):
    for seg in segments:
        text = seg["text"]
        idx = seg["id"]
        out_path = os.path.join(args.outdir, f"seg_{idx:04d}.mp3")

        if not text or len(text) < args.min_english_chars:
            results[idx] = {"id": idx, "audio": None, "skipped": True, "reason": "empty translation"}
            print(f"[synth] {idx:4d} SKIP (empty)")
            continue

        last_error = None
        for attempt in range(3):
            try:
                await synth_one(text, args.voice, args.rate, args.pitch, out_path)
                if os.path.isfile(out_path) and os.path.getsize(out_path) > 512:
                    results[idx] = {"id": idx, "audio": os.path.abspath(out_path), "skipped": False}
                    print(f"[synth] {idx:4d} ok   {text[:60]}")
                    last_error = None
                    break
                last_error = "empty output"
            except Exception as exc:  # network hiccups are common here
                last_error = exc
            time.sleep(2 * (attempt + 1))

        if last_error is not None:
            results[idx] = {"id": idx, "audio": None, "skipped": True, "reason": str(last_error)}
            print(f"[synth] {idx:4d} FAILED: {last_error}")


def srt_timestamp(seconds):
    if seconds < 0:
        seconds = 0.0
    ms = int(round(seconds * 1000))
    h, ms = divmod(ms, 3600000)
    m, ms = divmod(ms, 60000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def write_srt(segments, path):
    """English SRT using the ORIGINAL slot times.

    These are the same times the orchestrator uses to place the fitted English
    audio, so subtitles and voice stay locked together.
    """
    lines, n = [], 0
    for seg in segments:
        if not seg.get("text"):
            continue
        n += 1
        lines.append(str(n))
        lines.append(f"{srt_timestamp(seg['start'])} --> {srt_timestamp(seg['end'])}")
        lines.append(seg["text"])
        lines.append("")

    with open(path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines))
    print(f"[synth] wrote {n} subtitle cues -> {path}")


def main():
    args = parse_args()

    # utf-8-sig transparently strips a BOM if present. PowerShell's
    # Out-File/Set-Content add one by default, and json.load rejects it.
    with open(args.segments, encoding="utf-8-sig") as fh:
        data = json.load(fh)

    segments = data.get("segments", [])
    if not segments:
        sys.exit("[synth] no segments to synthesise")

    os.makedirs(args.outdir, exist_ok=True)
    print(f"[synth] {len(segments)} segments, voice={args.voice}")

    results = {}
    asyncio.run(synth_all(segments, args, results))

    # ---- measure and compute time-fit ratios -------------------------------
    from ffprobe_helper import probe_duration

    reviewed, usable = 0, 0
    out_segments = []
    for seg in segments:
        r = results.get(seg["id"], {})
        original = float(seg["end"]) - float(seg["start"])

        entry = {
            "id": seg["id"],
            "start": seg["start"],
            "end": seg["end"],
            "source_text": seg["source_text"],
            "text": seg["text"],
            "original_duration": round(original, 3),
        }

        # A zero-width slot cannot be time-fitted against -- dividing by it used to
        # raise ZeroDivisionError and kill the whole run, losing every clip already
        # rendered. Whisper can emit a segment where start == end (notably after the
        # timing-repair split), and a collapsed slot is a data problem, not a crash.
        if original <= 0.01:
            entry.update(
                {
                    "audio": None,
                    "tts_duration": None,
                    "ratio": None,
                    "needs_review": True,
                    "skip_reason": "zero-length speech slot",
                }
            )
            reviewed += 1
            out_segments.append(entry)
            print(
                f"[synth] {seg['id']:4d} SKIP (zero-length slot "
                f"{seg['start']:.3f}-{seg['end']:.3f})"
            )
            continue

        if r.get("skipped") or not r.get("audio"):
            entry.update({"audio": None, "tts_duration": None, "ratio": None, "needs_review": True})
            reviewed += 1
            out_segments.append(entry)
            continue

        dur = probe_duration(r["audio"])
        if dur is None or dur <= 0:
            entry.update({"audio": r["audio"], "tts_duration": None, "ratio": None, "needs_review": True})
            reviewed += 1
            out_segments.append(entry)
            continue

        # atempo factor must be tts/original, because atempo=X yields a clip of
        # duration (tts / X). Feeding the reciprocal stretches clips that were
        # already too long, pushing speech past its slot and desyncing subs.
        ratio = dur / original
        in_band = args.min_ratio <= ratio <= args.max_ratio
        # Clamp rather than reject: a slight stretch beats no speech at all.
        clamped = min(max(ratio, args.min_ratio), args.max_ratio)
        if not in_band:
            reviewed += 1

        entry.update(
            {
                "audio": r["audio"],
                "tts_duration": round(dur, 3),
                "ratio": round(clamped, 4),
                "raw_ratio": round(ratio, 4),
                "needs_review": not in_band,
            }
        )
        usable += 1
        out_segments.append(entry)

    manifest = {
        "voice": args.voice,
        "min_ratio": args.min_ratio,
        "max_ratio": args.max_ratio,
        "duration": data.get("duration"),
        "segments": out_segments,
    }

    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, ensure_ascii=False, indent=2)

    write_srt(out_segments, os.path.join(os.path.dirname(os.path.abspath(args.out)), "english.srt"))
    print(f"[synth] done: {usable} usable, {reviewed} need review -> {args.out}")


if __name__ == "__main__":
    main()
