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
    const profile = MEDIA_DISCOVERED_RUNTIME_PROFILES[0]!;
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
    const profile = MEDIA_DISCOVERED_RUNTIME_PROFILES[0]!;
    const secondProfile = {
      ...profile,
      id: "wan2.2-ti2v-5b-secondary-profile",
      model: {
        ...profile.model,
        id: "local:wan2.2-ti2v-5b-secondary",
        displayName: "Wan2.2 TI2V 5B secondary profile",
      },
    };
    const catalog = extendMediaCatalogWithWorkspaceDiscovery({
      catalog: baseCatalog(),
      discovery: discovery(),
      runtime: runtime(),
      profiles: [profile, secondProfile],
    });

    expect(
      catalog.providers.filter((provider) => provider.id === "local-wan"),
    ).toHaveLength(1);
    expect(
      catalog.models.filter((model) => model.providerId === "local-wan"),
    ).toHaveLength(2);
  });
});
