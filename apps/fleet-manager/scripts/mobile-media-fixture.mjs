import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createMediaModelCatalogSnapshot } from "../../../packages/media-studio/src/core/media/catalog.ts";

export function createMobileMedia(transfers) {
  const imports = [];
  let studioState = null;
  const page = (items, offset) => ({
    schemaVersion: 1,
    revision: String(imports.length).padStart(64, "0"),
    offset,
    totalItems: items.length,
    unchanged: false,
    items: items.slice(offset),
  });
  function invoke(command, args) {
    if (command === "media_read_studio_state") return studioState;
    if (command === "media_write_studio_state") {
      studioState = args.value;
      return null;
    }
    if (command === "media_initialize_runtime")
      return {
        schemaVersion: 1,
        recoveredRuns: 0,
        queuedRuns: 0,
        activeRuns: 0,
        storageReady: true,
        mode: "native",
        directGenerationModelIds: [],
        directReferenceImageModelIds: [],
        directInpaintingModelIds: [],
        directPoseModelIds: [],
        localDiffusers: {
          status: "unavailable",
          ready: false,
          workerVersion: null,
          pythonVersion: null,
          packages: {},
          device: null,
          deviceLabel: null,
          deviceMemoryBytes: null,
          physicalMemoryBytes: null,
          architectures: [],
          capabilities: [],
          diagnostic: "",
        },
      };
    if (command === "media_get_model_catalog")
      return createMediaModelCatalogSnapshot({
        isOpenAiConfigured: false,
        isCodexCliConfigured: false,
      });
    if (command === "media_discover_workspace_models")
      return {
        schemaVersion: 1,
        rootPath: args.workspaceRoot,
        scannedAt: new Date().toISOString(),
        entries: [],
        truncated: false,
        warnings: [],
      };
    if (command === "media_list_flows") return [];
    if (command === "media_list_runs")
      return imports.map(({ detail }) => detail);
    if (command === "media_list_run_page")
      return page(
        imports.map(({ detail }) => detail),
        args.offset,
      );
    if (command === "media_list_asset_page")
      return page(
        imports.map(({ asset }) => asset),
        args.offset,
      );
    if (command === "media_get_run_detail")
      return imports.find(({ detail }) => detail.id === args.runId)?.detail;
    if (command === "media_read_asset_preview")
      return {
        binary: imports
          .find(({ asset }) => asset.id === args.assetId)
          .bytes.toString("base64"),
      };
    if (command === "media_import_asset") {
      const transfer = [...transfers.values()].find(
        ({ path }) => path === args.path,
      );
      assert.ok(transfer);
      const createdAt = new Date().toISOString();
      const runId = randomUUID();
      const asset = {
        id: randomUUID(),
        runId,
        digest: createHash("sha256").update(transfer.bytes).digest("hex"),
        kind: "image",
        mimeType: "image/png",
        byteSize: transfer.bytes.length,
        width: transfer.bytes.readUInt32BE(16),
        height: transfer.bytes.readUInt32BE(20),
        createdAt,
        outputIndex: 0,
        fixture: false,
        operation: { kind: "local-import", sourceFileName: transfer.name },
        sourceAssetIds: [],
        tags: [],
      };
      const detail = {
        id: runId,
        flowId: runId,
        flowRevisionId: null,
        flowName: transfer.name,
        planId: runId,
        status: "completed",
        createdAt,
        prompt: "",
        modelLabel: "Local import",
        target: null,
        outputCount: 1,
        diagnosticCount: 0,
        updatedAt: createdAt,
        progress: 1,
        currentStep: "Imported",
        executor: "local-import",
        error: null,
        failure: null,
        events: [],
        assets: [asset],
        providerJobs: [],
        humanReviews: [],
        nodeExecutions: [],
        planSnapshot: null,
      };
      imports.push({
        name: transfer.name,
        bytes: transfer.bytes,
        asset,
        detail,
      });
      return { asset, detail, deduplicated: false };
    }
    throw new Error(`Unexpected media fixture operation: ${command}`);
  }
  return { invoke, imports };
}
