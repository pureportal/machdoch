// @vitest-environment jsdom

import { createElement } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createOpenMediaModels } from "../../../../core/media/open-model-profiles.js";
import { createLocalFluxInstallPlan } from "../../../../core/media/model-install.js";
import type { MediaModelInstallJob } from "../../../../core/media/contracts.js";
import { MediaModelInstallDialog } from "./media-model-install-dialog";

const runtime = vi.hoisted(() => ({
  plan: vi.fn(),
  start: vi.fn(),
  get: vi.fn(),
  cancel: vi.fn(),
}));
vi.mock("../media-runtime", () => ({
  planMediaModelInstall: runtime.plan,
  startMediaModelInstall: runtime.start,
  getMediaModelInstallJob: runtime.get,
  cancelMediaModelInstall: runtime.cancel,
}));

const model = createOpenMediaModels("test").find(
  (model) => model.architecture === "z-image-turbo",
)!;
const job: MediaModelInstallJob = {
  id: "job:download",
  modelId: model.id,
  revision: "test-revision",
  manifestDigest: "test-manifest",
  status: "queued",
  progress: 0,
  bytesDownloaded: 0,
  bytesTotal: 100,
  filesCompleted: 0,
  filesTotal: 1,
  currentFile: null,
  error: null,
  failure: null,
  createdAt: "2026-10-02T00:00:00Z",
  updatedAt: "2026-10-02T00:00:00Z",
  completedAt: null,
};

beforeEach(() => {
  vi.resetAllMocks();
  const plan = createLocalFluxInstallPlan();
  runtime.plan.mockResolvedValue({
    ...plan,
    modelId: model.id,
    license: { ...plan.license, requiresAcceptance: false },
  });
  runtime.start.mockResolvedValue(job);
  runtime.get.mockResolvedValue(job);
  runtime.cancel.mockResolvedValue({ ...job, status: "canceled" });
});
afterEach(cleanup);

it("reopens an active download without creating another job", async () => {
  const plan = createLocalFluxInstallPlan();
  runtime.plan.mockResolvedValue({
    ...plan,
    modelId: model.id,
    activeJob: {
      ...job,
      revision: plan.revision,
      manifestDigest: plan.manifestDigest,
    },
  });
  render(
    createElement(MediaModelInstallDialog, {
      model,
      onClose: vi.fn(),
      onInstalled: vi.fn(async () => undefined),
    }),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Cancel download" }),
  );
  await waitFor(() => expect(runtime.cancel).toHaveBeenCalledWith(job.id));
  expect(runtime.start).not.toHaveBeenCalled();
  expect(
    (
      (await screen.findByRole("button", {
        name: "Retry download",
      })) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
});

it("starts a download with the reviewed package identity and supports cancellation", async () => {
  render(
    createElement(MediaModelInstallDialog, {
      model,
      onClose: vi.fn(),
      onInstalled: vi.fn(async () => undefined),
    }),
  );
  await waitFor(() =>
    expect(
      (
        screen.getByRole("button", {
          name: "Download model",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
  expect(screen.queryByRole("checkbox")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Download model" }));
  await waitFor(() =>
    expect(runtime.start).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: model.id,
        reviewToken: expect.any(String),
        manifestDigest: expect.any(String),
        licenseDigest: expect.any(String),
        acceptLicense: true,
      }),
    ),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Cancel download" }),
  );
  await waitFor(() => expect(runtime.cancel).toHaveBeenCalledWith(job.id));
  expect(
    await screen.findByRole("button", { name: "Retry download" }),
  ).toBeTruthy();
});

it("requires acceptance when the package terms require it", async () => {
  runtime.plan.mockResolvedValue(createLocalFluxInstallPlan());
  render(
    createElement(MediaModelInstallDialog, {
      model,
      onClose: vi.fn(),
      onInstalled: vi.fn(async () => undefined),
    }),
  );
  const checkbox = await screen.findByRole("checkbox");
  expect(
    (
      screen.getByRole("button", {
        name: "Download model",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  fireEvent.click(checkbox);
  expect(
    (
      screen.getByRole("button", {
        name: "Download model",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
});
