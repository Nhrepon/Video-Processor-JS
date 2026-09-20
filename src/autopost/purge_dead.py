"""Resumable purge of dead reels (Kick-It dupes + 0-view 53s batch).
Throttled 2.5s between calls; on (#4) rate limit, waits 60s and continues.
Deletes + removes from state, saves after every 10.
"""
import json, urllib.request, urllib.parse, time, os

BASE = os.path.join(os.path.dirname(__file__), "config")
FB = json.load(open(os.path.join(BASE, "fb.json")))
TOK, GV = FB["pageAccessToken"], FB["graphVersion"]
ST_PATH = os.path.join(BASE, "reelsfb-state.json")

def keep_video(f, v):
    if "Kick-It" in f:
        return v["videoId"] == "1418968586779981"          # 40-view best
    if "-b3-" in f:
        return v["videoId"] in ("945893117945716", "2000344984017136", "1445544064164539")  # queued
    if "-a1-" in f:
        return True                                        # transformed-format tests
    return False

def delete(vid):
    req = urllib.request.Request(
        f"https://graph.facebook.com/{GV}/{vid}?{urllib.parse.urlencode({'access_token': TOK})}",
        method="DELETE")
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r).get("success", False)

def err_of(e):
    try: return json.loads(e.read()).get("error", {}).get("message", "")
    except Exception: return str(e)

st = json.load(open(ST_PATH))
targets = [(f, v) for f, v in list(st["posted"].items()) if not keep_video(f, v)]
print(f"purge: {len(targets)} remaining", flush=True)
done = fail = 0
for i, (f, v) in enumerate(targets):
    vid = v["videoId"]
    for attempt in range(24):
        try:
            ok = delete(vid)
            if ok:
                st["posted"].pop(f, None)
                st.setdefault("skipped", {})[f] = {"reason": "purged: 0-view duplicate", "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
                done += 1
                print(f"DEL {vid} {f[:55]}", flush=True)
            else:
                fail += 1
                print(f"FAIL(no-success) {vid}", flush=True)
            break
        except Exception as e:
            msg = err_of(e)
            if "rate limit" in msg.lower() or msg.startswith("(#4)"):
                print(f"  ratelimited, sleep 900 (try {attempt+1})", flush=True)
                time.sleep(900)
                continue
            if "does not exist" in msg:
                st["posted"].pop(f, None)  # already gone -> drop from state
                st.setdefault("skipped", {})[f] = {"reason": "purged: already gone", "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
                done += 1
                print(f"ALREADY-GONE {vid} (state cleaned)", flush=True)
                break
            fail += 1
            print(f"FAIL {vid}: {msg[:90]}", flush=True)
            break
    if i % 10 == 9:
        json.dump(st, open(ST_PATH, "w"), indent=1)
    time.sleep(2.5)
json.dump(st, open(ST_PATH, "w"), indent=1)
print(f"DONE deleted={done} failed={fail} state_now={len(st['posted'])}", flush=True)
