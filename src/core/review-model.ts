import type { RuntimeConfig } from "./types.js";

export const resolveReviewModelRuntimeConfig = (
  config: RuntimeConfig,
): RuntimeConfig => {
  const reviewModel = config.reviewModel;
  const provider = reviewModel?.provider;
  const model = reviewModel?.model?.trim();

  if (reviewModel?.mode !== "dedicated" || !provider || !model) {
    return config;
  }

  return {
    ...config,
    provider,
    model,
  };
};
