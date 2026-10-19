"""Locate a usable ffmpeg/ffprobe for duration probing.

Prefers whatever is on PATH, then falls back to the npm-installed binaries this
repo already depends on (@ffmpeg-installer / @ffprobe-installer), so the B2E
scripts work whether or not the user installed ffmpeg system-wide.
"""

import os
import shutil
import subprocess

_LOCAL_BIN = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "node_modules",
)


def require_json_path(package, key):
    """Read the installed binary path out of an @*-installer package.json."""
    pkg_json = os.path.join(_LOCAL_BIN, package, "package.json")
    if not os.path.isfile(pkg_json):
        return None
    import json

    with open(pkg_json, encoding="utf-8") as fh:
        meta = json.load(fh)
    if meta.get("version", "").startswith("placeholder"):
        return None
    rel = meta.get(key)
    if not rel:
        return None
    candidate = os.path.join(_LOCAL_BIN, package, rel)
    return candidate if os.path.isfile(candidate) else None


def find_ffprobe():
    found = shutil.which("ffprobe")
    if found:
        return found
    return _node_binary("@ffprobe-installer/ffprobe", "path")


def find_ffmpeg():
    found = shutil.which("ffmpeg")
    if found:
        return found
    return _node_binary("@ffmpeg-installer/ffmpeg", "path")


def probe_duration(path):
    """Duration in seconds, or None if it cannot be determined."""
    ffprobe = find_ffprobe()
    if not ffprobe:
        raise RuntimeError("ffprobe not found on PATH and no local installer found")

    try:
        result = subprocess.run(
            [
                ffprobe,
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                path,
            ],
            capture_output=True,
            text=True,
            timeout=60,
        )
    except subprocess.TimeoutExpired:
        return None

    if result.returncode != 0:
        return None

    try:
        value = float(result.stdout.strip())
    except (TypeError, ValueError):
        return None

    return value if value > 0 else None
