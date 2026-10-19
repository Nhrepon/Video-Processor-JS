# transcribe — a YouTube URL in, a transcript out

Standalone transcription. Give it a video URL, get back the transcript. No
translation, no voice-over, no video rendering.

```bash
node src/transcribe/transcript.js https://youtu.be/hXNpj2RzZeg
```

Progress goes to **stderr**; the transcript goes to **stdout** and nothing else, so
you can pipe or redirect it:

```bash
node src/transcribe/transcript.js <url> > notes.txt
```

## Output

Written to `out/<video id>/` (gitignored):

| File | Contents |
| --- | --- |
| `transcript.txt` | `[MM:SS,mmm] text`, one line per segment |
| `transcript.srt` | subtitles — opens in any player or editor |
| `segments.json` | segments + word-level timings |

`segments.json` is the format the B2E dubbing pipeline consumes, so a transcript
made here can be re-used there instead of re-running Whisper.

## Options

| Option | Default | Notes |
| --- | --- | --- |
| `--lang <code>` | `en` | Whisper is **forced** to this. Wrong language means the wrong script. |
| `--model <name>` | `small` | `tiny` / `base` for speed, `medium`, `large-v3` for accuracy |
| `--out <dir>` | `out/<id>` | where to write |
| `--quality <q>` | `720` | only audio is needed, so a low cap is fine |
| `--no-video` | off | audio-only download — faster and much smaller |
| `--quiet` | off | write the files, print nothing |
| `--force` | off | re-download and re-transcribe |

## Model speed vs accuracy

`small` took ~2.5 minutes for a 6-minute video. Roughly, on CPU:

| Model | Speed | Quality |
| --- | --- | --- |
| `tiny` / `base` | very fast | poor — use only to check a pipeline works |
| `small` | ~3 min / 6 min | usable on clean audio, fails on music-heavy intros |
| `medium` | ~3x slower | noticeably better |
| `large-v3` | ~10x slower | best, especially for Bangla |

**Music and noise are what break transcription.** If a video has a music bed or
intro effects, `small` produces mixed-script nonsense for those sections while the
clean parts come out fine. That is the model, not the tool — use `large-v3` for
anything with a heavy soundtrack.

## Files

| File | Role |
| --- | --- |
| `transcript.js` | this tool: URL → download → audio → transcribe → files |
| `transcribe.py` | the Whisper engine (also used by the B2E pipeline) |

`transcript.js` borrows `ingest.js` from the B2E folder for downloading, so the
same video is never fetched twice if you later run the full dubbing pipeline.
