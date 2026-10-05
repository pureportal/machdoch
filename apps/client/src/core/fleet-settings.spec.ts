import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  managedSettingsSchemaVersion,
  maximumManagedSettingsDeliveryBytes,
  type FleetManagedSettingsDelivery,
} from "@machdoch/fleet-protocol";
import { loadRuntimeConfig } from "./config.js";
import { discoverCustomizations } from "./customizations.js";
import {
  getUserConfigPath,
  loadUserAgentLimitsSettings,
  loadUserApiKeys,
  loadUserWebSearchSettings,
  saveUserApiKey,
} from "./env.js";
import {
  resetFleetConnection,
  setFleetConnectionEnabled,
  writeFleetConnectionConfig,
  type FleetConnectionConfig,
} from "./fleet-connection.js";
import {
  getFleetManagedSettingsPath,
  loadFleetManagedProfile,
  runFleetSettingsService,
  synchronizeFleetSettings,
} from "./fleet-settings.js";
import { resolveInstructionSet } from "./instruction-system/resolver.js";
import { FleetCliProductRuntime } from "../cli/_helpers/cli-fleet-product.js";
import { exportFleetLocalSettings } from "./fleet-settings-export.js";
import { createInstructionProfile } from "./instruction-system/library-store.js";

const roots: string[] = [];
const encoded = (size: number, fill: number): string =>
  Buffer.alloc(size, fill).toString("base64url");
const config: FleetConnectionConfig = {
  schemaVersion: 1,
  enabled: true,
  managerUrl: "https://fleet.example.test",
  managerId: `manager_${encoded(18, 1)}`,
  instanceId: `instance_${encoded(18, 2)}`,
  displayName: "Headless",
  instanceSecret: `mch_instance_${encoded(32, 3)}`,
};
function delivery(): FleetManagedSettingsDelivery {
  return {
    schemaVersion: managedSettingsSchemaVersion,
    managerId: config.managerId,
    profile: {
      profileId: `profile_${encoded(18, 4)}`,
      name: "Engineering",
      revision: 1,
      document: {
        defaults: {
          provider: "openai",
          model: "gpt-5.4",
          mode: "ask",
          reasoning: "high",
          webSearchProvider: "tavily",
          theme: null,
          density: null,
          accent: null,
        },
        agentLimits: {
          infinite: false,
          executorTurns: 42,
          autopilotExecutorIterations: 7,
        },
        instructions: [
          {
            id: "123e4567-e89b-42d3-a456-426614174000",
            name: "Review",
            body: "Review all changed code.",
            enabled: true,
            global: true,
            tags: [],
          },
        ],
        contextPacks: [],
        prompts: [
          {
            id: "123e4567-e89b-42d3-a456-426614174001",
            relativePath: "review.prompt.md",
            content: "---\nname: Fleet review\n---\nReview ${target}.",
          },
        ],
      },
      secrets: { openai: "fleet-openai-key", tavily: "fleet-search-key" },
    },
  };
}
async function setup(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "machdoch-settings-sync-"));
  roots.push(root);
  vi.stubEnv("MACHDOCH_USER_CONFIG_DIR", root);
  await writeFleetConnectionConfig(config);
  return root;
}
const controller = (): AbortController => new AbortController();
const fetchDelivery = (value = delivery()) =>
  vi.fn<typeof globalThis.fetch>(async (_url, init) =>
    init?.method === "PUT"
      ? new Response(null, { status: 204 })
      : Response.json(value),
  );

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe.sequential("Headless managed settings", () => {
  it("applies settings through the real runtime without changing local settings", async () => {
    const root = await setup();
    await saveUserApiKey("openai", "local-openai-key");
    const local = await readFile(getUserConfigPath(), "utf8");
    const fetch = fetchDelivery();
    await synchronizeFleetSettings({
      config,
      signal: controller().signal,
      fetch,
    });
    expect(await loadUserApiKeys()).toMatchObject({
      openai: "fleet-openai-key",
    });
    expect(await loadUserWebSearchSettings()).toMatchObject({
      activeProvider: "tavily",
      apiKeys: { tavily: "fleet-search-key" },
    });
    expect(await loadRuntimeConfig(root)).toMatchObject({
      provider: "openai",
      model: "gpt-5.4",
      mode: "ask",
      reasoning: "high",
      agentLimits: { executorTurns: 42, autopilotExecutorIterations: 7 },
    });
    expect(await loadUserAgentLimitsSettings()).toMatchObject({
      infinite: false,
    });
    expect(
      (await discoverCustomizations(root, { discoverUserCustomizations: true }))
        .prompts,
    ).toContainEqual(
      expect.objectContaining({
        name: "Fleet review",
        body: "Review ${target}.",
        scope: "user",
      }),
    );
    const instructions = await resolveInstructionSet({
      workspaceRoot: root,
      providerId: "openai",
      surface: "api",
    });
    expect(instructions.renderedEnvelope).toContain("Review all changed code.");
    expect(await readFile(getUserConfigPath(), "utf8")).toBe(local);
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toMatchObject({
      status: "applied",
      profileId: delivery().profile!.profileId,
      revision: 1,
    });
    expect(
      fetch.mock.calls.every(([, init]) => init?.redirect === "manual"),
    ).toBe(true);
  });

  it("keeps the last delivery offline and retries a failed acknowledgement after a 304", async () => {
    await setup();
    const fetch = fetchDelivery();
    fetch.mockImplementationOnce(async () => Response.json(delivery()));
    fetch.mockImplementationOnce(
      async () => new Response(null, { status: 503 }),
    );
    await expect(
      synchronizeFleetSettings({ config, signal: controller().signal, fetch }),
    ).rejects.toThrow("status report");
    expect(await loadFleetManagedProfile()).toMatchObject({ revision: 1 });
    const retry = vi.fn<typeof globalThis.fetch>(async (_url, init) =>
      init?.method === "PUT"
        ? new Response(null, { status: 204 })
        : new Response(null, { status: 304 }),
    );
    await synchronizeFleetSettings({
      config,
      signal: controller().signal,
      fetch: retry,
    });
    expect(retry.mock.calls[0]?.[1]?.headers).toHaveProperty("If-None-Match");
    expect(JSON.parse(String(retry.mock.calls[1]?.[1]?.body))).toHaveProperty(
      "status",
      "applied",
    );
  });

  it("overlays matching global instructions without changing the local library", async () => {
    const root = await setup();
    await createInstructionProfile({
      name: "Review",
      body: "Local review guidance.",
      global: true,
    });
    const libraryPath = join(root, "instruction-library.json");
    const original = await readFile(libraryPath, "utf8");
    const resolve = () =>
      resolveInstructionSet({
        workspaceRoot: root,
        providerId: "openai",
        surface: "api",
      });
    await synchronizeFleetSettings({
      config,
      signal: controller().signal,
      fetch: fetchDelivery(),
    });
    expect((await resolve()).renderedEnvelope).toContain(
      "Review all changed code.",
    );
    expect((await resolve()).renderedEnvelope).not.toContain(
      "Local review guidance.",
    );
    const disabled = delivery();
    disabled.profile!.document.instructions[0]!.enabled = false;
    await synchronizeFleetSettings({
      config,
      signal: controller().signal,
      fetch: fetchDelivery(disabled),
    });
    expect((await resolve()).renderedEnvelope).not.toContain(
      "Local review guidance.",
    );
    expect((await resolve()).renderedEnvelope).not.toContain(
      "Review all changed code.",
    );
    await synchronizeFleetSettings({
      config,
      signal: controller().signal,
      fetch: fetchDelivery({ ...delivery(), profile: null }),
    });
    expect((await resolve()).renderedEnvelope).toContain(
      "Local review guidance.",
    );
    expect(await readFile(libraryPath, "utf8")).toBe(original);
  });

  it("reveals preserved local credentials after unassignment, disablement and reset", async () => {
    await setup();
    await saveUserApiKey("openai", "local-key");
    await synchronizeFleetSettings({
      config,
      signal: controller().signal,
      fetch: fetchDelivery(),
    });
    await setFleetConnectionEnabled(false);
    expect(await loadFleetManagedProfile()).toBeNull();
    expect(await loadUserApiKeys()).toMatchObject({ openai: "local-key" });
    await setFleetConnectionEnabled(true);
    expect(await loadUserApiKeys()).toMatchObject({
      openai: "fleet-openai-key",
    });
    await synchronizeFleetSettings({
      config,
      signal: controller().signal,
      fetch: fetchDelivery({ ...delivery(), profile: null }),
    });
    expect(await loadUserApiKeys()).toMatchObject({ openai: "local-key" });
    await resetFleetConnection();
    expect(await loadFleetManagedProfile()).toBeNull();
  });

  it("rejects another manager and retains the valid cached delivery", async () => {
    await setup();
    await synchronizeFleetSettings({
      config,
      signal: controller().signal,
      fetch: fetchDelivery(),
    });
    const fetch = fetchDelivery({
      ...delivery(),
      managerId: `manager_${encoded(18, 8)}`,
    });
    await expect(
      synchronizeFleetSettings({ config, signal: controller().signal, fetch }),
    ).rejects.toThrow("another installation");
    expect(await loadFleetManagedProfile()).toMatchObject({ revision: 1 });
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toHaveProperty(
      "status",
      "failed",
    );
  });

  it("cannot commit or report a delivery after the enrollment changes", async () => {
    await setup();
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      await writeFleetConnectionConfig({
        ...config,
        instanceId: `instance_${encoded(18, 9)}`,
      });
      return Response.json(delivery());
    });
    await expect(
      synchronizeFleetSettings({ config, signal: controller().signal, fetch }),
    ).rejects.toThrow("connection changed");
    expect(await loadFleetManagedProfile()).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403])(
    "discards managed credentials when access is rejected (%s)",
    async (status) => {
      await setup();
      await saveUserApiKey("openai", "local-key");
      await synchronizeFleetSettings({
        config,
        signal: controller().signal,
        fetch: fetchDelivery(),
      });
      const fetch = vi.fn<typeof globalThis.fetch>(
        async () => new Response(null, { status }),
      );
      await expect(
        synchronizeFleetSettings({
          config,
          signal: controller().signal,
          fetch,
        }),
      ).rejects.toThrow("rejected");
      expect(await loadFleetManagedProfile()).toBeNull();
      expect((await loadUserApiKeys()).openai).toBe("local-key");
      await expect(
        readFile(getFleetManagedSettingsPath()),
      ).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("does not discard the new enrollment's cache for an old rejected request", async () => {
    await setup();
    await synchronizeFleetSettings({
      config,
      signal: controller().signal,
      fetch: fetchDelivery(),
    });
    const next = { ...config, instanceId: `instance_${encoded(18, 9)}` };
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      await writeFleetConnectionConfig(next);
      await synchronizeFleetSettings({
        config: next,
        signal: controller().signal,
        fetch: fetchDelivery(),
      });
      return new Response(null, { status: 401 });
    });
    await expect(
      synchronizeFleetSettings({ config, signal: controller().signal, fetch }),
    ).rejects.toThrow("connection changed");
    expect(await loadFleetManagedProfile()).toMatchObject({ revision: 1 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("ignores a cache from an old enrollment and rejects an uncached 304", async () => {
    await setup();
    await synchronizeFleetSettings({
      config,
      signal: controller().signal,
      fetch: fetchDelivery(),
    });
    const next = {
      ...config,
      instanceSecret: `mch_instance_${encoded(32, 7)}`,
    };
    await writeFleetConnectionConfig(next);
    expect(await loadFleetManagedProfile()).toBeNull();
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) =>
      init?.method === "PUT"
        ? new Response(null, { status: 204 })
        : new Response(null, { status: 304 }),
    );
    await expect(
      synchronizeFleetSettings({
        config: next,
        signal: controller().signal,
        fetch,
      }),
    ).rejects.toThrow("no settings");
  });

  it("bounds declared and streamed response sizes", async () => {
    await setup();
    const oversized = vi.fn<typeof globalThis.fetch>(async (_url, init) =>
      init?.method === "PUT"
        ? new Response(null, { status: 204 })
        : new Response("{}", {
            headers: {
              "Content-Length": String(maximumManagedSettingsDeliveryBytes + 1),
            },
          }),
    );
    await expect(
      synchronizeFleetSettings({
        config,
        signal: controller().signal,
        fetch: oversized,
      }),
    ).rejects.toThrow("size limit");
    const streamed = vi.fn<typeof globalThis.fetch>(async (_url, init) =>
      init?.method === "PUT"
        ? new Response(null, { status: 204 })
        : new Response(new Uint8Array(maximumManagedSettingsDeliveryBytes + 1)),
    );
    await expect(
      synchronizeFleetSettings({
        config,
        signal: controller().signal,
        fetch: streamed,
      }),
    ).rejects.toThrow("size limit");
    expect(await loadFleetManagedProfile()).toBeNull();
  });

  it("retries synchronization failures and stops polling promptly", async () => {
    await setup();
    const stop = controller();
    const onError = vi.fn(() => stop.abort());
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    try {
      await runFleetSettingsService({
        signal: stop.signal,
        onError,
        intervalMs: 1,
      });
      expect(onError).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("repairs a corrupt cache with a complete validated delivery", async () => {
    await setup();
    await writeFile(getFleetManagedSettingsPath(), "{broken");
    await expect(loadFleetManagedProfile()).rejects.toThrow("invalid");
    const fetch = fetchDelivery();
    await synchronizeFleetSettings({
      config,
      signal: controller().signal,
      fetch,
    });
    expect(fetch.mock.calls[0]?.[1]?.headers).not.toHaveProperty(
      "If-None-Match",
    );
    expect(await loadFleetManagedProfile()).toMatchObject({ revision: 1 });
  });

  it("uses the desktop context pack draft format and retains all managed packs", async () => {
    const root = await setup();
    const value = delivery();
    value.profile!.document.contextPacks = Array.from(
      { length: 64 },
      (_, index) => ({
        id: `123e4567-e89b-42d3-a456-${String(index).padStart(12, "0")}`,
        name: `Review ${index}`,
        instructions: "Review {target}.",
        prompt: "Fix the finding.",
        provider: null,
        model: null,
        mode: null,
        reasoning: null,
        variables: [{ name: "target", defaultValue: "src" }],
        triggerPhrases: [],
        pathPatterns: [],
        promptEnhancementMode: null,
        interviewEnabled: null,
        sessionMemoryEnabled: null,
        useGlobalMemory: null,
        uiControlEnabled: null,
      }),
    );
    await synchronizeFleetSettings({
      config,
      signal: controller().signal,
      fetch: fetchDelivery(value),
    });
    const runtime = await FleetCliProductRuntime.create(root);
    try {
      const initial = await runtime.handleRequest({
        type: "getProductSnapshot",
      });
      if (initial.type !== "productSnapshot" || !initial.snapshot.shell)
        throw new Error("Missing product shell.");
      expect(initial.snapshot.shell.contextPacks).toHaveLength(64);
      const sessionId = initial.snapshot.shell.activeSessionId!;
      expect(
        await runtime.handleRequest({
          type: "executeProductCommand",
          command: {
            kind: "apply-context-pack",
            sessionId,
            contextPackId: initial.snapshot.shell.contextPacks[0]!.id,
          },
        }),
      ).toMatchObject({ type: "commandAccepted" });
      const next = await runtime.handleRequest({ type: "getProductSnapshot" });
      expect(next).toMatchObject({
        type: "productSnapshot",
        snapshot: {
          shell: {
            composer: {
              draft:
                "## Context Pack: Review 0\n\n### Instructions\nReview src.\n\n### Prompt\nFix the finding.",
            },
          },
        },
      });
    } finally {
      await runtime.shutdown();
    }
  });

  it("exports local settings without credentials or managed prompts", async () => {
    const root = await setup();
    await saveUserApiKey("openai", "private-local-key");
    await mkdir(join(root, "prompts"));
    await writeFile(
      join(root, "prompts", "local.prompt.md"),
      "Review the workspace.",
    );
    await createInstructionProfile({
      name: "Local",
      body: "Keep the local instruction.",
    });
    await synchronizeFleetSettings({
      config,
      signal: controller().signal,
      fetch: fetchDelivery(),
    });
    const document = await exportFleetLocalSettings(root);
    expect(document.prompts).toHaveLength(1);
    expect(document.prompts[0]).toMatchObject({
      relativePath: "local.prompt.md",
      content: "Review the workspace.",
    });
    expect(document.instructions).toContainEqual(
      expect.objectContaining({ name: "Local" }),
    );
    expect(JSON.stringify(document)).not.toContain("private-local-key");
    expect(JSON.stringify(document)).not.toContain("fleet-openai-key");
    expect(document.defaults.provider).toBeNull();
  });

  it("captures the enrollment baseline before applying the first managed profile", async () => {
    await setup();
    const local = delivery().profile!.document;
    const captureLocalSettings = vi.fn(async () => local);
    const requests: string[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      const path = new URL(String(url)).pathname;
      requests.push(`${init?.method ?? "GET"} ${path}`);
      if (path.endsWith("/enrollment"))
        return init?.method === "PUT"
          ? new Response(null, { status: 204 })
          : Response.json({ captureRequired: true });
      return init?.method === "PUT"
        ? new Response(null, { status: 204 })
        : Response.json(delivery());
    });
    await synchronizeFleetSettings({
      config,
      signal: controller().signal,
      fetch,
      captureLocalSettings,
    });
    expect(
      requests.map((request) => request.slice(request.lastIndexOf("/"))),
    ).toEqual([
      "/enrollment",
      "/enrollment",
      `/${config.instanceId}`,
      "/sync-status",
    ]);
    expect(captureLocalSettings).toHaveBeenCalledTimes(1);
    await synchronizeFleetSettings({
      config,
      signal: controller().signal,
      fetch,
      captureLocalSettings,
    });
    expect(captureLocalSettings).toHaveBeenCalledTimes(1);
  });

  it("does not export settings when capture is disabled or already complete", async () => {
    await setup();
    const captureLocalSettings = vi.fn(
      async () => delivery().profile!.document,
    );
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) =>
      String(url).endsWith("/enrollment")
        ? Response.json({ captureRequired: false })
        : init?.method === "PUT"
          ? new Response(null, { status: 204 })
          : Response.json(delivery()),
    );
    await synchronizeFleetSettings({
      config,
      signal: controller().signal,
      fetch,
      captureLocalSettings,
    });
    expect(captureLocalSettings).not.toHaveBeenCalled();
    expect(await loadFleetManagedProfile()).toMatchObject({ revision: 1 });
  });
});
