# B2E — re-dub a video into English

Takes a video (or a YouTube URL), transcribes it, translates to English, synthesises
an English voice-over, beds music underneath it, and outputs a re-framed video with
burned-in English subtitles.

## The full run

This is the complete command, with every option in one place. It is the one to copy:

```bash
node src/B2E/b2e.js 
  --url "https://youtu.be/cSHA7whQKmk" 
  --source-lang bn
  --provider local
  --local-model claude-fable-free
  --voice natural
  --music "Taking Flight"
  --whisper-model large-v3
  --trim-start 29
  --trim-end 10
  --crop 5
  --width 1920
  --height 1080
```

Output: `src/B2E/output/<title>_english.mp4`, 1920x1080, ready to upload.

### What each flag does

| Flag | Effect here |
| --- | --- |
| `--url` | downloads with `yt-dlp` (cached; re-runs never re-download) |
| `--source-lang bn` | source language. **Required for anything not Bangla** |
| `--provider local` | translate via your local LLM instead of the free tier |
| `--local-model` | which model on that endpoint |
| `--voice natural` | conversational male narrator (*US Brian*) |
| `--music "Taking Flight"` | music bed from `src/audio/youtube/`, ducked under speech |
| `--whisper-model large-v3` | best transcription; use `small` for a fast draft |
| `--trim-start` / `--trim-end` | drop the intro and outro, in seconds |
| `--crop 5` | remove logos/watermarks: 5% off all four edges |
| `--width` / `--height` | output size, 1920x1080 by default |

The endpoint and API key come from `src/B2E/local-llm.json` (gitignored), so they
are not repeated in the command. Override with `--local-base-url` / `--local-model`
or the `B2E_LOCAL_*` environment variables.

### Faster drafts

`large-v3` takes roughly 10 minutes per minute of audio on CPU. Swap it while
iterating:

```bash
node src/B2E/b2e.js --url "https://youtu.be/VIDEO_ID" --source-lang bn \
  --provider local --voice natural --music "Taking Flight" --whisper-model small
```

Stages are cached, so a re-run only redoes what changed — changing `--voice`
re-renders the clips, changing `--trim-*` redoes everything downstream, and changing
`--music` just re-mixes. Use `--force` to ignore the cache.

### A note on `--source-lang`

`transcribe.py` defaults to `bn`. If your source is **not** Bangla you must pass
`--source-lang`, or Whisper force-decodes it as Bangla and produces nonsense. For a
Bangla source, keep `bn`.

`--list-voices` and `--list-music` show the available options.

## Transcript only (URL in, transcript out)

For when you just want the words — no translation, no voice-over, no video — use
the standalone tool in [`src/transcribe/`](../transcribe/):

```bash
node src/transcribe/transcript.js https://youtu.be/hXNpj2RzZeg
```

It writes `out/<id>/transcript.txt`, `transcript.srt` and `segments.json`, and
prints the transcript to stdout. The download is shared with this pipeline's
cache, so transcribing there and dubbing here does not fetch the video twice.
See [`src/transcribe/README.md`](../transcribe/README.md).

### Transcribe as a pipeline stage

Stop after any stage with `--stop-after`. To get just the transcript, with no
translation, TTS or video:

```bash
node src/B2E/b2e.js --url "https://youtu.be/VIDEO_ID" \
  --source-lang bn --whisper-model large-v3 --stop-after transcribe
```

It downloads and transcribes, then stops. Three files land in
`src/B2E/work/<name>/`:

| File | What it is |
| --- | --- |
| `segments.json` | pipeline input: segments + word-level timings |
| `segments.srt` | **readable** — opens in any player or editor |
| `segments.txt` | one `[MM:SS,mmm] line of text` per segment |

The SRT and TXT are in the *source* language, so they're for checking what was
actually heard before spending a translation and TTS pass on a bad transcript.
Re-running with a different `--whisper-model` (or `--trim-*`) replaces all three.

Any other stage works the same way: `--stop-after extract`, `translate`, `synthesize`,
`assemble`, `music`, `reframe`.

### Stages

| # | Script | Does |
| --- | --- | --- |
| 0 | `ingest.js` | download a YouTube URL to a local mp4 via `yt-dlp` |
| 1 | `b2e.js` | extract 16 kHz mono WAV |
| 2 | `transcribe.py` | faster-whisper, word-level timestamps |
| 3 | `translate.py` | source language → English, segment count preserved |
| 4 | `synthesize.py` | `edge-tts` per segment, measure time-fit ratios |
| 5 | `assemble_audio.py` | fit and place clips on a silent timeline |
| 6 | `music_bed.py` | mix a music bed under the voice (optional) |
| 7 | `reframe.js` | logo crop, trim, reframe to target aspect, subtitles, mux |

### Choosing the narrator voice

`--voice` takes a short alias or any `edge-tts` voice name. The edge-tts default,
`en-US-GuyNeural`, is a "News, Novel / Passion" anchor voice — booming and formal.
That suits a re-dub because it matches the source register, but it is not what
most people mean by a *natural* narrator, which is why it is listed last below.

| Voice | Character |
| --- | --- |
| `en-US-BrianNeural` | approachable, casual, sincere — **most conversational** |
| `en-GB-RyanNeural` | friendly, positive, youthful British |
| `en-US-AndrewNeural` | warm, confident, authentic |
| `en-GB-ThomasNeural` | friendly, measured British |
| `en-CA-LiamNeural` | friendly Canadian |
| `en-US-RogerNeural` | lively, presenter-like |
| `en-US-ChristopherNeural` | reliable, authority |
| `en-US-GuyNeural` | news anchor, passionate (edge-tts default) |

Aliases so the intent is one word: `natural` / `casual` → Brian, `young` /
`british` → Ryan, `warm` / `confident` → Andrew, `friendly` → Thomas,
`news` → Roger, `anchor` → Guy.

```bash
node src/B2E/b2e.js --list-voices        # the table above
```

There are also rendered samples in `src/B2E/voice_samples/` — the same sentence
read by each candidate, so you can pick by ear rather than by description.

**Changing `--voice` re-renders the clips automatically.** The TTS cache records
which voice produced it, so switching narrators is detected and the affected
segments are re-synthesised rather than silently reusing the previous voice.
Transcription and translation stay cached, so a voice change is quick.

If a voice still sounds off, `--rate` and `--pitch` nudge it further
(`--rate +8%` sounds more energetic, `--pitch -2Hz` slightly deeper).

### The music bed

Music lives in **`src/audio/youtube/`**. That folder is the whole interface: drop
files in and they are picked up — no config, no flag to update. Current tracks:

```
Cutscene Crush - Blue Deer Studio.mp3          108s
Everything (feat. Rodina & Alfie Tito).mp3      267s
On The Flip - The Grey Room.mp3                183s
Taking Flight - Blue Deer Studio.mp3            106s
```

`--music` accepts a full path, a filename, or **any fragment of the title** — so
`--music flip` finds *On The Flip*, and `--music "Taking Flight"` works too. Omit
`--music` entirely and the first track alphabetically is used. `node src/B2E/b2e.js
--list-music` shows exactly what the resolver can see.

Auto-discovery only looks inside `src/audio/youtube/`, and skips sub-folders named
`voiceover`, `sfx`, `clip`, `short` and friends — `src/audio/` also contains
cartoon dialogue and sound effects, and none of that should ever be picked up as
a background bed by accident. An explicit `--music` can still reach any file under
`src/audio/` if you really want one.

The bed is **sidechain-ducked off the actual voice track** using ffmpeg's
`sidechaincompress`, not simply turned down. A constant low volume still masks
consonants; ducking off the real voice also means it stays correct after
time-fitting has shifted every clip.

Measured on the sample: the bed sits ~37 dB below the voice during speech and
recovers fully in the gaps. The voice is loudness-normalised to `--voice-lufs`
first, because the assembled dub is quiet and a relative music gain would
otherwise leave the music on top.

| Option | Default | Notes |
| --- | --- | --- |
| `--music` | first track found | path, filename, or title fragment; see above |
| `--list-music` | — | list available tracks and exit |
| `--music-db` | `-22` | bed level. `-30` is very subtle, `-16` is noticeable |
| `--duck` | `6` | sidechain ratio. `0` disables ducking entirely |
| `--duck-db` | `-12` | sidechain key depth; effect saturates near `-9` |
| `--loop` | auto | repeats the track when it is shorter than the video |

Most of these tracks are shorter than a typical video, so **looping is enabled
automatically** when the chosen track would otherwise run out — a bed that stops at
1:06 and leaves silence to the end reads as a mistake. `music_bed.py` also fails
loudly if the mix comes out shorter than the voice track, because `reframe.js` muxes
with `-shortest` and a short bed silently truncates the finished video.

The mix is written to `work/<name>/english_music.wav`; `english.wav` is kept as a
pure-voice reference so you can re-mix at a different level without re-running TTS.

### Ingesting YouTube

`ingest.js` also runs standalone:

```bash
node src/B2E/ingest.js --url <url> --quality 1080   # download
node src/B2E/ingest.js --url <url> --no-download    # metadata only
```

Downloads land in `src/input/youtube/<title>.mp4` and are cached, so re-dubbing
the same video never re-downloads. `--force` re-downloads.

**If downloads fail with `HTTP Error 403: Forbidden`**, your `yt-dlp` is too old
for YouTube's current challenge. `ingest.js` warns when the binary is more than
three months old; fix it with:

```bash
python -m pip install -U yt-dlp
```

This is the single most common ingest failure and it looks like a network fault
rather than an out-of-date binary, so it is worth checking first.

## Rights note — read this first

This pipeline does not grant you any rights to the footage you feed it. Cropping,
re-colouring, zooming or re-framing a video does **not** remove copyright, and
none of these stages are designed to defeat Content ID or fingerprinting.

What the pipeline does produce is a genuinely re-dubbed derivative work: a fresh
English voice track, a new translation, new pacing, new framing and new
subtitles. If your use is commentary, review, reaction or education, that
transformative character is what supports a fair-use argument. Fair use is
evaluated case by case, so:

- Use footage you own, have licensed, or that is public domain.
- Add real commentary or analysis rather than a straight re-dub.
- Don't present the result in a way that substitutes for the original.
- Be aware platforms can still claim or strike; consider appealing with evidence
  of your licence or commentary.

## Setup

```bash
pip install -r src/B2E/requirements.txt
```

Needs Python 3.9+ (verified on 3.14), Node, and ffmpeg. The scripts use whatever
`ffmpeg`/`ffprobe` is on `PATH`, falling back to the `@ffmpeg-installer` and
`@ffprobe-installer` binaries already in this repo's `node_modules`.

## Usage

```bash
# simplest
node src/B2E/b2e.js --input src/input/bangla.mp4

# pick a voice, use a better translator
node src/B2E/b2e.js --input src/input/bangla.mp4 \
  --voice en-GB-SoniaNeural --provider openai

# stop after a stage to inspect intermediate output
node src/B2E/b2e.js --input in.mp4 --stop-after transcribe
```

or `npm run b2e -- --input src/input/bangla.mp4`

| Option | Default | Notes |
| --- | --- | --- |
| `--input` | required | source video |
| `--voice` | `en-US-GuyNeural` | alias or `edge-tts` name; see *Choosing the narrator voice* |
| `--list-voices` | — | show narrator voices and aliases, then exit |
| `--rate` / `--pitch` | `+0%` / `+0Hz` | base TTS prosody |
| `--provider` | `mymemory` | `mymemory` (free) or `openai` (needs `OPENAI_API_KEY`) |
| `--whisper-model` | `large-v3` | Whisper model; use `medium`/`small` for a faster draft. `--model` is a legacy alias |
| `--translate-model` | provider default | translation model; only used by `--provider openai` |
| `--prompt` | Bangla steering text | initial prompt passed to Whisper, helps on music-heavy audio |
| `--min-ratio` / `--max-ratio` | `0.85` / `1.18` | time-fit comfort band |
| `--stop-after` | all | run up to a stage, then stop |
| `--force` | off | ignore cached stages |

Outputs land in `src/B2E/output/` and scratch files in `src/B2E/work/` (both
gitignored). Stages are cached, so re-running after tweaking a voice only redoes
the later half.

Caching is judged from each stage's actual artifacts, not from the existence of a
scratch directory: a JSON stage is cached only if its output parses and has a
non-empty `segments` list, and `synthesize` additionally requires that every mp3
its manifest references still exists on disk. Deleting `work/<name>/clips/` by hand
therefore re-triggers synthesis instead of silently producing a muted track.

### Translation providers

| Provider | Needs | Notes |
| --- | --- | --- |
| `mymemory` (default) | nothing | free, no key. Literal, occasionally rate-limited. Drafts only. |
| `openai` | `OPENAI_API_KEY` | best quality, costs per token |
| `local` | a running local LLM | free, private, no key. Best for Bangla → English. |

```bash
# local LLM: endpoint and model are detected automatically
node src/B2E/b2e.js --url <url> --source-lang bn --provider local

# or be explicit
--provider local --local-base-url http://127.0.0.1:11434/v1 --local-model qwen2.5:7b-instruct
```

`local` speaks the OpenAI-compatible `/v1/chat/completions` API, so it works with
**Ollama, LM Studio, llama.cpp, vLLM and LocalAI** without changing anything. It
probes these in order and uses the first that answers, preferring a chat/instruct
model over an embedding or audio model:

```
http://127.0.0.1:11434/v1   Ollama
http://127.0.0.1:1234/v1    LM Studio
http://127.0.0.1:8000/v1    llama.cpp / vLLM
http://127.0.0.1:8080/v1    LocalAI
```

With Ollama:

```bash
ollama serve
ollama pull qwen2.5:7b-instruct     # or qwen2.5:14b for better Bangla
node src/B2E/b2e.js --url <url> --source-lang bn --provider local
```

**Why segment alignment is defended twice.** Every downstream stage assumes
`output[i]` corresponds to `input[i]`; if a translator drops or reorders one, the
English drifts against the picture and nothing errors. Local models are much weaker
than hosted ones at returning a correctly-sized JSON array, so the batched call is
verified and, on any mismatch or failure, falls back to one call per line — which
cannot reorder or drop segments. Responses are also unwrapped from code fences and
from a stray `{"lines": [...]}` envelope, so JSON is never spoken aloud.

**Switching providers invalidates the translation cache.** The output records which
provider, model and language pair produced it, so moving from `mymemory` to `local`
re-translates rather than silently reusing the old wording.

### Saved local-LLM config

Put the endpoint, model and key in `src/B2E/local-llm.json` once and forget them:

```json
{
  "base_url": "http://127.0.0.1:20128/v1",
  "model": "claude-Fable-free",
  "api_key": "sk-..."
}
```

That file is **gitignored** because it holds a bearer token. Precedence is
flag > `B2E_LOCAL_*` environment variable > this file, so you can still override
per run:

```bash
node src/B2E/b2e.js --url <url> --source-lang bn --provider local
node src/B2E/b2e.js --url <url> --source-lang bn --provider local --local-model kr/claude-sonnet-4
```

**Proxies that always stream.** Some OpenAI-compatible servers ignore
`"stream": false` and answer with Server-Sent Events regardless. `translate.py`
detects that and reassembles the `data:` chunks, so no extra flag is needed — but
it is the first thing to check if a new endpoint appears to hang or return a JSON
parse error.

## How time-fitting works

This is the part that decides whether the result feels professional.

English and Bangla do not occupy the same number of seconds. Since
`atempo=X` produces a clip of length `tts_duration / X`, each segment gets:

```
ratio = english_clip_duration / original_slot_duration
```

`ratio > 1` means the English ran long, so it is sped up; `ratio < 1` means it
ran short, so it is slowed down. Either way the result fills the original slot,
and `adelay` places it at the original start time so the picture and the new
voice stay in step.

Ratios outside `--min-ratio`/`--max-ratio` are clamped and flagged
`needs_review`, and the flagged segments are listed by `assemble_audio.py`. A
robotic voice across every line is a worse outcome than slight drift on one of
them, which is why the pipeline refuses to stretch speech arbitrarily far.

If many segments come back flagged, the usual causes are a weak translation
(switch to `--provider openai`) or source segments that are too short for
English (`--min-ratio` down, or edit `segments.json` to merge neighbours).

## Handling music-heavy sources

The supplied sample is a comedy skit over a continuous music bed. That combination
is what makes naive transcription fail, and the pipeline defends against it in the
`extract` and `transcribe` stages:

- **Normalisation on extract.** The source track is hard-clipped at 0 dB, so
  `highpass=f=100` plus `loudnorm=I=-16:TP=-1.5:LRA=11` and `alimiter=limit=0.97`
  re-establish a speech-friendly level. This alone lifted speech coverage on the
  sample from ~25% to ~81%.
- **VAD + anti-hallucination flags.** `vad_filter` with
  `min_silence_duration_ms=400` skips the instrumental stretches;
  `condition_on_previous_text=False` stops the decoder feeding its own output back
  in, which is what caused ten-second repetition loops; `no_speech_threshold` and
  `compression_ratio_threshold` reject degenerate windows, with a temperature
  ladder and a repetition post-filter as backstops.
- **Timing repair.** Music-heavy audio yields degenerate *word* alignments: a
  single token can be stretched across 13 seconds of instrumental. Such a segment
  would force the English dub to be stretched over that whole span, so
  `transcribe.py` clamps any word longer than `--max-word-dur` (2.0s) and splits a
  segment wherever consecutive words are more than `--max-gap` (0.7s) apart. On the
  sample this turned a 31.6s segment into three real speech slots with all 54 words
  preserved. Only timing changes; no text is dropped.

If accuracy still matters more than turnaround, the real fix is source separation
(a Demucs-style vocals/instrumental split fed to `transcribe.py` instead of the
normalised track). That is not wired in, and on CPU it costs more than the whole
rest of the pipeline.

### Trimming the head and tail

Intro and outro are usually the parts you do not want. Skip them with:

```bash
--trim-start 29      # drop the first 29 seconds
--trim-end 10        # drop the last 10 seconds
--duration 120       # keep exactly 120s (overrides --trim-end)
```

```bash
node src/B2E/b2e.js --url <url> --source-lang en --trim-start 29 --trim-end 10
```

**The trim is applied to the audio first, deliberately.** If only the picture were
trimmed, every transcribed segment would still carry a timestamp measured from the
original start, so the English dub would sit exactly `trimStart` seconds out of step
with the lips. Trimming the extracted audio makes every downstream timing relative
to the new zero point, and the video is then cut to match.

Changing the trim invalidates everything downstream of it (segments, translation,
clips, mix), because all of that was timed against the old window. It is detected
automatically rather than silently reusing stale work.

### Removing a logo or watermark

Crop margins off the source, as a percentage of each edge:

```bash
--crop 5                       # 5% off all four edges (usual case)
--crop-bottom 8                # just the bottom band
--crop-top 4 --crop-right 6    # asymmetric, for a corner bug
```

This crops the **source** before scaling, which is what makes it work: a corner
watermark is removed from the picture entirely, rather than merely falling outside
the target aspect (which a cover-crop alone would not do for a 16:9 source).

Typical values: a small corner bug needs 2–3%, a bottom banner strip 5–8%. If the
values are too aggressive the stage fails with the resulting dimensions rather
than producing a broken frame.

### Output size and quality

```bash
--width 1920 --height 1080     # 16:9 (default)
--width 1080 --height 1920     # 9:16 vertical, for Shorts/Reels
--width 1080 --height 1350     # 4:5 feed
--crf 18                       # better quality, smaller file (default 22)
--preset veryfast              # faster encode, bigger file
```

Set `B2E_BRAND_TEXT` to burn a channel name in, reusing the
`RacingSansOne-Regular.ttf` font already in `src/assets/`.

### Getting a sharp result

The default output is **1080x1920** (9:16, standard vertical for Shorts/Reels/
TikTok). What matters for sharpness is the *source*: a 720p download scaled up to
1080x1920 is a ~2.7x upscale and looks soft on a phone.

`reframe.js` therefore warns when the source is lower than the output:

```
[reframe] WARNING: source is 720p but output is 1920p (2.67x upscale, ...).
For a sharp result re-ingest with --quality 1080.
```

If you see that, the source file on disk is smaller than the source on YouTube.
`ingest.js` verifies the downloaded height and says so, and `--force` re-fetches
at the new quality:

```bash
node src/B2E/ingest.js --url <url> --quality 1080 --force
```

Note that `--force` is required: yt-dlp keeps an archive of completed downloads
and will otherwise skip the URL it has "already seen" and leave the old, smaller
file in place while still reporting success.

## Troubleshooting

- **Robotic / rushed voice** — too many `needs_review` segments. Improve the
  translation, or widen the band.
- **Speech drifts out of sync** — check the flagged segments first; a segment
  left at ratio 1.0 will not fill its slot.
- **`ffmpeg not found`** — install it, or `npm install` so the bundled binary
  is available.
- **Whisper very slow on CPU** — use `--model medium` or `small` while drafting.
- **Subtitles missing** — the SRT is written next to the manifest in
  `work/`; `reframe.js` only burns it if the path is passed.
