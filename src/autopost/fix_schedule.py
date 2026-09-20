"""Reschedule today's queued b3 reels to one-per-day evening slots.
Quota-tolerant: on (#4) rate limit, sleeps 900s and retries (up to 24x).
Does NOT touch reelsfb-state.json (state holds no schedule info)."""
import json, urllib.request, urllib.parse, time, os, calendar

BASE = os.path.join(os.path.dirname(__file__), "config")
FB = json.load(open(os.path.join(BASE, "fb.json")))
TOK, GV = FB["pageAccessToken"], FB["graphVersion"]

PLAN = {
    "945893117945716": "2026-09-17 12:00",   # b3-ep04 18:00 BST
    "2000344984017136": "2026-09-18 12:00",  # b3-ep11
    "1445544064164539": "2026-09-19 12:00",  # b3-ep13
}

def set_spt(vid, when_utc):
    ep = calendar.timegm(time.strptime(when_utc, "%Y-%m-%d %H:%M"))
    data = urllib.parse.urlencode({"access_token": TOK, "scheduled_publish_time": ep,
                                   "publish_status": "true"}).encode()
    req = urllib.request.Request(f"https://graph.facebook.com/{GV}/{vid}", data=data, method="POST")
    return json.loads(urllib.request.urlopen(req, timeout=30).read())

def err_of(e):
    try: return json.loads(e.read()).get("error", {}).get("message", "")
    except Exception: return str(e)

ok = 0
for vid, when in PLAN.items():
    for attempt in range(24):
        try:
            r = set_spt(vid, when)
            print(f"SET {vid} -> {when} UTC : {r}", flush=True)
            if r.get("success"):
                ok += 1
            break
        except Exception as e:
            msg = err_of(e)
            if "rate limit" in msg.lower() or msg.startswith("(#4)"):
                print(f"  ratelimited {vid}, sleep 900 (try {attempt+1})", flush=True)
                time.sleep(900)
                continue
            print(f"FAIL {vid}: {msg[:120]}", flush=True)
            break
    time.sleep(2.5)
print(f"DONE rescheduled={ok}/{len(PLAN)}", flush=True)
