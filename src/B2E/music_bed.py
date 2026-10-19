"""
Stage 6: lay a music bed under the English voice track.

Mixes a user-supplied music file under the assembled English audio at a low
level, with sidechain ducking so the music drops automatically whenever the voice
is speaking. Without ducking a constant low volume still masks consonants; with
it, the music fills the gaps between lines and steps out of the way under them.

Sidechain compression is the right tool here: ffmpeg's `sidechaincompress` takes a
second input as the trigger, so the music is keyed off the actual voice track
rather than a hand-authored volume envelope. That keeps the ducking correct even
after time-fitting shifts every clip.

Run:
  python src/B2E/music_bed.py --voice <english.wav> --music <track> --out <mixed.wav>
"""

import argparse
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ffprobe_helper import find_ffmpeg, probe_duration  # noqa: E402


def parse_args():
    p = argparse.ArgumentParser(description="Mix a ducked music bed under voice audio.")
    p.add_argument("--voice", required=True, help="assembled English wav")
    p.add_argument("--music", required=True, help="music file to bed underneath")
    p.add_argument("--out", required=True, help="output wav")
    p.add_argument(
        "--music-db",
        type=float,
        default=-22.0,
        help="music level under speech in dB (default -22; -30 is very subtle)",
    )
    p.add_argument(
        "--voice-lufs",
        type=float,
        default=-16.0,
        help="loudness target for the voice before mixing (default -16 LUFS)",
    )
    p.add_argument(
        "--duck",
        type=float,
        default=6.0,
        help="sidechain compression ratio for the bed (0 disables ducking)",
    )
    p.add_argument(
        "--duck-db",
        type=float,
        default=-12.0,
        help=(
            "attenuation of the sidechain key, in dB. Lower = deeper ducking. "
            "Note the effect saturates around -9 dB on typical material because "
            "the compressor is already fully closed by then; raise --music-db or "
            "lower --duck if the bed needs to be less aggressive."
        ),
    )
    p.add_argument("--sample-rate", type=int, default=44100)
    p.add_argument(
        "--loop",
        action="store_true",
        help="repeat the music if it is shorter than the voice track",
    )
    p.add_argument(
        "--fade-out",
        type=float,
        default=1.5,
        help="seconds to fade the music out at the end (default 1.5)",
    )
    return p.parse_args()


def main():
    args = parse_args()

    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        sys.exit("[music] ffmpeg not found on PATH or in node_modules")
    for label, path in (("voice", args.voice), ("music", args.music)):
        if not os.path.isfile(path):
            sys.exit(f"[music] {label} file not found: {path}")

    voice_dur = probe_duration(args.voice)
    music_dur = probe_duration(args.music)
    if not voice_dur:
        sys.exit("[music] could not determine voice duration")
    if not music_dur:
        sys.exit("[music] could not determine music duration")

    total = voice_dur
    print(f"[music] voice {voice_dur:.2f}s  music {music_dur:.2f}s  gain {args.music_db}dB")

    if music_dur < voice_dur and not args.loop:
        print(
            f"[music] NOTE: music is {music_dur:.1f}s but the voice runs "
            f"{voice_dur:.1f}s; the bed will run out early. Use --loop to repeat it."
        )

    # [-1] loops the music input indefinitely; the -stream_loop option is a
    # demuxer-level flag and only works for some containers, so the filter-level
    # loop is the more portable choice here.
    music_inputs = ["-stream_loop", "-1", "-i", args.music] if args.loop else ["-i", args.music]

    # Both legs are normalised to the target rate/layout first so the compressor
    # and the mix operate on comparable streams.
    #
    # The voice leg is loudness-normalised to --voice-lufs first. This matters
    # more than it looks: the assembled voice track is quiet and has a long
    # silent head/tail, so a relative music gain applied to raw levels lets the
    # bed sit well above the voice and the dub becomes unintelligible. Anchoring
    # the voice to an absolute target makes --music-db mean something predictable
    # regardless of how quiet the TTS output happened to be.
    # Pin the voice leg to exactly the source length. loudnorm is a two-pass
    # filter that buffers, which otherwise leaves the track a couple of seconds
    # short and makes the mix drift against the picture.
    voice_chain = (
        f"[0:a]aformat=sample_fmts=fltp:sample_rates={args.sample_rate}:channel_layouts=stereo,"
        f"loudnorm=I={args.voice_lufs}:TP=-1.5:LRA=11,"
        f"apad,atrim=0:{total:.3f},asetpts=N/SR/TB[voice]"
    )
    music_gain = f"[1:a]aformat=sample_fmts=fltp:sample_rates={args.sample_rate}:channel_layouts=stereo,volume={args.music_db}dB"

    fade = max(0.0, float(args.fade_out))
    # With --loop the track is repeated, so the fade-out must come AFTER the
    # padding/trimming -- otherwise it is applied to the first pass only and the
    # looped track still ends abruptly at the cut.
    tail = ""
    if fade > 0:
        fade_at = max(0.0, voice_dur - fade)
        tail = f",afade=t=out:st={fade_at:.3f}:d={fade:.3f}"

    if args.loop:
        # The music leg is padded to the full voice length. Without this, amix ends
        # the mix when the (shorter) music runs out, which silently truncates the
        # whole track -- and because reframe.js muxes with -shortest, that
        # truncates the finished VIDEO too.
        music_chain = (
            f"{music_gain},apad,atrim=0:{total:.3f},asetpts=N/SR/TB{tail}[music]"
        )
    else:
        music_chain = f"{music_gain}{tail}[music]"

    if args.duck > 0:
        # sidechaincompress keys the music off the voice: the bed is compressed by
        # however far it sits above `threshold`, so the bed must first be mixed
        # DOWN into the key signal, not the key mixed up into the bed. `[voicekey]`
        # is the voice attenuated by --duck-db, and the music leg is then referenced
        # against that.
        #
        # Using the full-amplitude voice as the key (the obvious `ratio=` approach)
        # over-ducked the sample by ~50 dB, which silences the bed completely under
        # speech. Attenuating the key keeps the trigger proportional to how loud the
        # music actually is, giving a controllable depth.
        mix = (
            f"[voice]volume={args.duck_db}dB[voicekey];"
            f"[music][voicekey]sidechaincompress=threshold=0.125:ratio={args.duck}:"
            f"attack=20:release=500:makeup=1[ducked];"
            # duration=longest + the explicit -t below: `duration=first` would be
            # wrong here because the first amix input is the MUSIC leg, not the voice.
            f"[ducked][voice]amix=inputs=2:duration=longest:dropout_transition=0:"
            f"normalize=0[out]"
        )
    else:
        mix = (
            f"[music][voice]amix=inputs=2:duration=longest:"
            f"dropout_transition=0:normalize=0[out]"
        )

    # -t pins the output to the voice track length, so the mix can never drift
    # longer than the picture.
    graph = ";".join([voice_chain, music_chain, mix])

    cmd = [ffmpeg, "-y", "-hide_banner", "-loglevel", "error", "-i", args.voice]
    cmd += music_inputs
    cmd += [
        "-filter_complex", graph,
        "-map", "[out]",
        "-t", f"{total:.3f}",
        "-ac", "2",
        "-ar", str(args.sample_rate),
        "-c:a", "pcm_s16le",
        args.out,
    ]

    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        sys.exit(f"[music] ffmpeg failed:\n{result.stderr}")

    final = probe_duration(args.out)
    print(f"[music] wrote {args.out} ({final:.2f}s, target {total:.2f}s)")

    # A short mix is not a cosmetic problem: reframe.js muxes this file with
    # -shortest, so a truncated bed silently truncates the finished VIDEO. Fail
    # loudly instead of shipping a clip that ends early.
    if final is None:
        sys.exit("[music] could not determine output duration")
    if final < total - 0.5:
        sys.exit(
            f"[music] output is {total - final:.2f}s shorter than the voice track "
            f"({final:.2f}s vs {total:.2f}s). This would truncate the final video. "
            f"Try --loop, or pick a longer music track."
        )


if __name__ == "__main__":
    main()
