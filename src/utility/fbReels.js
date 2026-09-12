const fs = require("fs");
const path = require("path");

const CONFIG_PATH = path.join(__dirname, "..", "config", "fb.json");

function loadConfig({ requireToken = true } = {}) {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`Missing Facebook config: ${CONFIG_PATH}`);
  }

  let config;
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch (error) {
    throw new Error(`Invalid JSON in ${CONFIG_PATH}: ${error.message}`);
  }

  if (requireToken) {
    const missing = ["pageId", "pageAccessToken"].filter(
      (key) => !config[key] || !String(config[key]).trim(),
    );
    if (missing.length > 0) {
      throw new Error(`Fill in ${missing.join(", ")} in ${CONFIG_PATH}`);
    }
  }

  return config;
}

async function graphPost(url, params) {
  const response = await fetch(url, {
    method: "POST",
    body: new URLSearchParams(params),
  });

  const result = await response.json().catch(() => ({}));

  if (!response.ok || result.error) {
    const message =
      result?.error?.message || `Graph call failed with status ${response.status}`;
    throw new Error(message);
  }

  return result;
}

// Facebook Reels upload is a three-call dance:
//   start  -> returns video_id + a rupload.facebook.com upload_url
//   upload -> raw binary POST to that url with an OAuth header, no multipart
//   finish -> flips the video to PUBLISHED (or DRAFT) and attaches the caption
// A plain /{page-id}/videos POST (what utility/upload-to-fb.js does) publishes a
// feed video, not a Reel, so it never lands on the Reels tab.
async function postReel({
  videoPath,
  description = "",
  published = true,
  thumbOffsetMs,
  config,
}) {
  const cfg = config || loadConfig();
  const version = cfg.graphVersion || "v23.0";
  const base = `https://graph.facebook.com/${version}`;
  const token = cfg.pageAccessToken;

  if (!videoPath) throw new Error("videoPath is required");
  if (!fs.existsSync(videoPath)) throw new Error(`Video not found: ${videoPath}`);

  const start = await graphPost(`${base}/${cfg.pageId}/video_reels`, {
    upload_phase: "start",
    access_token: token,
  });

  const videoId = start.video_id;
  const uploadUrl = start.upload_url;

  if (!videoId || !uploadUrl) {
    throw new Error(`No video_id/upload_url in start response: ${JSON.stringify(start)}`);
  }

  const buffer = fs.readFileSync(videoPath);

  const uploadResponse = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      Authorization: `OAuth ${token}`,
      offset: "0",
      file_size: String(buffer.length),
    },
    body: buffer,
  });

  const uploadResult = await uploadResponse.json().catch(() => ({}));

  if (!uploadResponse.ok || uploadResult.error) {
    const message =
      uploadResult?.error?.message ||
      `Reel upload failed with status ${uploadResponse.status}`;
    throw new Error(message);
  }

  const finishParams = {
    upload_phase: "finish",
    video_id: String(videoId),
    video_state: published ? "PUBLISHED" : "DRAFT",
    description,
    access_token: token,
  };

  if (Number.isFinite(thumbOffsetMs)) {
    finishParams.thumb_offset = String(Math.max(0, Math.floor(thumbOffsetMs)));
  }

  const finish = await graphPost(`${base}/${cfg.pageId}/video_reels`, finishParams);

  return {
    videoId: String(videoId),
    description,
    videoState: finishParams.video_state,
    bytes: buffer.length,
    response: finish,
  };
}

module.exports = {
  loadConfig,
  postReel,
};