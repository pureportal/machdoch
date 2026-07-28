import { describe, expect, it } from "vitest";
import { createMediaModelCatalogSnapshot } from "./catalog.js";
import {
  extendMediaCatalogWithWorkspaceDiscovery,
  matchesMediaDiscoveredModelQuery,
  MEDIA_DISCOVERED_RUNTIME_PROFILES,
} from "./discovered-model-profiles.js";
import type {
  MediaLocalDiffusersRuntimeStatus,
  MediaWorkspaceModelDiscovery,
} from "./contracts.js";

const baseCatalog = () =>
  createMediaModelCatalogSnapshot({
    isOpenAiConfigured: false,
  });

const discovery = (
  status: MediaWorkspaceModelDiscovery["entries"][number]["status"] = "ready",
): MediaWorkspaceModelDiscovery => ({
  schemaVersion: 1,
  rootPath: "C:/workspace/models",
  scannedAt: "2026-07-25T12:00:00.000Z",
  truncated: false,
  warnings: [],
  entries: [
    {
      path: "C:/workspace/models/wan-2.2-ti2v-5b",
      relativePath: "wan-2.2-ti2v-5b",
      displayName: "Wan2.2 TI2V 5B",
      kind: "diffusers-model",
      status,
      architecture: "wan-2.2-ti2v",
      byteSize: 34_000_000_000,
      fileCount: 24,
      capabilities: ["start-end-to-video"],
      diagnostic: "Workspace package diagnostic.",
    },
  ],
});

const runtime = (
  capabilities: string[] = [
    "image-to-video",
    "start-end-to-video",
    "vp9-alpha",
    "alpha-video",
    "video-composite",
  ],
): MediaLocalDiffusersRuntimeStatus => ({
  status: "ready",
  ready: true,
  workerVersion: "media-diffusers-worker/1.10.0",
  pythonVersion: "3.12.10",
  packages: {},
  device: "cuda:0",
  deviceLabel: "AMD Radeon RX 9070",
  deviceMemoryBytes: 17_094_967_296,
  architectures: ["wan-2.2-ti2v"],
  capabilities,
  diagnostic: "Ready.",
});

const ltxDiscovery = (): MediaWorkspaceModelDiscovery => ({
  ...discovery(),
  entries: [
    {
      ...discovery().entries[0]!,
      path: "C:/workspace/models/ltx-video-0.9.8",
      relativePath: "ltx-video-0.9.8",
      displayName: "LTX-Video 0.9.8 FP8 (2B + 13B)",
      architecture: "ltx-video",
      byteSize: 38_800_000_000,
      capabilities: ["image-to-video", "start-end-to-video"],
    },
  ],
});

const ltxRuntime = (
  device: "cpu" | "cuda:0",
  deviceMemoryBytes: number | null,
): MediaLocalDiffusersRuntimeStatus => ({
  ...runtime(),
  device,
  deviceMemoryBytes,
  architectures: ["ltx-video"],
});

const framepackDiscovery = (): MediaWorkspaceModelDiscovery => ({
  ...discovery(),
  entries: [
    {
      ...discovery().entries[0]!,
      path: "C:/workspace/models/framepack-i2v-hy",
      relativePath: "framepack-i2v-hy",
      displayName: "FramePack I2V HY 13B",
      architecture: "framepack-i2v",
      byteSize: 43_000_000_000,
      capabilities: ["image-to-video", "start-end-to-video"],
    },
  ],
});

const framepackRuntime = (
  device: "cpu" | "cuda:0",
  deviceMemoryBytes: number | null,
): MediaLocalDiffusersRuntimeStatus => ({
  ...runtime(),
  device,
  deviceMemoryBytes,
  architectures: ["framepack-i2v"],
});

describe("discovered media runtime profiles", () => {
  it("matches every workspace search term across rich artifact metadata", () => {
    const artifact = discovery().entries[0]!;

    expect(matchesMediaDiscoveredModelQuery(artifact, "wan video")).toBe(true);
    expect(matchesMediaDiscoveredModelQuery(artifact, "TI2V READY")).toBe(true);
    expect(matchesMediaDiscoveredModelQuery(artifact, "workspace missing")).toBe(
      false,
    );
  });

  it("leaves a catalog untouched before workspace discovery", () => {
    const catalog = baseCatalog();
    expect(
      extendMediaCatalogWithWorkspaceDiscovery({
        catalog,
        discovery: null,
        runtime: null,
      }),
    ).toBe(catalog);
  });

  it("adds one executable WAN provider and model from capabilities", () => {
    const catalog = extendMediaCatalogWithWorkspaceDiscovery({
      catalog: baseCatalog(),
      discovery: discovery(),
      runtime: runtime(),
    });

    const model = catalog.models.find(
      (candidate) => candidate.id === "local:wan2.2-ti2v-5b",
    );
    expect(model).toMatchObject({
      installed: true,
      configured: true,
      runtimeReadiness: "ready",
      architecture: "wan-2.2-ti2v",
    });
    expect(model?.capabilities).toContain("alpha-video");
    expect(
      catalog.providers.filter((provider) => provider.id === "local-wan"),
    ).toHaveLength(1);
  });

  it("reports the exact missing runtime capability", () => {
    const catalog = extendMediaCatalogWithWorkspaceDiscovery({
      catalog: baseCatalog(),
      discovery: discovery(),
      runtime: runtime(["image-to-video", "start-end-to-video"]),
    });
    const model = catalog.models.find(
      (candidate) => candidate.id === "local:wan2.2-ti2v-5b",
    );

    expect(model?.configured).toBe(false);
    expect(model?.runtimeReadiness).toBe("runtime-unavailable");
    expect(model?.runtimeReadinessDiagnostic).toContain("vp9-alpha");
  });

  it("selects 13B on 16 GiB and degrades to 2B on 8 GiB or CPU", () => {
    const modelsFor = (
      device: "cpu" | "cuda:0",
      deviceMemoryBytes: number | null,
    ) =>
      extendMediaCatalogWithWorkspaceDiscovery({
        catalog: baseCatalog(),
        discovery: ltxDiscovery(),
        runtime: ltxRuntime(device, deviceMemoryBytes),
      }).models.filter((model) => model.architecture === "ltx-video");

    const currentGpu = modelsFor("cuda:0", 16 * 1_024 ** 3);
    expect(
      currentGpu.find((model) => model.id.includes("13b"))?.configured,
    ).toBe(true);
    expect(
      currentGpu.find((model) => model.id.includes("2b"))?.configured,
    ).toBe(true);

    for (const constrained of [
      modelsFor("cuda:0", 8 * 1_024 ** 3),
      modelsFor("cpu", null),
    ]) {
      expect(
        constrained.find((model) => model.id.includes("13b"))?.configured,
      ).toBe(false);
      expect(
        constrained.find((model) => model.id.includes("2b"))?.configured,
      ).toBe(true);
    }
  });

  it("enables FramePack at 16 GiB but leaves lower-resource hosts on the lightweight path", () => {
    const modelFor = (
      device: "cpu" | "cuda:0",
      deviceMemoryBytes: number | null,
    ) =>
      extendMediaCatalogWithWorkspaceDiscovery({
        catalog: baseCatalog(),
        discovery: framepackDiscovery(),
        runtime: framepackRuntime(device, deviceMemoryBytes),
      }).models.find((model) => model.id === "local:framepack-i2v-hy-13b");

    expect(modelFor("cuda:0", 16 * 1_024 ** 3)?.configured).toBe(true);
    expect(modelFor("cuda:0", 24 * 1_024 ** 3)?.configured).toBe(true);
    expect(modelFor("cuda:0", 8 * 1_024 ** 3)?.configured).toBe(false);
    expect(modelFor("cpu", null)?.configured).toBe(false);
  });

  it("does not claim an incomplete workspace package is installed", () => {
    const catalog = extendMediaCatalogWithWorkspaceDiscovery({
      catalog: baseCatalog(),
      discovery: discovery("incomplete"),
      runtime: runtime(),
    });
    const model = catalog.models.find(
      (candidate) => candidate.id === "local:wan2.2-ti2v-5b",
    );

    expect(model).toMatchObject({
      installed: false,
      configured: false,
      installationStatus: "not-installed",
      runtimeReadiness: "unverified",
      runtimeReadinessDiagnostic: "Workspace package diagnostic.",
    });
  });

  it("blocks an ambiguous package selection unless the preferred path exists", () => {
    const ambiguousDiscovery = discovery();
    ambiguousDiscovery.entries = [
      {
        ...ambiguousDiscovery.entries[0]!,
        path: "C:/workspace/models/video-a",
        relativePath: "video-a",
      },
      {
        ...ambiguousDiscovery.entries[0]!,
        path: "C:/workspace/models/video-b",
        relativePath: "video-b",
      },
    ];
    const profile = MEDIA_DISCOVERED_RUNTIME_PROFILES.find(
      (candidate) => candidate.architecture === "wan-2.2-ti2v",
    )!;
    const profileWithoutPreferredPath = { ...profile };
    delete profileWithoutPreferredPath.preferredRelativePath;
    const catalog = extendMediaCatalogWithWorkspaceDiscovery({
      catalog: baseCatalog(),
      discovery: ambiguousDiscovery,
      runtime: runtime(),
      profiles: [profileWithoutPreferredPath],
    });
    const model = catalog.models.find(
      (candidate) => candidate.id === "local:wan2.2-ti2v-5b",
    );

    expect(model).toMatchObject({
      installed: false,
      configured: false,
      runtimeReadiness: "unverified",
    });
    expect(model?.runtimeReadinessDiagnostic).toContain(
      "Multiple compatible packages",
    );
  });

  it("aggregates multiple model profiles behind one provider entry", () => {
    const profile = MEDIA_DISCOVERED_RUNTIME_PROFILES.find(
      (candidate) => candidate.architecture === "wan-2.2-ti2v",
    )!;
    const secondProfile = {
      ...profile,
      id: `${profile.id}-secondary-profile`,
      model: {
        ...profile.model,
        id: `${profile.model.id}-secondary`,
        displayName: `${profile.model.displayName} secondary profile`,
      },
    };
    const catalog = extendMediaCatalogWithWorkspaceDiscovery({
      catalog: baseCatalog(),
      discovery: discovery(),
      runtime: runtime(),
      profiles: [profile, secondProfile],
    });

    expect(
      catalog.providers.filter(
        (provider) => provider.id === profile.provider.id,
      ),
    ).toHaveLength(1);
    expect(
      catalog.models.filter(
        (model) => model.providerId === profile.provider.id,
      ),
    ).toHaveLength(2);
  });
});
