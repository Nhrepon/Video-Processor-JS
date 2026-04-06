function validateChannels(channels) {
  if (!Array.isArray(channels) || channels.length === 0) {
    throw new Error("channels must be a non-empty array");
  }
}

function buildPayload(videoPath, metadata, channel) {
  return {
    videoPath,
    title: channel.title ?? metadata.title,
    description: channel.description ?? metadata.description ?? "",
    tags: channel.tags ?? metadata.tags ?? [],
    categoryId: channel.categoryId ?? metadata.categoryId ?? "22",
    privacyStatus: channel.privacyStatus ?? metadata.privacyStatus ?? "draft",
    playlistId: channel.playlistId ?? metadata.playlistId,
    thumbnailPath: channel.thumbnailPath ?? metadata.thumbnailPath,
    publishAt: channel.publishAt ?? metadata.publishAt,
    channel,
  };
}

async function uploadSingleChannel(channel, payload, uploadHandler) {
  const response = await uploadHandler({
    ...payload,
    credentials: channel.credentials,
    accessToken: channel.accessToken,
    refreshToken: channel.refreshToken,
    clientId: channel.clientId,
    clientSecret: channel.clientSecret,
  });

  return {
    channelId: channel.id ?? null,
    channelName: channel.name ?? "Unnamed channel",
    success: true,
    response,
  };
}

const uploadToYoutube = async ({
  videoPath,
  metadata = {},
  channels = [],
  parallel = false,
  continueOnError = true,
  uploadHandler,
} = {}) => {
  if (!videoPath) {
    throw new Error("videoPath is required");
  }

  if (typeof uploadHandler !== "function") {
    throw new Error("uploadHandler must be a function");
  }

  validateChannels(channels);

  const executeUpload = async (channel) => {
    const payload = buildPayload(videoPath, metadata, channel);

    try {
      return await uploadSingleChannel(channel, payload, uploadHandler);
    } catch (error) {
      if (!continueOnError) {
        throw error;
      }

      return {
        channelId: channel.id ?? null,
        channelName: channel.name ?? "Unnamed channel",
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };

  const results = parallel
    ? await Promise.all(channels.map(executeUpload))
    : await channels.reduce(async (previousPromise, channel) => {
        const collected = await previousPromise;
        collected.push(await executeUpload(channel));
        return collected;
      }, Promise.resolve([]));

  return {
    totalChannels: channels.length,
    successCount: results.filter((item) => item.success).length,
    failedCount: results.filter((item) => !item.success).length,
    results,
  };
};

module.exports = {
  uploadToYoutube,
};
