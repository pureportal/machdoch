// @vitest-environment jsdom

import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createLocalFluxInstallPlan } from "../../../../core/media/model-install.js";
import type { MediaModelInstallJob } from "../../../../core/media/contracts.js";
import { MediaModelDownload } from "./media-model-download";

const runtime = vi.hoisted(() => ({
  plan: vi.fn(),
  start: vi.fn(),
  cancel: vi.fn(),
  list: vi.fn(),
}));
vi.mock("../media-runtime", () => ({
  planMediaModelInstall: runtime.plan,
  startMediaModelInstall: runtime.start,
  cancelMediaModelInstall: runtime.cancel,
  listMediaModelInstallJobs: runtime.list,
}));
vi.mock("../media-runtime-setup", () => ({
  EMPTY_MEDIA_RUNTIME_SETUP: { phase: "ready" },
  getMediaRuntimeSetup: async () => ({ phase: "ready" }),
  isMediaRuntimeSetupActive: () => false,
}));

const plan = createLocalFluxInstallPlan();
const model = {
  id: plan.modelId,
  displayName: plan.displayName,
  license: plan.license,
};
const job: MediaModelInstallJob = {
  id: "job:direct",
  modelId: plan.modelId,
  displayName: plan.displayName,
  sourceUrl: plan.sourceUrl,
  revision: plan.revision,
  manifestDigest: plan.manifestDigest,
  status: "downloading",
  progress: 0.5,
  bytesDownloaded: 2e9,
  bytesTotal: 4e9,
  filesCompleted: 0,
  filesTotal: 1,
  currentFile: null,
  error: null,
  failure: null,
  createdAt: "2026-11-24T00:00:00Z",
  updatedAt: "2026-11-24T00:00:00Z",
  completedAt: null,
};

beforeEach(() => {
  vi.resetAllMocks();
  runtime.plan.mockResolvedValue(plan);
  runtime.start.mockResolvedValue(job);
  runtime.list.mockResolvedValue([]);
});
afterEach(cleanup);

it("starts the download in one click and refreshes models when it is installed", async () => {
  const onInstalled = vi.fn(async () => undefined);
  render(createElement(MediaModelDownload, { model, onInstalled, children: "Download FLUX" }));
  expect(screen.getByText(plan.license.name)).toBeTruthy();
  runtime.list.mockResolvedValue([job]);
  fireEvent.click(screen.getByRole("button", { name: "Download FLUX" }));
  expect(await screen.findByText(/2\.0 GB \/ 4\.0 GB · 50%/)).toBeTruthy();
  expect(runtime.start).toHaveBeenCalledWith({
    modelId: plan.modelId,
    reviewToken: plan.reviewToken,
    manifestDigest: plan.manifestDigest,
    licenseDigest: plan.licenseDigest,
    acceptLicense: true,
  });
  runtime.list.mockResolvedValue([{ ...job, status: "installed", progress: 1 }]);
  await waitFor(() => expect(onInstalled).toHaveBeenCalledOnce(), { timeout: 3_000 });
});

it("refreshes models without downloading when the files are already installed", async () => {
  runtime.plan.mockResolvedValue({ ...plan, alreadyInstalled: true });
  const onInstalled = vi.fn(async () => undefined);
  render(createElement(MediaModelDownload, { model, onInstalled, children: "Download FLUX" }));
  fireEvent.click(screen.getByRole("button", { name: "Download FLUX" }));
  await waitFor(() => expect(onInstalled).toHaveBeenCalledOnce());
  expect(runtime.start).not.toHaveBeenCalled();
});

it("shows why the download cannot start and offers a retry", async () => {
  runtime.plan.mockResolvedValue({ ...plan, hasSufficientSpace: false });
  render(
    createElement(MediaModelDownload, {
      model,
      onInstalled: async () => undefined,
      children: "Download FLUX",
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Download FLUX" }));
  expect((await screen.findByRole("alert")).textContent).toMatch(/^Free up .* GB on the model drive/);
  expect(screen.getByRole("button", { name: "Retry download" })).toBeTruthy();
  expect(runtime.start).not.toHaveBeenCalled();
});
