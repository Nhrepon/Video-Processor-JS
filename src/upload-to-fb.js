const fs = require("fs");
const path = require("path");

function validatePages(pages) {
  if (!Array.isArray(pages) || pages.length === 0) {
    throw new Error("pages must be a non-empty array");
  }
}

function buildPayload(videoPath, metadata, page) {
  return {
    videoPath,
    title: page.title ?? metadata.title,
    description: page.description ?? metadata.description ?? "",
    published: page.published ?? metadata.published ?? false,
    scheduledPublishTime:
      page.scheduledPublishTime ?? metadata.scheduledPublishTime,
    thumbnailPath: page.thumbnailPath ?? metadata.thumbnailPath,
    page,
  };
}

async function uploadSinglePage(page, payload, uploadHandler) {
  const response = await uploadHandler({
    ...payload,
    pageId: page.pageId,
    pageName: page.pageName,
    accessToken: page.accessToken,
    pageAccessToken: page.pageAccessToken,
    credentials: page.credentials,
  });

  return {
    pageId: page.pageId ?? null,
    pageName: page.pageName ?? "Unnamed page",
    success: true,
    response,
  };
}

const uploadHandler = async ({
  videoPath,
  title,
  description,
  pageId,
  pageAccessToken,
  published = false,
  scheduledPublishTime,
}) => {
  if (!videoPath) {
    throw new Error("videoPath is required");
  }

  if (!pageId) {
    throw new Error("pageId is required");
  }

  if (!pageAccessToken) {
    throw new Error("pageAccessToken is required");
  }

  if (!fs.existsSync(videoPath)) {
    throw new Error(`Video file not found: ${videoPath}`);
  }

  const formData = new FormData();
  const videoBuffer = fs.readFileSync(videoPath);
  const message = [title, description].filter(Boolean).join("\n\n").trim();

  formData.append("access_token", pageAccessToken);
  formData.append("published", String(Boolean(published)));

  if (message) {
    formData.append("description", message);
  }

  if (scheduledPublishTime) {
    const unixTime = Math.floor(new Date(scheduledPublishTime).getTime() / 1000);
    if (!Number.isFinite(unixTime)) {
      throw new Error("scheduledPublishTime must be a valid date");
    }
    formData.append("scheduled_publish_time", String(unixTime));
  }

  formData.append(
    "source",
    new Blob([videoBuffer], { type: "video/mp4" }),
    path.basename(videoPath),
  );

  const response = await fetch(
    `https://graph-video.facebook.com/v23.0/${pageId}/videos`,
    {
      method: "POST",
      body: formData,
    },
  );

  const result = await response.json();

  if (!response.ok || result.error) {
    const messageText =
      result?.error?.message ||
      `Facebook upload failed with status ${response.status}`;
    throw new Error(messageText);
  }

  return {
    uploaded: true,
    videoId: result.id ?? null,
    pageId,
    videoPath,
    response: result,
  };
};

const uploadToFB = async ({
  videoPath,
  metadata = {},
  pages = [],
  parallel = false,
  continueOnError = true,
} = {}) => {
  if (!videoPath) {
    throw new Error("videoPath is required");
  }

  validatePages(pages);

  const executeUpload = async (page) => {
    const payload = buildPayload(videoPath, metadata, page);

    try {
      return await uploadSinglePage(page, payload, uploadHandler);
    } catch (error) {
      if (!continueOnError) {
        throw error;
      }

      return {
        pageId: page.pageId ?? null,
        pageName: page.pageName ?? "Unnamed page",
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };

  const results = parallel
    ? await Promise.all(pages.map(executeUpload))
    : await pages.reduce(async (previousPromise, page) => {
        const collected = await previousPromise;
        collected.push(await executeUpload(page));
        return collected;
      }, Promise.resolve([]));

  return {
    totalPages: pages.length,
    successCount: results.filter((item) => item.success).length,
    failedCount: results.filter((item) => !item.success).length,
    results,
  };
};

module.exports = {
  uploadToFB,
};
