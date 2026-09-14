#!/usr/bin/env python3
"""Mint a long-lived Facebook Page access token for cartoonMornings.

Flow (all via the Graph API):
  code -> short-lived user token -> long-lived user token -> /me/accounts
The page token returned by /me/accounts is derived from the long-lived user
token, so it does not expire the way a Graph API Explorer token does.

Prereq: the app must list http://localhost:8765/callback under
Facebook Login > Settings > Valid OAuth Redirect URIs.
"""
import http.server
import json
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from pathlib import Path

CONFIG_PATH = Path(r"E:\NH\NextJS\VideoProcessor\src\autopost\config\fb.json")
PORT = 8765
REDIRECT_URI = f"http://localhost:{PORT}/callback"
SCOPES = [
    "pages_show_list",
    "pages_read_engagement",
    "pages_manage_posts",
    "business_management",
]

cfg = json.load(open(CONFIG_PATH))
APP_ID = cfg["appId"]
APP_SECRET = cfg["appSecret"]
PAGE_NAME = (cfg.get("pageName") or "").strip().lower()
VERSION = cfg.get("graphVersion", "v23.0")

event = threading.Event()
received = {}


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        received["code"] = q.get("code", [None])[0]
        received["error"] = q.get("error_description", [q.get("error", [None])[0]])[0]
        event.set()
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.end_headers()
        self.wfile.write(b"<h1>Authorization received</h1><p>Close this tab.</p>")

    def log_message(self, *a):
        pass


def norm(s):
    return "".join(c for c in s.lower() if c.isalnum())


def api_get(u):
    with urllib.request.urlopen(urllib.request.Request(u), timeout=30) as r:
        return json.loads(r.read())


def api_post(u, data):
    body = urllib.parse.urlencode(data, quote_via=urllib.parse.quote).encode()
    req = urllib.request.Request(u, data=body)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        print("HTTP", e.code, e.read().decode(), flush=True)
        raise


def main():
    srv = http.server.HTTPServer(("127.0.0.1", PORT), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    print(f"Server listening on {REDIRECT_URI}", flush=True)

    params = {
        "client_id": APP_ID,
        "redirect_uri": REDIRECT_URI,
        "scope": ",".join(SCOPES),
        "response_type": "code",
    }
    url = (
        f"https://www.facebook.com/{VERSION}/dialog/oauth?"
        + urllib.parse.urlencode(params)
    )
    print("\nOPEN THIS URL AND APPROVE:\n" + url + "\n", flush=True)
    try:
        webbrowser.open(url)
    except Exception as e:
        print(f"  (webbrowser.open failed: {e} — open the URL above manually)", flush=True)

    print("Waiting for callback (180s)...", flush=True)
    if not event.wait(900):
        raise SystemExit("TIMEOUT: no callback received")
    if received["error"]:
        raise SystemExit("OAuth error: " + received["error"])
    code = received["code"]
    print("Got code: " + code[:20] + "...", flush=True)
    srv.shutdown()

    short = api_post(
        f"https://graph.facebook.com/{VERSION}/oauth/access_token",
        {
            "client_id": APP_ID,
            "client_secret": APP_SECRET,
            "redirect_uri": REDIRECT_URI,
            "code": code,
        },
    )
    short_token = short["access_token"]
    print("short-lived token (full): " + short_token, flush=True)

    long = api_post(
        f"https://graph.facebook.com/{VERSION}/oauth/access_token",
        {
            "grant_type": "fb_exchange_token",
            "client_id": APP_ID,
            "client_secret": APP_SECRET,
            "fb_exchange_token": short_token,
        },
    )
    long_token = long["access_token"]
    print("LONG-LIVED user token (full): " + long_token, flush=True)

    accounts = api_get(
        f"https://graph.facebook.com/{VERSION}/me/accounts?"
        + urllib.parse.urlencode(
            {"access_token": long_token, "fields": "id,name,access_token"}
        )
    )
    pages = accounts.get("data", [])
    for p in pages:
        print(f"  page: {p['id']}  {p['name']}", flush=True)

    chosen = None
    if PAGE_NAME:
        pn = norm(PAGE_NAME)
        for p in pages:
            if norm(p["name"]) == pn:
                chosen = p
                break
    if not chosen and len(pages) == 1:
        chosen = pages[0]
    if not chosen:
        raise SystemExit(
            "Could not choose page among: " + str([p["name"] for p in pages])
        )

    page_token = chosen.get("access_token", "")
    print(
        f"SELECTED: {chosen['id']} {chosen['name']}\npage-token (full): {page_token}",
        flush=True,
    )
    if not page_token:
        raise SystemExit("No page access_token in /me/accounts response")

    cfg["pageId"] = chosen["id"]
    cfg["pageAccessToken"] = page_token
    cfg["tokenUpdatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    json.dump(cfg, open(CONFIG_PATH, "w"), indent=2)
    open(CONFIG_PATH, "a").write("\n")
    print("WROTE token to " + str(CONFIG_PATH), flush=True)

    v = api_get(
        f"https://graph.facebook.com/{VERSION}/{chosen['id']}?fields=name&access_token="
        + urllib.parse.quote(page_token)
    )
    print("VALIDATION: " + str(v), flush=True)


if __name__ == "__main__":
    main()
