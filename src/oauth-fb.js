// One-time OAuth helper: mints a never-expiring Page access token for the
// Facebook Page in src/config/fb.json.
//
//   code -> short-lived user token -> long-lived user token -> /me/accounts
//
// The page token that /me/accounts returns is derived from a long-lived user
// token, which is why it does not expire the way a Graph API Explorer token
// does. Run once, then the token sits in fb.json and the cron job uses it.
//
// Prereq: the app must list the redirect URI below under
// Facebook Login > Settings > Valid OAuth Redirect URIs.

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const CONFIG_PATH = path.join(__dirname, "config", "fb.json");
const PORT = 8765;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;

const SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_posts",
  "business_management",
];

function readConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`Missing config: ${CONFIG_PATH}`);
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}

function writeConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
}

async function getJson(url) {
  const response = await fetch(url);
  const json = await response.json().catch(() => ({}));
  if (!response.ok || json.error) {
    throw new Error(json?.error?.message || `HTTP ${response.status} for ${url}`);
  }
  return json;
}

function waitForCode(authUrl, expectedState) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      if (url.pathname !== "/callback") {
        res.writeHead(404);
        res.end();
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        "<h1>Authorization received</h1><p>Close this tab and return to the terminal.</p>",
      );
      server.close();

      const error =
        url.searchParams.get("error_description") || url.searchParams.get("error");
      if (error) {
        reject(new Error(error));
        return;
      }
      if (url.searchParams.get("state") !== expectedState) {
        reject(new Error("OAuth state mismatch — aborting"));
        return;
      }
      const code = url.searchParams.get("code");
      if (!code) {
        reject(new Error("No code in callback"));
        return;
      }
      resolve(code);
    });

    server.on("error", reject);

    server.listen(PORT, () => {
      console.log("\nOpen this URL, log in, click Continue / Approve:\n");
      console.log(authUrl);
      console.log(`\nWaiting for callback on ${REDIRECT_URI} ...\n`);
      // Args array, not a shell string: the auth URL carries & and quotes that
      // bash + cmd both mangle.
      // Firefox first — that is where the Pages account is signed in.
      const firefox = [
        "C:/Program Files/Mozilla Firefox/firefox.exe",
        "C:/Program Files (x86)/Mozilla Firefox/firefox.exe",
        "C:/Users/RHYTHM CARE LTD/AppData/Local/Microsoft/WindowsApps/firefox.exe",
        "C:/Users/RHYTHM CARE LTD/AppData/Local/Mozilla Firefox/firefox.exe",
      ].find((candidate) => fs.existsSync(candidate));
      if (firefox) {
        spawn(firefox, [authUrl], { stdio: "ignore", detached: true }).unref();
      } else {
        console.log("Firefox not found — falling back to the default browser.");
        spawn("cmd.exe", ["/c", "start", "", authUrl], { stdio: "ignore" });
      }
    });
  });
}

async function main() {
  const config = readConfig();
  const appId = config.appId;
  const appSecret = config.appSecret;

  if (!appId || !appSecret) {
    throw new Error(`Fill in appId and appSecret in ${CONFIG_PATH} first`);
  }

  const version = config.graphVersion || "v23.0";
  const state = crypto.randomBytes(16).toString("hex");

  const authUrl =
    `https://www.facebook.com/${version}/dialog/oauth?` +
    new URLSearchParams({
      client_id: appId,
      redirect_uri: REDIRECT_URI,
      state,
      scope: SCOPES.join(","),
      response_type: "code",
    });

  const code = await waitForCode(authUrl, state);

  const shortLived = await getJson(
    `https://graph.facebook.com/${version}/oauth/access_token?` +
      new URLSearchParams({
        client_id: appId,
        client_secret: appSecret,
        redirect_uri: REDIRECT_URI,
        code,
      }),
  );

  const longLived = await getJson(
    `https://graph.facebook.com/${version}/oauth/access_token?` +
      new URLSearchParams({
        grant_type: "fb_exchange_token",
        client_id: appId,
        client_secret: appSecret,
        fb_exchange_token: shortLived.access_token,
      }),
  );

  const accounts = await getJson(
    `https://graph.facebook.com/${version}/me/accounts?` +
      new URLSearchParams({
        access_token: longLived.access_token,
        fields: "id,name,access_token",
      }),
  );

  const pages = accounts.data || [];
  console.log("Pages on this account:");
  pages.forEach((page) => console.log(`  ${page.id}  ${page.name}`));

  const match = config.pageName
    ? pages.find(
        (page) =>
          page.name.toLowerCase() === String(config.pageName).toLowerCase(),
      )
    : null;
  const chosen = match || (pages.length === 1 ? pages[0] : null);

  if (!chosen) {
    throw new Error(
      `Could not choose a page. Set "pageName" in ${CONFIG_PATH}. Candidates: ${pages
        .map((page) => page.name)
        .join(", ")}`,
    );
  }

  config.pageId = chosen.id;
  config.pageAccessToken = chosen.access_token;
  config.tokenUpdatedAt = new Date().toISOString();
  writeConfig(config);

  console.log(
    `\nWrote pageId ${chosen.id} (${chosen.name}) + page token to ${CONFIG_PATH}`,
  );
  console.log("Token is long-lived. Cron job will now upload.");
}

main().catch((error) => {
  console.error(`\nFailed: ${error.message || error}`);
  process.exit(1);
});