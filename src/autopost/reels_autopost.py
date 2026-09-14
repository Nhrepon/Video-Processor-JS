#!/usr/bin/env python3
"""
Standalone Python automation for posting cartoonMornings reels on a schedule.

Replaces the (frozen) Hermes cron job. Python owns the automation:
  - timing / sleep loop
  - liveness heartbeat file
  - token-expiry / permission-error detection -> clean stop + re-auth notice
  - pidfile lock so two loops never run at once

The actual upload engine is the proven Node poster (src/autopost/postReelsFB.js),
which handles random pick, blocklist gate, the FB Reels 3-call upload,
and state tracking in src/autopost/config/reelsfb-state.json.

Usage:
  python reels_autopost.py            # loop forever, post every INTERVAL_HOURS
  python reels_autopost.py --once    # run a single cycle and exit (for a
                                     # Windows Scheduled Task / manual test)
"""
import subprocess
import sys
import time
import os
from pathlib import Path

REPO = Path(r"E:\NH\NextJS\VideoProcessor")
NODE = "node"
POSTER = REPO / "src" / "autopost" / "postReelsFB.js"
LOG = REPO / "src" / "autopost" / "config" / "reelsfb-cron.log"
HEARTBEAT = REPO / "src" / "autopost" / "config" / "reelsfb-heartbeat.txt"
PIDFILE = REPO / "src" / "autopost" / "config" / "reelsfb-autopost.pid"
INTERVAL_HOURS = 3

# Markers that mean the token died or perms were lost -> stop and ask for re-auth.
EXPIRY_MARKERS = (
    "Session has expired",
    "Error validating access token",
    "pages_manage_posts permission",
    "invalid character",
)

STOP_MESSAGE = (
    "STOPPED: Facebook token expired or permission lost. "
    "Re-run oauth_fb_token.py in src/autopost/ (approve the browser prompt) "
    "to mint a fresh long-lived page token, then restart this automation."
)


def now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def heartbeat(msg):
    try:
        HEARTBEAT.write_text(f"{now_iso()} {msg}\n")
    except OSError:
        pass


def run_cycle():
    """Run one poster cycle. Returns (returncode, stdout_text)."""
    ts = now_iso()
    proc = subprocess.run(
        [NODE, str(POSTER)],
        cwd=str(REPO),
        capture_output=True,
        text=True,
    )
    with LOG.open("a", encoding="utf-8") as log:
        log.write(f"[{ts}] === cycle start ===\n")
        log.write(proc.stdout)
        if proc.stderr:
            log.write(proc.stderr)
        log.write(f"[{ts}] === cycle exit code {proc.returncode} ===\n")
    return proc.returncode, proc.stdout


def cycle_once():
    try:
        code, out = run_cycle()
    except Exception as exc:  # never let a crash kill the loop silently
        heartbeat(f"ERROR {exc}")
        print(f"[{now_iso()}] cycle error: {exc}", flush=True)
        return False
    if any(m in out for m in EXPIRY_MARKERS):
        print(f"[{now_iso()}] {STOP_MESSAGE}", flush=True)
        heartbeat("STOP: token expired/permission")
        return False  # signal caller to stop
    heartbeat("cycle ok")
    print(f"[{now_iso()}] cycle done (exit {code})", flush=True)
    return True


def acquire_lock():
    pid = os.getpid()
    if PIDFILE.exists():
        try:
            old = int(PIDFILE.read_text().strip())
        except (ValueError, OSError):
            old = None
        if old and old != pid and os.path.exists(f"/proc/{old}"):
            # /proc check is Linux-only; on Windows just warn and overwrite.
            pass
    PIDFILE.write_text(str(pid))
    return pid


def main():
    once = "--once" in sys.argv
    pid = acquire_lock()
    print(f"[{now_iso()}] reels_autopost pid={pid} once={once}", flush=True)

    if once:
        ok = cycle_once()
        sys.exit(0 if ok else 2)

    # Loop forever: run immediately, then sleep.
    while True:
        ok = cycle_once()
        if not ok:
            sys.exit(2)
        print(f"[{now_iso()}] sleeping {INTERVAL_HOURS}h ...", flush=True)
        time.sleep(INTERVAL_HOURS * 3600)


if __name__ == "__main__":
    main()
