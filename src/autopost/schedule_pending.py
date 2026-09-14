#!/usr/bin/env python3
"""
Automation entry point for cartoonMornings reels: upload + server-side
scheduling ONLY (video generation is a separate, manual step).

One cycle:
  1. validate the FB page token (stop cleanly, exit 2, if dead)
  2. find .mp4 reels in the reels dir not yet uploaded/scheduled
  3. queue them on Facebook (video_state=SCHEDULED) starting strictly
     AFTER the last already-scheduled reel, random 2-3h gaps
  4. heartbeat + append the poster's output to the shared log

Facebook publishes scheduled reels on its own servers, so this script only
needs to run when NEW reels should be queued.

Usage:
  python schedule_pending.py            # one cycle, then exit (Scheduled Task)
  python schedule_pending.py --loop     # cycle every 3h, heartbeat + pidfile
  python schedule_pending.py --dry      # preview only (no token check, no upload)

Exit codes: 0 = ok / nothing to do, 2 = token needs re-auth, else node's.
"""
import json
import os
import random
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent          # src/autopost
REPO = HERE.parent.parent                        # project root
NODE_POSTER = HERE / "postReelsFB.js"
CONFIG = HERE / "config" / "fb.json"
STATE = HERE / "config" / "reelsfb-state.json"
HEARTBEAT = HERE / "config" / "reelsfb-heartbeat.txt"
LOG = HERE / "config" / "reelsfb-cron.log"
PIDFILE = HERE / "config" / "reelsfb-autopost.pid"

GAP_MIN_MIN = 120   # minutes between queued publishes (random 120..180)
GAP_MAX_MIN = 180
FIRST_DELAY_MIN = 60  # first new reel ~1h out when nothing is queued yet
INTERVAL_HOURS = 3    # --loop mode: how often to look for new reels

EXPIRY_MARKERS = (
    "Session has expired",
    "Error validating access token",
    "pages_manage_posts permission",
    "invalid character",
)
STOP_MESSAGE = (
    "STOPPED: Facebook token expired or permission lost. Re-run "
    "oauth_fb_token.py in src/autopost/ (approve the browser prompt) to "
    "mint a fresh long-lived page token. Reels already scheduled on "
    "Facebook are unaffected - only NEW uploads need the token."
)

# Windows consoles default to legacy code pages and reel filenames contain
# emoji; make every print/decode safe regardless of locale.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def heartbeat(msg):
    try:
        HEARTBEAT.write_text(f"{now_iso()} {msg}\n", encoding="utf-8")
    except OSError:
        pass


def log_and_print(line):
    print(line, flush=True)
    try:
        with LOG.open("a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass


def load_json(path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def token_alive(cfg):
    """Quick GET /{pageId} - True if the page token still works."""
    url = (
        f"https://graph.facebook.com/{cfg['graphVersion']}/{cfg['pageId']}"
        f"?fields=id&access_token={cfg['pageAccessToken']}"
    )
    try:
        with urllib.request.urlopen(url, timeout=15) as r:
            return json.load(r).get("id") == str(cfg["pageId"])
    except Exception as exc:
        log_and_print(f"[{now_iso()}] token check failed: {exc}")
        return False


def pending_reels(cfg, state):
    """Mirror the poster's eligibility: not in posted, not in skipped."""
    reels_dir = REPO / cfg.get("reelsDir", "src/output/partOutput/reelsFB")
    if not reels_dir.is_dir():
        return []
    posted = state.get("posted", {})
    skipped = state.get("skipped", {})
    return sorted(
        f.name
        for f in reels_dir.glob("*.mp4")
        if f.name not in posted and f.name not in skipped
    )


def next_start_ts(state):
    """Queue strictly AFTER the last already-scheduled reel so publishes
    never bunch up. If the queue tail is past (all published), start ~1h
    from now."""
    last = None
    for v in state.get("posted", {}).values():
        sf = v.get("scheduledFor")
        if not sf:
            continue
        t = datetime.fromisoformat(sf.replace("Z", "+00:00"))
        if last is None or t > last:
            last = t
    now = datetime.now(timezone.utc)
    if last is None or last <= now:
        return int(now.timestamp()) + FIRST_DELAY_MIN * 60
    return int(last.timestamp()) + random.randint(GAP_MIN_MIN, GAP_MAX_MIN) * 60


def cycle(dry, viral=False):
    """One upload+scheduling pass. Returns process exit code."""
    cfg = load_json(CONFIG, None)
    if not cfg or not str(cfg.get("pageAccessToken", "")).strip():
        if not dry:
            heartbeat("STOP: fb.json missing/token empty")
        log_and_print(f"[{now_iso()}] {STOP_MESSAGE}")
        return 2

    # A live run must prove the token works before uploading anything.
    if not dry and not token_alive(cfg):
        heartbeat("STOP: token expired/invalid")
        log_and_print(f"[{now_iso()}] {STOP_MESSAGE}")
        return 2

    state = load_json(STATE, {"posted": {}, "skipped": {}})
    pending = pending_reels(cfg, state)

    if not pending:
        if not dry:
            heartbeat("nothing new")
        log_and_print(f"[{now_iso()}] 0 pending reels - nothing to do.")
        return 0

    # Viral mode schedules from "now" so the first slot is today; otherwise we
    # queue strictly after the last already-scheduled reel.
    start_ts = int(time.time()) if viral else next_start_ts(state)
    start_iso = datetime.fromtimestamp(start_ts, tz=timezone.utc).isoformat()
    log_and_print(
        f"[{now_iso()}] === schedule_pending dry={dry} viral={viral} === "
        f"{len(pending)} pending reel(s), first publish {start_iso}"
    )

    cmd = [
        "node", str(NODE_POSTER), "--schedule",
        f"--start={start_ts}",
        f"--gap-min={GAP_MIN_MIN}",
        f"--gap-max={GAP_MAX_MIN}",
    ]
    if viral:
        cmd.append("--viral")
    if dry:
        cmd.append("--dry")

    # Decode explicitly (not text=True): poster output has emoji filenames
    # that would crash a cp1252 decode on some Windows setups.
    proc = subprocess.run(cmd, cwd=str(REPO), capture_output=True)
    text = (
        proc.stdout.decode("utf-8", errors="replace")
        + proc.stderr.decode("utf-8", errors="replace")
    )
    if text.strip():
        log_and_print(text.rstrip())
    log_and_print(f"[{now_iso()}] === schedule_pending exit {proc.returncode} ===")

    if any(m in text for m in EXPIRY_MARKERS):
        if not dry:
            heartbeat("STOP: token expired/permission")
        log_and_print(f"[{now_iso()}] {STOP_MESSAGE}")
        return 2

    if not dry:
        heartbeat("cycle ok" if proc.returncode == 0 else f"cycle exit {proc.returncode}")
    return proc.returncode


def acquire_lock():
    pid = os.getpid()
    if PIDFILE.exists():
        try:
            old = int(PIDFILE.read_text().strip())
        except (ValueError, OSError):
            old = None
        if old and old != pid:
            # No reliable /proc on Windows; warn and take over the lock.
            print(f"[{now_iso()}] warning: overwriting stale pid {old}", flush=True)
    PIDFILE.write_text(str(pid), encoding="utf-8")
    return pid


def main():
    dry = "--dry" in sys.argv
    loop = "--loop" in sys.argv
    viral = "--viral" in sys.argv

    if loop:
        pid = acquire_lock()
        print(f"[{now_iso()}] schedule_pending loop pid={pid}", flush=True)
        while True:
            code = cycle(dry=False, viral=viral)  # a live loop never dry-runs
            if code == 2:
                sys.exit(2)  # token dead: stop, ask for re-auth
            print(f"[{now_iso()}] sleeping {INTERVAL_HOURS}h ...", flush=True)
            time.sleep(INTERVAL_HOURS * 3600)

    sys.exit(cycle(dry, viral))


if __name__ == "__main__":
    main()
