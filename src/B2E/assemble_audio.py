"""
Stage 5: time-fit each English clip and lay it onto a silent timeline.

For every segment the manifest carries a `ratio`. Applying that as an `atempo`
rescales the clip so its duration matches the original Bangla slot, and the clip
is then placed at the original start time via `adelay`. Gaps between segments
stay silent, exactly as in the source.

This runs in batches (`--batch-size`) because a 10-minute video can produce
hundreds of segments, and a single ffmpeg invocation with hundreds of inputs
becomes unwieldy. Each batch is rendered separately and the batches are
concatenated.

Batching detail that matters: every `adelay` is computed *relative to the start of
its own batch*, and each part is padded to exactly the slice of the timeline that
batch owns. Absolute delays look equivalent but are not -- batch N would then carry
its true global position inside the part file, and concatenating the parts would
shift every batch after the first by a cumulative error that grows with each batch.

Run:  python src/B2E/assemble_audio.py --manifest <tts.json> --out <english.wav>
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile

# Windows consoles default to a legacy code page (cp1252 on most setups), so any
# print() of Bengali or other non-Latin text raises UnicodeEncodeError and kills an
# otherwise-successful run. Re-configure stdout/stderr to UTF-8 with replacement so
# unencodable characters degrade to '?' instead of aborting the stage.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):  # pragma: no cover - old/odd streams
        pass

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ffprobe_helper import find_ffmpeg, probe_duration  # noqa: E402


def parse_args():
    p = argparse.ArgumentParser(description="Time-fit and place English audio clips.")
    p.add_argument("--manifest", required=True)
    p.add_argument("--out", required=True, help="output wav (continuous timeline)")
    p.add_argument("--sample-rate", type=int, default=44100)
    p.add_argument("--batch-size", type=int, default=40)
    p.add_argument("--fade-ms", type=int, default=8, help="edge fade to avoid clicks")
    return p.parse_args()


def usable_segments(manifest):
    return [
        s
        for s in manifest.get("segments", [])
        if s.get("audio") and s.get("ratio") and s["ratio"] > 0
    ]


def atempo_chain(factor):
    """atempo only accepts 0.5-2.0; chain for anything outside that."""
    parts, remaining = [], float(factor)
    if remaining <= 0 or remaining > 4.0:
        return None
    while remaining < 0.5:
        parts.append("atempo=0.5")
        remaining /= 0.5
    while remaining > 2.0:
        parts.append("atempo=2.0")
        remaining /= 2.0
    if abs(remaining - 1.0) > 1e-6:
        parts.append(f"atempo={remaining:.6f}")
    return ",".join(parts) if parts else None


def render_batch(batch, out_path, sample_rate, fade_ms, offset, length):
    """Render one batch of fitted clips onto its own local timeline.

    `offset` is the batch's start time on the *global* timeline. Delays are applied
    relative to it so each part is a self-contained slice starting at 0. `length` is
    how much of the global timeline this part owns; the caller pads every part to
    exactly that so concatenation lands the parts back at their original offsets.

    Delays must be relative, not absolute: an absolute adelay would place batch N
    at its true global position inside the part file, and concatenating the parts
    would then shift everything after the first batch by a cumulative error.
    """
    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        sys.exit("[assemble] ffmpeg not found on PATH or in node_modules")

    fade_s = max(fade_ms, 1) / 1000.0
    filters = []
    for i, seg in enumerate(batch):
        chain = atempo_chain(seg["ratio"])
        chain = f"{chain}," if chain else ""
        delay_ms = int(round((float(seg["start"]) - offset) * 1000))
        delay_ms = max(0, delay_ms)
        # Fade each clip in/out: prevents clicks at hard boundaries and hides the
        # seams that atempo can leave behind.
        fade_out_at = max(0.0, float(seg["original_duration"]) - fade_s)
        fade = f"afade=t=in:st=0:d={fade_s},afade=t=out:st={fade_out_at:.3f}:d={fade_s}"
        filters.append(
            f"[{i}:a]aformat=sample_fmts=fltp:sample_rates={sample_rate}:channel_layouts=stereo,"
            f"{chain}{fade},adelay={delay_ms}|{delay_ms}[a{i}]"
        )

    labels = "".join(f"[a{i}]" for i in range(len(batch)))
    # normalize=0 matters: amix otherwise scales by input count, so batch 1
    # would play quieter than batch 2.
    filters.append(
        f"{labels}amix=inputs={len(batch)}:duration=longest:"
        f"dropout_transition=0:normalize=0[mixed]"
    )
    # apad + atrim forces the part to exactly `length` seconds so the concat tiles
    # the timeline back together with no drift. This has to live inside the complex
    # graph: ffmpeg rejects `-af` on a stream already fed by -filter_complex.
    filters.append(f"[mixed]apad,atrim=0:{length:.3f},asetpts=N/SR/TB[out]")

    cmd = [ffmpeg, "-y", "-hide_banner", "-loglevel", "error"]
    for seg in batch:
        cmd += ["-i", seg["audio"]]
    cmd += [
        "-filter_complex", ";".join(filters),
        "-map", "[out]",
        "-ac", "2",
        "-ar", str(sample_rate),
        "-c:a", "pcm_s16le",
        out_path,
    ]

    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        sys.exit(f"[assemble] ffmpeg failed:\n{result.stderr}")
    return out_path


def main():
    args = parse_args()

    with open(args.manifest, encoding="utf-8-sig") as fh:
        manifest = json.load(fh)

    segments = usable_segments(manifest)
    if not segments:
        sys.exit("[assemble] no usable segments (all translations empty or failed?)")

    total_dur = float(manifest.get("duration") or 0.0)
    if total_dur <= 0:
        times = [float(s["end"]) for s in segments]
        total_dur = max(times) if times else 0.0
    if total_dur <= 0:
        sys.exit("[assemble] could not determine timeline duration")

    print(f"[assemble] {len(segments)} clips over {total_dur:.2f}s")

    for seg in manifest.get("segments", []):
        if seg.get("needs_review"):
            print(
                f"[assemble]   review: id={seg['id']} "
                f"raw_ratio={seg.get('raw_ratio')} {seg.get('text','')[:50]}"
            )

    tmpdir = tempfile.mkdtemp(prefix="b2e_audio_")
    batches = [segments[i : i + args.batch_size] for i in range(0, len(segments), args.batch_size)]
    rendered = []
    for n, batch in enumerate(batches, 1):
        # Each batch owns the slice of the timeline from its first clip's start to
        # the next batch's first start (the final batch runs to the end). Rendering
        # relative to that offset and padding to that length makes the concatenated
        # parts reconstruct the original timeline exactly.
        offset = float(batch[0]["start"])
        if n < len(batches):
            length = float(batches[n][0]["start"]) - offset
        else:
            length = total_dur - offset
        # Guarantee forward progress even if segments overlap slightly.
        length = max(length, float(batch[-1]["original_duration"]), 0.001)

        print(f"[assemble] batch {n}/{len(batches)} ({len(batch)} clips, +{offset:.2f}s, {length:.2f}s)")
        part = os.path.join(tmpdir, f"part_{n:03d}.wav")
        rendered.append(render_batch(batch, part, args.sample_rate, args.fade_ms, offset, length))

    # Concatenate parts and pad/trim to the exact source duration so the English
    # track lines up 1:1 with the original video.
    ffmpeg = find_ffmpeg()
    list_file = os.path.join(tmpdir, "parts.txt")
    with open(list_file, "w", encoding="utf-8") as fh:
        for part in rendered:
            fh.write("file '" + part.replace("\\", "/") + "'\n")

    concat = subprocess.run(
        [ffmpeg, "-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0",
         "-i", list_file, "-af", f"apad,atrim=0:{total_dur:.3f}", "-ac", "2",
         "-ar", str(args.sample_rate), "-c:a", "pcm_s16le", args.out],
        capture_output=True,
        text=True,
    )
    if concat.returncode != 0:
        sys.exit(f"[assemble] concat failed:\n{concat.stderr}")

    final = probe_duration(args.out)
    print(f"[assemble] wrote {args.out} ({final:.2f}s, target {total_dur:.2f}s)")
    if final and abs(final - total_dur) > 0.5:
        print(f"[assemble] WARNING: duration mismatch of {abs(final - total_dur):.2f}s")

    for part in rendered:
        try:
            os.remove(part)
        except OSError:
            pass
    try:
        os.remove(list_file)
        os.rmdir(tmpdir)
    except OSError:
        pass


if __name__ == "__main__":
    main()
