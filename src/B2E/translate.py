"""
Stage 3: translate Bangla segments to English, preserving segment count.

The hard requirement: output[i] must correspond to input[i]. If the translator
drops, merges, or reorders a segment, every downstream audio placement is
silently wrong -- the English drifts against the picture and nothing errors.
So this stage asserts an exact 1:1 mapping and fails loudly otherwise.

Three providers are supported:

  mymemory  (default) - free, no API key, HTTP. Lower quality, occasional
                        rate limiting. Fine for drafts and short clips.
  openai             - better quality and handles tone/context properly.
                        Needs OPENAI_API_KEY.
  local              - any OpenAI-compatible local server (Ollama, LM Studio,
                        llama.cpp, vLLM, LocalAI). No API key, no cost, no
                        data leaves the machine. The endpoint and model are
                        auto-detected unless overridden.

Run:  python src/B2E/translate.py --segments <in.json> --out <out.json>
"""

import argparse
import json
import os
import sys

# Windows consoles default to a legacy code page (cp1252), so printing Bengali or
# other non-Latin text raises UnicodeEncodeError and kills the run. Same guard as
# src/autopost/build_captions.py.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except (AttributeError, ValueError):  # pragma: no cover
    pass
import time
import urllib.parse
import urllib.request

USER_AGENT = "B2E-dubbing-pipeline/1.0"

# Optional saved defaults for provider=local, so a long-lived local endpoint and
# its key do not have to be retyped on every run. Values here are only defaults:
# command-line flags and environment variables still win. The file is gitignored
# because it holds a bearer token.
LOCAL_CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "local-llm.json")


def load_local_config():
    """Read saved local-LLM defaults, if the file exists and parses."""
    try:
        with open(LOCAL_CONFIG_PATH, encoding="utf-8") as fh:
            cfg = json.load(fh)
        return cfg if isinstance(cfg, dict) else {}
    except Exception:
        return {}

# MyMemory caps requests at 500 chars; stay well under it.
MAX_CHARS = 450
MAX_RETRIES = 3


def parse_args():
    p = argparse.ArgumentParser(description="Translate Bangla segments to English.")
    # Not required, because --list-models runs standalone without any file I/O.
    p.add_argument("--segments", help="segments JSON from transcribe.py")
    p.add_argument("--out", help="output JSON path")
    p.add_argument("--provider", default=os.environ.get("B2E_TRANSLATE_PROVIDER", "mymemory"))
    p.add_argument("--model", default=os.environ.get("B2E_OPENAI_MODEL", "gpt-4o-mini"))
    p.add_argument("--source-lang", default="bn")
    p.add_argument("--target-lang", default="en")
    # Precedence: explicit flag > environment > saved local-llm.json.
    cfg = load_local_config()
    saved_key = cfg.get("api_key")

    def pick(flag, env_name, cfg_key):
        if flag:
            return flag
        if env_name and os.environ.get(env_name):
            return os.environ[env_name]
        return cfg.get(cfg_key)

    p.add_argument(
        "--local-base-url",
        default=pick(None, "B2E_LOCAL_BASE_URL", "base_url"),
        help="OpenAI-compatible endpoint for provider=local (default: auto-detect)",
    )
    p.add_argument(
        "--local-model",
        default=pick(None, "B2E_LOCAL_MODEL", "model"),
        help="model name for provider=local (default: auto-detect from /models)",
    )
    p.add_argument(
        "--local-api-key",
        default=pick(None, "B2E_LOCAL_API_KEY", "api_key") or saved_key,
        help=(
            "bearer token for provider=local. Not needed for plain Ollama/LM Studio, "
            "but required by authenticated proxies. Prefer the B2E_LOCAL_API_KEY "
            "environment variable or local-llm.json so the key stays out of shell "
            "history and process listings."
        ),
    )
    p.add_argument("--list-models", action="store_true",
                   help="list models offered by the local endpoint, then exit")
    return p.parse_args()


def http_post_json(url, payload, headers, timeout=60):
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def split_long(text, limit=MAX_CHARS):
    """Split an over-long segment on sentence boundaries, then words."""
    if len(text) <= limit:
        return [text]

    parts, buf = [], ""
    for sentence in text.replace("\n", " ").split(". "):
        candidate = f"{buf}. {sentence}".strip() if buf else sentence
        if len(candidate) <= limit:
            buf = candidate
            continue

        if buf:
            parts.append(buf)
            buf = ""
        if len(sentence) <= limit:
            buf = sentence
            continue

        # Single sentence longer than the limit: fall back to word packing.
        chunk = ""
        for word in sentence.split():
            if chunk and len(chunk) + 1 + len(word) > limit:
                parts.append(chunk)
                chunk = word
            else:
                chunk = f"{chunk} {word}".strip()
        buf = chunk

    if buf:
        parts.append(buf)
    return parts


# MyMemory answers some failures with HTTP 200 and an error message in
# responseData.translatedText rather than a non-2xx status, so a plain
# "is it non-empty" check silently accepts the error as the translation. This is
# what turns an en->en request (or an unsupported pair) into a dub of
# "PLEASE SELECT TWO DISTINCT LANGUAGES" spoken aloud.
_API_ERROR_MARKERS = (
    "please select two distinct languages",
    "invalid language pair",
    "no translation",
    "mymemory warning",
    "quota exceeded",
    "you have exceeded",
    "invalid query",
)


def is_api_error(text):
    """True when the API returned a diagnostic instead of a translation."""
    low = text.strip().lower()
    return any(marker in low for marker in _API_ERROR_MARKERS)


def translate_mymemory(text, source_lang, target_lang):
    joined, chunk_id = [], 0
    for piece in split_long(text):
        for attempt in range(MAX_RETRIES):
            try:
                params = urllib.parse.urlencode(
                    {"q": piece, "langpair": f"{source_lang}|{target_lang}"}
                )
                url = f"https://api.mymemory.translated.net/get?{params}"
                req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
                with urllib.request.urlopen(req, timeout=30) as resp:
                    body = json.loads(resp.read().decode("utf-8"))
                translated = (body.get("responseData", {}).get("translatedText") or "").strip()
                # responseStatus is 200 for both real translations and soft errors.
                if translated and not is_api_error(translated):
                    joined.append(translated)
                    chunk_id += 1
                    break
            except Exception:
                pass
            time.sleep(1.5 * (attempt + 1))
        else:
            # Preserve the original so the slot still gets audio.
            joined.append(piece)
            print(f"[translate] segment {chunk_id} failed, keeping source text")
        time.sleep(0.4)  # stay polite with the free tier
    return " ".join(joined).strip()


def translate_openai_batch(texts, source_lang, target_lang, model):
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        sys.exit("[translate] OPENAI_API_KEY is required for provider=openai")

    payload = {
        "model": model,
        "temperature": 0.2,
        "response_format": {"type": "json_object"},
        "messages": [
            {
                "role": "system",
                "content": (
                    "You are a subtitle translator for re-dubbing video. "
                    f"Translate {source_lang} to natural {target_lang}. "
                    'Return a JSON object of the form {"lines": ["...", ...]} '
                    "with EXACTLY the same number of entries as the input, in the "
                    "same order, one per input line. Never merge, split, drop or "
                    "reorder lines. Keep lines concise enough to be spoken in the "
                    "same time as the original. Do not number the lines."
                ),
            },
            {"role": "user", "content": json.dumps({"lines": texts}, ensure_ascii=False)},
        ],
    }

    for attempt in range(MAX_RETRIES):
        try:
            body = http_post_json(
                "https://api.openai.com/v1/chat/completions",
                payload,
                {"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"},
            )
            content = body["choices"][0]["message"]["content"]
            return json.loads(content)["lines"]
        except Exception as exc:
            if attempt == MAX_RETRIES - 1:
                sys.exit(f"[translate] OpenAI translation failed: {exc}")
            time.sleep(2 * (attempt + 1))
    return texts

# Candidate OpenAI-compatible local servers, probed in order. Ollama and LM Studio
# both expose /v1/chat/completions; the rest cover other common local runners so the
# same flag works without reconfiguring anything.
LOCAL_CANDIDATES = [
    ("http://127.0.0.1:11434/v1", "Ollama"),
    ("http://127.0.0.1:1234/v1", "LM Studio"),
    ("http://127.0.0.1:8000/v1", "llama.cpp / vLLM"),
    ("http://127.0.0.1:8080/v1", "LocalAI"),
]


def http_get_json(url, timeout=5, api_key=None):
    headers = {"User-Agent": USER_AGENT}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def discover_local(base_url=None, model=None, api_key=None):
    """Find a running local LLM server and a usable model name.

    Returns (base_url, model, label). Explicit settings win; otherwise each
    candidate endpoint is probed for a /models listing.
    """
    if base_url:
        base, label = base_url.rstrip("/"), "configured"
    else:
        base, label = None, None
        for cand, name in LOCAL_CANDIDATES:
            try:
                http_get_json(f"{cand}/models", timeout=2, api_key=api_key)
                base, label = cand, name
                break
            except Exception:
                continue
        if not base:
            tried = ", ".join(c for c, _ in LOCAL_CANDIDATES)
            sys.exit(
                "[translate] no local LLM server found. Start one (e.g. `ollama serve`)\n"
                "           or point at it explicitly:\n"
                "             --local-base-url http://host:port/v1 --local-model <name>\n"
                f"           probed: {tried}"
            )

    if not model:
        try:
            listing = http_get_json(f"{base}/models", timeout=10, api_key=api_key)
            names = [m.get("id") or m.get("name") for m in listing.get("data", [])]
            names = [n for n in names if n]
            if not names:
                sys.exit(
                    f"[translate] {label} at {base} reports no models. "
                    f"Pull one first, e.g. `ollama pull qwen2.5:7b-instruct`."
                )
            # Prefer a chat/instruct model over an embedding or audio model that
            # happens to be present.
            preferred = [
                n for n in names
                if any(k in n.lower() for k in
                       ("instruct", "chat", "it", "s", "llama", "qwen", "gemma", "mistral"))
                and not any(k in n.lower() for k in
                            ("embed", "vision", "clip", "whisper", "tts", "ocr"))
            ]
            model = (preferred or names)[0]
        except Exception as exc:
            sys.exit(f"[translate] could not list models at {base}: {exc}")

    print(f"[translate] local LLM: {label} at {base} (model: {model})")
    return base, model, label


def _extract_lines(content):
    """Pull the lines array from a model response, tolerating prose and code fences."""
    if isinstance(content, list):  # some servers return content parts
        content = "".join(p.get("text", "") for p in content if isinstance(p, dict))
    text = (content or "").strip()
    if text.startswith("```"):
        text = text[3:]
        if text.lower().startswith("json"):
            text = text[4:]
        text = text.split("```")[0].strip()
    try:
        data = json.loads(text)
        if isinstance(data, dict) and "lines" in data:
            return data["lines"]
        if isinstance(data, list):
            return data
    except json.JSONDecodeError:
        pass
    # Last resort: the first JSON array anywhere in the response.
    start, end = text.find("["), text.rfind("]")
    if start != -1 and end > start:
        try:
            return json.loads(text[start : end + 1])
        except json.JSONDecodeError:
            return None
    return None


DEFAULT_LOCAL_TIMEOUT = 240


class ModelNotFound(SystemExit):
    """Raised when the endpoint rejects the model name.

    This is a configuration error, not a transient failure, so it must abort the
    run. Silently falling back would put the SOURCE text through the dubbing
    pipeline, which then speaks Bengali with an English voice.
    """


def _http_error_text(exc):
    try:
        return exc.read().decode("utf-8", "replace")
    except Exception:
        return ""


def post_chat(base_url, payload, headers, timeout=None):
    """POST to /chat/completions and return the assistant's text.

    Some OpenAI-compatible proxies (including the one on port 20128) ignore
    "stream": false and always answer with Server-Sent Events. json.loads() on
    that body raises, so the SSE form is detected and reassembled here: each
    `data:` chunk's delta.content is concatenated until the [DONE] sentinel or
    a finish_reason.
    """
    req = urllib.request.Request(
        f"{base_url}/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        resp_ctx = urllib.request.urlopen(req, timeout=timeout or DEFAULT_LOCAL_TIMEOUT)
    except urllib.error.HTTPError as exc:
        body = _http_error_text(exc)
        # 404/400 on a chat call almost always means the model id is wrong -- the
        # ids on these proxies are case-sensitive, so "claude-fable-free" 404s
        # while "claude-Fable-free" works. Abort rather than fall through to the
        # per-line path, which would emit the untranslated source.
        if exc.code in (400, 404, 422):
            raise ModelNotFound(
                f"[translate] the endpoint rejected model {payload.get('model')!r} "
                f"(HTTP {exc.code}).\n"
                f"           server said: {body[:300]}\n"
                f"           Model ids are case-sensitive, and the endpoint may lack\n"
                f"           credentials for that provider. To see what is available:\n"
                f"             node src/B2E/b2e.js --list-models\n"
                f"           Then fix the name in --local-model or src/B2E/local-llm.json."
            ) from None
        raise
    with resp_ctx as resp:
        ctype = (resp.headers.get("Content-Type") or "").lower()
        # A socket timeout alone is NOT a total deadline: it applies per read, so a
        # server that holds an SSE connection open without ever finishing never trips
        # it (observed: still waiting after 4+ minutes against a "240s" timeout). The
        # body is therefore read in chunks against a wall-clock deadline.
        deadline = time.monotonic() + (timeout or DEFAULT_LOCAL_TIMEOUT)
        chunks = []
        while True:
            if time.monotonic() > deadline:
                raise TimeoutError(
                    f"endpoint did not finish within {timeout or DEFAULT_LOCAL_TIMEOUT}s"
                )
            chunk = resp.read1(65536) if hasattr(resp, "read1") else resp.read(65536)
            if not chunk:
                break
            chunks.append(chunk)
        raw = b"".join(chunks).decode("utf-8", "replace")
    # Try an ordinary JSON body FIRST. Some proxies answer with a normal JSON
    # completion but label it `text/event-stream` and append a `data: [DONE]`
    # sentinel; parsing only `data:` lines then finds nothing and reports a bogus
    # "no content deltas". Strip the sentinel and try json.loads before falling
    # back to real SSE reassembly.
    stripped = raw.strip()
    if stripped.endswith("data: [DONE]"):
        stripped = stripped[: -len("data: [DONE]")].strip()
    if stripped.startswith("{"):
        try:
            return json.loads(stripped)
        except json.JSONDecodeError:
            pass

    if "text/event-stream" not in ctype and not raw.lstrip().startswith(("data:", "event:")):
        return json.loads(raw)  # ordinary JSON response

    parts = []
    for line in raw.splitlines():
        line = line.strip()
        if not line.startswith("data:"):
            continue
        data = line[5:].strip()
        if not data or data == "[DONE]":
            continue
        try:
            chunk = json.loads(data)
        except json.JSONDecodeError:
            continue
        for choice in chunk.get("choices", []):
            delta = choice.get("delta") or {}
            piece = delta.get("content")
            if piece is None:
                # Some servers put the text in message instead of delta.
                piece = (choice.get("message") or {}).get("content")
            if piece:
                parts.append(piece)
    if not parts:
        raise ValueError("SSE response contained no content deltas")
    return {"choices": [{"message": {"content": "".join(parts)}}]}


def translate_local_batch(texts, source_lang, target_lang, model, base_url, api_key=None):
    """Translate a batch through an OpenAI-compatible local endpoint.

    Small local models are far less reliable than a hosted one about returning a
    JSON array of exactly the right length, so the 1:1 mapping is defended twice:
    the batched JSON call is tried first, and on any mismatch or failure it falls
    back to one call per line, which cannot reorder or drop segments.
    """
    system = (
        "You are a subtitle translator for re-dubbing video. "
        f"Translate {source_lang} into natural, idiomatic {target_lang} that a native "
        "speaker would actually say aloud. Preserve meaning, register and tone; do not "
        "translate literally. "
        'Return ONLY a JSON object: {"lines": ["...", ...]} with EXACTLY the same number '
        "of entries as the input, in the same order, one per input line. Never merge, "
        "split, drop or reorder. Keep each line short enough to be spoken in the same "
        "time as the original. No numbering, no commentary, no notes."
    )
    payload = {
        "model": model,
        "temperature": 0.3,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": json.dumps({"lines": texts}, ensure_ascii=False)},
        ],
    }
    # Local servers vary in whether they accept response_format; a rejected field
    # would fail the whole batch, so the call is retried without it.
    strict = dict(payload, response_format={"type": "json_object"})
    headers = {"Content-Type": "application/json", "Authorization": f"Bearer {api_key or 'local'}"}

    for candidate in (strict, payload):
        try:
            body = post_chat(base_url, candidate, headers)
            lines = _extract_lines(body["choices"][0]["message"]["content"])
            if lines and len(lines) == len(texts):
                return [str(x).strip() for x in lines]
            if lines:
                print(
                    f"[translate] local model returned {len(lines)} lines for "
                    f"{len(texts)} inputs; retrying line by line to keep them aligned."
                )
                break
        except Exception as exc:
            print(f"[translate] local batch call failed ({exc}); retrying line by line.")
            break

    out = []
    for i, text in enumerate(texts, 1):
        out.append(translate_local_one(text, source_lang, target_lang, model, base_url, api_key))
        if i % 10 == 0 or i == len(texts):
            print(f"[translate]   {i}/{len(texts)} lines")

    # Safety net: if nearly every line came back identical to the source, the
    # endpoint is not translating at all (wrong model, refused, or returning an
    # error string). Continue silently and the dub would speak the original
    # language with an English voice, so fail here instead.
    same = sum(1 for a, b in zip(texts, out) if a.strip() == b.strip())
    if texts and same >= max(1, int(len(texts) * 0.8)):
        raise ModelNotFound(
            f"[translate] {same}/{len(texts)} lines came back unchanged from model "
            f"{model!r} -- the endpoint is not translating.\n"
            f"           Check the model name and that it supports {source_lang}."
        )
    return out


def translate_local_one(text, source_lang, target_lang, model, base_url, api_key=None):
    """Translate a single line. Never raises: returns the source on failure."""
    payload = {
        "model": model,
        "temperature": 0.3,
        "messages": [
            {
                "role": "system",
                "content": (
                    f"Translate {source_lang} to natural {target_lang} for spoken video. "
                    "Reply with the translation only: no quotes, no notes, no explanation."
                ),
            },
            {"role": "user", "content": text},
        ],
    }
    headers = {"Content-Type": "application/json", "Authorization": f"Bearer {api_key or 'local'}"}
    # A hung model must not stall the whole run: one attempt per line, then keep
    # the source text. Retrying a non-responding endpoint just multiplies the wait
    # (observed: >14 min for 5 segments with no response at all).
    try:
        body = post_chat(base_url, payload, headers)
        out = (body["choices"][0]["message"]["content"] or "").strip()
        if not out:
            return text
        if out.startswith("```"):
            out = out[3:]
            if out.lower().startswith("json"):
                out = out[4:]
            out = out.split("```")[0]
        out = out.strip()

        # A model told to return JSON may wrap a single line in the same
        # {"lines": [...]} envelope it was asked for in batch mode. Left alone
        # that JSON gets spoken aloud, so unwrap it.
        if out.startswith("{"):
            try:
                data = json.loads(out)
                if isinstance(data, dict) and isinstance(data.get("lines"), list):
                    out = str(data["lines"][0]) if data["lines"] else ""
                elif isinstance(data, dict) and "translation" in data:
                    out = str(data["translation"])
            except json.JSONDecodeError:
                pass
        out = out.strip().strip('"').strip()
        return out or text
    except Exception:
        # Give up on this line and keep the source so the slot still has audio.
        return text


def main():
    args = parse_args()

    if args.list_models:
        base = (args.local_base_url or "").rstrip("/")
        if not base:
            for cand, name in LOCAL_CANDIDATES:
                try:
                    http_get_json(f"{cand}/models", timeout=2, api_key=args.local_api_key)
                    base = cand
                    break
                except Exception:
                    continue
        if not base:
            sys.exit("[translate] no local endpoint configured or detected")
        listing = http_get_json(f"{base}/models", timeout=15, api_key=args.local_api_key)
        names = [m.get("id") or m.get("name") for m in listing.get("data", [])]
        names = [n for n in names if n]
        print(f"{len(names)} models at {base}\n")
        for n in names:
            print(f"  {n}")
        return

    if not args.segments or not args.out:
        sys.exit("[translate] --segments and --out are required (or use --list-models)")

    with open(args.segments, encoding="utf-8-sig") as fh:
        data = json.load(fh)

    segments = data.get("segments", [])
    if not segments:
        sys.exit("[translate] no segments to translate")

    print(f"[translate] {len(segments)} segments via {args.provider}")

    # Records which backend actually produced the text, for the orchestrator's
    # cache check. Initialised here so every branch can set it.
    used_model = ""

    # Source and target the same language: the text is already in the right
    # language, so pass it through. Both backends reject an identical language pair
    # (MyMemory answers "PLEASE SELECT TWO DISTINCT LANGUAGES"), and spending a
    # request per segment to be told so is pure waste.
    if args.source_lang == args.target_lang:
        print(
            f"[translate] source and target are both {args.source_lang!r}; "
            f"passing text through untranslated"
        )
        translated = [s["text"] for s in segments]
    elif args.provider == "local":
        # Batches are smaller than for a hosted API: a local model has far less
        # context headroom, and a too-large batch is likelier to come back with the
        # wrong line count and force the slow per-line fallback.
        BATCH = 20
        local_base, local_model, _ = discover_local(
            args.local_base_url, args.local_model, args.local_api_key
        )
        used_model = local_model
        translated = []
        for start in range(0, len(segments), BATCH):
            batch = segments[start : start + BATCH]
            texts = [s["text"] for s in batch]
            print(
                f"[translate]   batch {start // BATCH + 1}/"
                f"{(len(segments) + BATCH - 1) // BATCH}: {len(texts)} segments"
            )
            lines = translate_local_batch(
                texts, args.source_lang, args.target_lang, local_model,
                local_base, args.local_api_key,
            )
            if len(lines) != len(texts):
                sys.exit(
                    f"[translate] FATAL: got {len(lines)} lines for {len(texts)} inputs. "
                    "Segment alignment would be lost -- aborting."
                )
            translated.extend(line.strip() for line in lines)
    elif args.provider == "openai":
        used_model = args.model
        # Batch in chunks to stay within token limits while keeping 1:1 order.
        BATCH = 40
        translated = []
        for start in range(0, len(segments), BATCH):
            batch = segments[start : start + BATCH]
            texts = [s["text"] for s in batch]
            print(f"[translate]   batch {start // BATCH + 1}: {len(texts)} segments")
            lines = translate_openai_batch(texts, args.source_lang, args.target_lang, args.model)
            if len(lines) != len(texts):
                sys.exit(
                    f"[translate] FATAL: got {len(lines)} lines for {len(texts)} inputs. "
                    "Segment alignment would be lost -- aborting."
                )
            translated.extend(line.strip() for line in lines)
    else:
        translated = [
            translate_mymemory(s["text"], args.source_lang, args.target_lang) for s in segments
        ]

    if len(translated) != len(segments):
        sys.exit(f"[translate] FATAL: {len(translated)} translations for {len(segments)} segments")

    out_segments = []
    for seg, english in zip(segments, translated):
        out_segments.append(
            {
                "id": seg["id"],
                "start": seg["start"],
                "end": seg["end"],
                "source_text": seg["text"],
                "text": english,
                "words": seg.get("words", []),
            }
        )

    data["segments"] = out_segments
    data["target_language"] = args.target_lang
    # Record which backend produced this text so the orchestrator can tell a
    # cached translation apart from one made by a different provider or model.
    data["translate_provider"] = {
        "provider": args.provider,
        "source_lang": args.source_lang,
        "target_lang": args.target_lang,
        "model": used_model or "",
    }

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)

    empty = sum(1 for s in out_segments if not s["text"])
    print(f"[translate] done -> {args.out}" + (f" ({empty} EMPTY - review!)" if empty else ""))


if __name__ == "__main__":
    main()
