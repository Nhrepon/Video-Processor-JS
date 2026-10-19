"""
Stage 1-2: transcribe the Bangla source into timed segments.

Reads a 16 kHz mono WAV (extracted by the Node orchestrator) and writes a
segments JSON that every later stage consumes:

    {
      "audio": "...wav",
      "language": "bn",
      "duration": 123.4,
      "segments": [ { "id": 0, "start": 0.0, "end": 2.4,
                      "text": "...", "words": [ { "w": "...", "s": .., "e": .. } ] } ]
    }

Word-level timings are what let the orchestrator time-fit English audio against
the original speech slots, so they are required rather than best-effort.

Run:  python src/B2E/transcribe.py --audio <wav> --out <segments.json>
"""

import argparse
import json
import os
import sys

# Windows consoles default to a legacy code page (cp1252), so printing Bengali or
# other non-Latin text raises UnicodeEncodeError and kills the run.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except (AttributeError, ValueError):  # pragma: no cover
    pass

from faster_whisper import WhisperModel

# large-v3 is the best Bengali accuracy. "medium"/"small" are acceptable for
# drafts if you need the turnaround.
DEFAULT_MODEL = os.environ.get("B2E_WHISPER_MODEL", "large-v3")

# A Bangla initial_prompt keeps the decoder anchored to the right script. Without
# it Whisper often drifts out of Bengali on music-heavy comedy skits.
DEFAULT_PROMPT = os.environ.get(
    "B2E_WHISPER_PROMPT",
    "এটি একটি বাংলা কমেডি স্কিটের ভিডিও, একাধিক চরিত্রে কথা বলা হচ্ছে।",
)


def _is_repetitive(tokens):
    """True when a segment is a decoder repetition loop rather than speech.

    Catches the failure modes that survive VAD and temperature fallback, e.g.
    "পলেয়াখালি ছেয়াখালি ছেয়াখালি" or a single token repeated for ten seconds.
    """
    n = len(tokens)

    # Any single token filling >= 40% of the segment.
    if n >= 4:
        most_common = max(tokens.count(t) for t in set(tokens))
        if most_common / n >= 0.4:
            return True

    # Two tokens alternating, or a short n-gram repeating end to end.
    if n >= 8:
        for gram in (1, 2, 3):
            head, tail = tokens[:gram], tokens[-gram:]
            if head == tail:
                return True
            if all(
                tokens[i] == tokens[i % gram]
                for i in range(n)
            ):
                return True

    return False


def _tighten(words, max_gap, max_word_dur):
    """Split a word list wherever it stops being one continuous utterance.

    Music-heavy sources produce degenerate word alignments: a single token is
    stretched across many seconds of music-only audio (e.g. one word spanning
    13.5s). If such a segment is kept whole, time-fitting has to stretch the
    English dub over that entire span, which sounds like a slowed-down robot.

    Two repairs, applied in order:
      1. Clamp any single word whose duration is implausible for speech.
      2. Break the segment at every gap larger than `max_gap`.

    Text is preserved; only the timing is tightened, which is what the downstream
    time-fit stage actually consumes.
    """
    clamped = []
    for w in words:
        dur = float(w["e"]) - float(w["s"])
        if dur > max_word_dur:
            w = {"w": w["w"], "s": w["s"], "e": round(float(w["s"]) + max_word_dur, 3)}
        clamped.append(w)

    groups = [[clamped[0]]] if clamped else []
    for prev, cur in zip(clamped, clamped[1:]):
        if float(cur["s"]) - float(prev["e"]) > max_gap:
            groups.append([cur])
        else:
            groups[-1].append(cur)
    return groups


def _postprocess(segments, max_gap, max_word_dur):
    """Apply timing repairs and re-id the resulting segments."""
    out = []
    for seg in segments:
        words = seg.get("words") or []
        if not words:
            out.append(seg)
            continue
        for group in _tighten(words, max_gap, max_word_dur):
            out.append(
                {
                    "id": len(out),
                    "start": round(float(group[0]["s"]), 3),
                    "end": round(max(float(w["e"]) for w in group), 3),
                    "text": " ".join(w["w"] for w in group),
                    "words": group,
                }
            )
    return out


def parse_args():
    p = argparse.ArgumentParser(description="Transcribe Bangla audio to timed segments.")
    p.add_argument("--audio", required=True, help="16 kHz mono WAV")
    p.add_argument("--out", required=True, help="output segments JSON")
    p.add_argument("--model", default=DEFAULT_MODEL, help="Whisper model name")
    p.add_argument("--language", default="bn", help="source language code")
    p.add_argument("--compute-type", default="int8", help="CTranslate2 quantisation")
    p.add_argument("--beam-size", type=int, default=5)
    p.add_argument(
        "--prompt",
        default=DEFAULT_PROMPT,
        help="initial_prompt that steers Whisper toward the right language/script",
    )
    p.add_argument(
        "--max-gap",
        type=float,
        default=0.7,
        help="split a segment when consecutive words are further apart than this (s)",
    )
    p.add_argument(
        "--max-word-dur",
        type=float,
        default=2.0,
        help="clamp any single word aligned to a longer span than this (s)",
    )
    return p.parse_args()


def srt_timestamp(seconds):
    """SRT wants HH:MM:SS,mmm. Negative/absurd values are clamped to zero."""
    ms = int(round(max(0.0, float(seconds)) * 1000))
    h, ms = divmod(ms, 3600000)
    m, ms = divmod(ms, 60000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def write_transcript_exports(segments, out_path):
    """Write the SOURCE-language transcript as .srt and .txt next to the JSON.

    The JSON is the pipeline's input, but it is not something you can read. These
    two are for checking what was actually heard: the SRT loads into any player or
    editor, and the TXT is one line per segment with a timestamp. They cost
    nothing and make it easy to confirm a bad transcription before spending a
    translation/TTS pass on it.
    """
    base, _ = os.path.splitext(out_path)
    written = []

    srt_lines = []
    for n, seg in enumerate(segments, 1):
        srt_lines += [
            str(n),
            f"{srt_timestamp(seg['start'])} --> {srt_timestamp(seg['end'])}",
            seg["text"],
            "",
        ]
    srt_path = f"{base}.srt"
    with open(srt_path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(srt_lines))
    written.append(srt_path)

    txt_lines = [
        f"[{srt_timestamp(s['start'])[3:]}] {s['text']}" for s in segments
    ]
    txt_path = f"{base}.txt"
    with open(txt_path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(txt_lines) + "\n")
    written.append(txt_path)

    return written


def main():
    args = parse_args()

    if not os.path.isfile(args.audio):
        sys.exit(f"[transcribe] audio not found: {args.audio}")

    print(f"[transcribe] loading model={args.model} compute_type={args.compute_type}")
    model = WhisperModel(args.model, device="auto", compute_type=args.compute_type)

    print("[transcribe] transcribing (this is the slow part)...")
    raw_segments, info = model.transcribe(
        args.audio,
        language=args.language,
        beam_size=args.beam_size,
        word_timestamps=True,
        vad_filter=True,
        # Keep VAD segments short so a long pause does not become one
        # giant segment that is impossible to time-fit.
        vad_parameters={"min_silence_duration_ms": 400},
        # --- Hallucination guards -------------------------------------------
        # `condition_on_previous_text` lets the decoder feed its own output back
        # in. On noisy / music-heavy / clipped Bengali audio this collapses into
        # a repetition loop (e.g. one token repeated for 10s). Turning it off
        # makes each 30s window decode independently.
        condition_on_previous_text=False,
        # Reject windows that are mostly non-speech.
        no_speech_threshold=0.6,
        # Reject degenerate output (very repetitive text has a high gzip
        # compression ratio) instead of emitting it as a real segment.
        compression_ratio_threshold=2.0,
        # Nudge the decoder toward the right script/language. Particularly
        # helpful for Bangla, which Whisper otherwise drifts out of.
        initial_prompt=args.prompt or None,
        # Fallback temperatures: if a window decodes degenerately at T=0, retry
        # hotter rather than accepting the bad text.
        temperature=[0.0, 0.2, 0.4, 0.6, 0.8, 1.0],
    )

    segments = []
    dropped = 0
    for seg in raw_segments:
        text = (seg.text or "").strip()
        if not text:
            continue

        # Last-resort guard against decoder repetition loops.
        if _is_repetitive(text.split()):
            dropped += 1
            print(
                f"[transcribe] dropped repetitive segment "
                f"[{seg.start:.2f}-{seg.end:.2f}]: {text[:60]}"
            )
            continue

        words = []
        for w in seg.words or []:
            wtext = (w.word or "").strip()
            if not wtext:
                continue
            words.append({"w": wtext, "s": round(float(w.start), 3), "e": round(float(w.end), 3)})

        segments.append(
            {
                "id": len(segments),
                "start": round(float(seg.start), 3),
                "end": round(float(seg.end), 3),
                "text": text,
                "words": words,
            }
        )

    before = len(segments)
    before_words = sum(len(s["words"]) for s in segments)
    segments = _postprocess(segments, args.max_gap, args.max_word_dur)
    if len(segments) != before:
        print(
            f"[transcribe] split {before} -> {len(segments)} segments on gaps "
            f"> {args.max_gap}s (music-only stretches removed from speech slots)"
        )
    after_words = sum(len(s["words"]) for s in segments)
    if after_words != before_words:
        # Clamping trims a word's tail, so the count should survive; flag loudly if
        # it ever does not, since that would mean text was lost.
        print(f"[transcribe] WARNING: word count {before_words} -> {after_words}")

    payload = {
        "audio": os.path.abspath(args.audio),
        "language": info.language,
        "duration": round(float(info.duration or 0.0), 3),
        "segments": segments,
    }

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)

    total_words = sum(len(s["words"]) for s in segments)
    print(f"[transcribe] {len(segments)} segments / {total_words} words -> {args.out}")
    for path in write_transcript_exports(segments, args.out):
        print(f"[transcribe] readable transcript -> {path}")
    if dropped:
        print(f"[transcribe] dropped {dropped} repetitive/hallucinated segment(s)")

    if not segments:
        sys.exit(
            "[transcribe] produced no segments. The source is probably music or "
            "has no intelligible speech; try --model large-v3 on a cleaner source."
        )


if __name__ == "__main__":
    main()
