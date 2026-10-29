import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  managedSettingsSchemaVersion,
  maximumManagedSettingsCollectionEntries,
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
  saveUserAgentLimitsSettings,
  saveUserApiKey,
} from "./env.js";
import {
  resetFleetConnection,
  setFleetConnectionEnabled,
  writeFleetConnectionConfig,
  type FleetConnectionConfig,
} from "./fleet-connection.js";
import {
  fleetConnectionDigest,
  getFleetManagedSettingsPath,
  loadFleetManagedProfile,
  runFleetSettingsService,
  synchronizeFleetSettings,
} from "./fleet-settings.js";
import { resolveInstructionSet } from "./instruction-system/resolver.js";
import { projectMcpForProvider } from "./provider-enrollment/mcp-projector.js";
import { FleetCliProductRuntime } from "../cli/_helpers/cli-fleet-product.js";
import {
  collectFleetLocalSettings,
  exportFleetLocalSettings,
  stablePromptId,
} from "./fleet-settings-export.js";
import { createInstructionProfile } from "./instruction-system/library-store.js";
import {
  getUserMcpConfigPath,
  loadMcpConfig,
  loadMcpConfigSync,
} from "./mcp/config.js";

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
    await expect(readFile(getFleetManagedSettingsPath())).rejects.toMatchObject(
      { code: "ENOENT" },
    );
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

  it("captures the enrollment baseline on clouds without snapshots", async () => {
    await setup();
    const local = delivery().profile!.document;
    const captureLocalSettings = vi.fn(async () => local);
    const requests: string[] = [];
    let captureRequired = true;
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      const path = new URL(String(url)).pathname;
      requests.push(`${init?.method ?? "GET"} ${path}`);
      if (path.endsWith("/snapshot"))
        return new Response(null, { status: 404 });
      if (path.endsWith("/enrollment")) {
        if (init?.method === "PUT") {
          captureRequired = false;
          return new Response(null, { status: 204 });
        }
        return Response.json({ captureRequired });
      }
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
      "/snapshot",
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
      String(url).endsWith("/snapshot")
        ? Response.json({ requested: false, capturedAt: 1_700_000_000 })
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

  it("captures settings when the manager enables capture after a delivery was cached", async () => {
    await setup();
    const local = delivery().profile!.document;
    const captureLocalSettings = vi.fn(async () => local);
    let captureRequired = false;
    let managed: FleetManagedSettingsDelivery = {
      ...delivery(),
      profile: null,
    };
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      if (String(url).endsWith("/snapshot"))
        return new Response(null, { status: 404 });
      if (String(url).endsWith("/enrollment")) {
        if (init?.method === "PUT") {
          expect(JSON.parse(String(init.body))).toEqual(local);
          captureRequired = false;
          return new Response(null, { status: 204 });
        }
        return Response.json({ captureRequired });
      }
      return init?.method === "PUT"
        ? new Response(null, { status: 204 })
        : Response.json(managed);
    });
    const synchronize = () =>
      synchronizeFleetSettings({
        config,
        signal: controller().signal,
        fetch,
        captureLocalSettings,
      });
    await synchronize();
    expect(captureLocalSettings).not.toHaveBeenCalled();
    expect(await loadFleetManagedProfile()).toBeNull();
    captureRequired = true;
    managed = delivery();
    await synchronize();
    await synchronize();
    expect(captureLocalSettings).toHaveBeenCalledTimes(1);
    expect(await loadFleetManagedProfile()).toMatchObject({ revision: 1 });
  });

  it("uploads requested snapshots and reports every assigned layer", async () => {
    await setup();
    const local = delivery().profile!.document;
    const captureLocalSettings = vi.fn(async () => local);
    let requested = true;
    const layered: FleetManagedSettingsDelivery = {
      ...delivery(),
      layers: [
        {
          profileId: delivery().profile!.profileId,
          name: "Baseline",
          revision: 1,
        },
        { profileId: `profile_${encoded(18, 5)}`, name: "Team", revision: 4 },
      ],
    };
    const uploads: unknown[] = [];
    const reports: unknown[] = [];
    const deliveryUrls: string[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      const target = new URL(String(url));
      if (target.pathname.endsWith("/snapshot")) {
        if (init?.method === "PUT") {
          uploads.push(JSON.parse(String(init.body)));
          requested = false;
          return new Response(null, { status: 204 });
        }
        return Response.json({ requested, capturedAt: requested ? null : 1 });
      }
      if (target.pathname.endsWith("/sync-status")) {
        reports.push(JSON.parse(String(init?.body)));
        return new Response(null, { status: 204 });
      }
      deliveryUrls.push(target.search);
      return Response.json(layered);
    });
    const synchronize = (forceSnapshot = false) =>
      synchronizeFleetSettings({
        config,
        signal: controller().signal,
        fetch,
        captureLocalSettings,
        forceSnapshot,
      });
    await synchronize();
    await synchronize();
    expect(uploads).toEqual([local]);
    await synchronize(true);
    expect(uploads).toHaveLength(2);
    expect(deliveryUrls[0]).toBe("?schemaVersion=3");
    expect(reports[0]).toEqual({
      status: "applied",
      managerId: config.managerId,
      profileId: delivery().profile!.profileId,
      revision: 1,
      layers: [
        { profileId: delivery().profile!.profileId, revision: 1 },
        { profileId: `profile_${encoded(18, 5)}`, revision: 4 },
      ],
    });
  });

  it("keeps the user's own values where the cloud only sets defaults", async () => {
    const root = await setup();
    await saveUserApiKey("openai", "local-openai-key");
    await saveUserApiKey("anthropic", "local-anthropic-key");
    await saveUserAgentLimitsSettings({
      ...(await loadUserAgentLimitsSettings()),
      autopilotExecutorIterations: 3,
    });
    const value = delivery();
    value.profile!.document.policy = {
      enforced: ["secret:anthropic", "executorTurns", "reasoning"],
    };
    value.profile!.secrets = {
      openai: "fleet-openai-key",
      anthropic: "fleet-anthropic-key",
      google: "fleet-google-key",
    };
    await synchronizeFleetSettings({
      config,
      signal: controller().signal,
      fetch: fetchDelivery(value),
    });
    expect(await loadUserApiKeys()).toMatchObject({
      openai: "local-openai-key",
      anthropic: "fleet-anthropic-key",
      google: "fleet-google-key",
    });
    expect(await loadUserAgentLimitsSettings()).toMatchObject({
      executorTurns: 42,
      autopilotExecutorIterations: 3,
    });
    expect(
      (
        await loadRuntimeConfig(
          root,
          undefined,
          undefined,
          undefined,
          undefined,
          "low",
        )
      ).reasoning,
    ).toBe("low");
    expect((await loadRuntimeConfig(root)).reasoning).toBe("high");
  });

  it("replaces a same-named local prompt instead of listing it twice", async () => {
    const root = await setup();
    await mkdir(join(root, "prompts", ".fleet-managed", config.managerId), {
      recursive: true,
    });
    await writeFile(
      join(root, "prompts", "review.prompt.md"),
      "---\nname: Local review\n---\nLocal review.",
    );
    await writeFile(
      join(root, "prompts", "local.prompt.md"),
      "Keep this prompt.",
    );
    await writeFile(
      join(
        root,
        "prompts",
        ".fleet-managed",
        config.managerId,
        "review.prompt.md",
      ),
      "---\nname: Mirrored review\n---\nMirrored.",
    );
    await synchronizeFleetSettings({
      config,
      signal: controller().signal,
      fetch: fetchDelivery(),
    });
    const prompts = (
      await discoverCustomizations(root, { discoverUserCustomizations: true })
    ).prompts.filter((prompt) => prompt.scope === "user");
    expect(prompts.map((prompt) => prompt.name).sort()).toEqual([
      "Fleet review",
      "local",
    ]);
    const exported = await exportFleetLocalSettings(root);
    expect(
      exported.prompts.map((prompt) => prompt.relativePath).sort(),
    ).toEqual(["local.prompt.md", "review.prompt.md"]);
    expect(JSON.stringify(exported.prompts)).not.toContain("Mirrored");
  });

  it("adds managed MCP servers and keeps servers without their secrets off", async () => {
    const root = await setup();
    const value = delivery();
    value.profile!.document.mcpServers = [
      {
        id: "github",
        title: "GitHub",
        enabled: true,
        transport: {
          type: "stdio",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-github"],
          env: { GITHUB_TOKEN: "{{secret:mcp_github_token}}" },
        },
      },
      {
        id: "docs",
        title: null,
        enabled: true,
        transport: {
          type: "streamable-http",
          url: "https://docs.example.test/mcp",
          headers: { Authorization: "Bearer {{secret:mcp_docs_token}}" },
        },
      },
    ];
    value.profile!.secrets = { mcp_github_token: "ghp_managed" };
    // The user's own "docs" server must not lend its credentials or options.
    await writeFile(
      getUserMcpConfigPath(),
      JSON.stringify({
        schemaVersion: 1,
        servers: [
          {
            id: "docs",
            transport: {
              type: "streamable-http",
              url: "https://docs.example.test/mcp",
              sessionId: "local-session",
            },
            auth: { type: "bearer", token: "local-docs-token" },
            securityProfile: "strict",
          },
        ],
      }),
    );
    const fetch = fetchDelivery(value);
    await synchronizeFleetSettings({
      config,
      signal: controller().signal,
      fetch,
    });
    const mcp = await loadMcpConfig(root);
    const github = mcp.servers.find((server) => server.id === "github");
    expect(github).toMatchObject({
      enabled: true,
      sources: ["managed"],
      transport: {
        command: "npx",
        env: { GITHUB_TOKEN: "ghp_managed" },
      },
    });
    // "github" is also a preset id; nothing of the preset carries over.
    expect(github).not.toHaveProperty("auth");
    expect(github).not.toHaveProperty("preset");
    expect(github).not.toHaveProperty("description");
    const docs = mcp.servers.find((server) => server.id === "docs");
    expect(docs).toMatchObject({ enabled: false, sources: ["managed"] });
    expect(docs).not.toHaveProperty("auth");
    expect(docs?.securityProfile).not.toBe("strict");
    expect(docs?.transport).not.toHaveProperty("sessionId");
    expect(loadMcpConfigSync(root).servers.map((server) => server.id)).toEqual(
      expect.arrayContaining(["github", "docs"]),
    );
    const report = fetch.mock.calls.find(([url]) =>
      String(url).endsWith("/sync-status"),
    );
    expect(JSON.parse(String(report?.[1]?.body))).toMatchObject({
      status: "applied",
      warnings: [
        'MCP server "docs" stays off until machdoch.cloud provides the secret mcp_docs_token.',
      ],
    });
  });

  it("keeps machdoch.cloud MCP secrets out of agent CLI configuration", async () => {
    const root = await setup();
    const value = delivery();
    value.profile!.document.mcpServers = [
      {
        id: "search",
        title: "Search",
        enabled: true,
        transport: {
          type: "streamable-http",
          url: "https://search.example.test/mcp?key={{secret:mcp_search_key}}",
          headers: {},
        },
      },
    ];
    value.profile!.secrets = { mcp_search_key: "managed-search-key" };
    await synchronizeFleetSettings({
      config,
      signal: controller().signal,
      fetch: fetchDelivery(value),
    });
    const projection = await projectMcpForProvider("codex-cli", root, {
      machdochCliLaunch: {
        command: "machdoch-node-test",
        args: [],
        cwd: root,
        environment: {},
      },
    });
    const search = projection.servers.find(
      (server) => server.canonicalId === "search",
    );
    expect(search?.route).toBe("cli-stdio-proxy");
    expect(JSON.stringify(projection)).not.toContain("managed-search-key");
  });

  it("exports the user's MCP servers with placeholders instead of secrets", async () => {
    const root = await setup();
    await writeFile(
      getUserMcpConfigPath(),
      JSON.stringify({
        schemaVersion: 1,
        servers: [
          {
            id: "tracker",
            title: "Issue tracker",
            transport: {
              type: "stdio",
              command: "tracker-mcp",
              args: ["--readonly"],
              env: { TRACKER_TOKEN: "very-secret-token" },
            },
          },
          // Presets exist on every device and are not part of its own settings.
          {
            id: "github",
            preset: "github-remote",
            transport: {
              type: "streamable-http",
              url: "https://api.githubcopilot.com/mcp/",
            },
            auth: { type: "bearer", token: "ghp_local" },
          },
        ],
      }),
    );
    const exported = await exportFleetLocalSettings(root);
    expect(exported.mcpServers).toEqual([
      {
        id: "tracker",
        title: "Issue tracker",
        enabled: true,
        transport: {
          type: "stdio",
          command: "tracker-mcp",
          args: ["--readonly"],
          env: { TRACKER_TOKEN: "{{secret:mcp_tracker_tracker_token}}" },
        },
      },
    ]);
    expect(JSON.stringify(exported)).not.toContain("very-secret-token");
  });

  it("exports MCP arguments and URLs without embedded credentials", async () => {
    const root = await setup();
    await writeFile(
      getUserMcpConfigPath(),
      JSON.stringify({
        schemaVersion: 1,
        servers: [
          {
            id: "database",
            transport: {
              type: "stdio",
              command: "mcp-server",
              args: [
                "--api-key",
                "secret-one",
                "--token=secret-two",
                "postgresql://reader:secret-three@db.example.test/app",
                "GITHUB_TOKEN=secret-four",
                "--env=SERVICE_PASSWORD=secret-five",
                "https://remote.example.test/sse?key=secret-six",
                "--port",
                "3000",
                "-y",
                "@modelcontextprotocol/server-github",
                "ghp_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8",
                "--label=sk-proj-Zk3pQ9xL2mN7vB4cR8tY1wE6",
                "Q2xvdWRmbGFyZS1zZWNyZXQtdG9rZW4tMTIzNDU2",
                "--password",
                "hunter2",
              ],
              cwd: "C:/Users/someone/private",
            },
          },
          {
            id: "search",
            transport: {
              type: "sse",
              url: "https://user:secret-seven@search.example.test/sse?api_key=secret-eight&region=eu#private",
            },
          },
        ],
      }),
    );
    const exported = await exportFleetLocalSettings(root);
    const serialized = JSON.stringify(exported.mcpServers);
    for (const secret of [
      "secret-one",
      "secret-two",
      "secret-three",
      "secret-four",
      "secret-five",
      "secret-six",
      "secret-seven",
      "secret-eight",
      "someone",
      "reader",
      "a1B2c3D4",
      "Zk3pQ9",
      "Q2xvdWRm",
      "hunter2",
    ])
      expect(serialized).not.toContain(secret);
    expect(exported.mcpServers?.[0]?.transport).toMatchObject({
      args: [
        "--api-key",
        "{{secret:mcp_database_api-key}}",
        "--token={{secret:mcp_database_token}}",
        "postgresql://{{secret:mcp_database_username}}:{{secret:mcp_database_password}}@db.example.test/app",
        "GITHUB_TOKEN={{secret:mcp_database_github_token}}",
        "--env=SERVICE_PASSWORD={{secret:mcp_database_service_password}}",
        "https://remote.example.test/sse?key={{secret:mcp_database_key}}",
        "--port",
        "3000",
        "-y",
        "@modelcontextprotocol/server-github",
        "{{secret:mcp_database_arg_12}}",
        "--label={{secret:mcp_database_label}}",
        "{{secret:mcp_database_arg_14}}",
        "--password",
        "{{secret:mcp_database_password}}",
      ],
    });
    expect(exported.mcpServers?.[1]?.transport).toMatchObject({
      url: "https://{{secret:mcp_search_username}}:{{secret:mcp_search_password}}@search.example.test/sse?api_key={{secret:mcp_search_api_key}}&region={{secret:mcp_search_region}}",
    });
  });

  it("leaves out local items machdoch.cloud cannot store instead of failing the upload", async () => {
    const root = await setup();
    await mkdir(join(root, "prompts"));
    await writeFile(join(root, "prompts", "my review.prompt.md"), "Spaces.");
    await Promise.all(
      Array.from(
        { length: maximumManagedSettingsCollectionEntries + 1 },
        (_, index) =>
          writeFile(
            join(
              root,
              "prompts",
              `kept-${String(index).padStart(3, "0")}.prompt.md`,
            ),
            "Kept.",
          ),
      ),
    );
    await writeFile(
      getUserConfigPath(),
      JSON.stringify({
        agentLimits: { executorTurns: 0, autopilotExecutorIterations: 4 },
      }),
    );
    const { document, leftOut } = await collectFleetLocalSettings(root);
    expect(document.prompts).toHaveLength(
      maximumManagedSettingsCollectionEntries,
    );
    expect(document.prompts[0]).toMatchObject({
      id: stablePromptId("kept-000.prompt.md"),
      relativePath: "kept-000.prompt.md",
    });
    expect(document.agentLimits).toEqual({
      infinite: null,
      executorTurns: null,
      autopilotExecutorIterations: 4,
    });
    // The prompt with a space, the prompt over the limit and the invalid limit.
    expect(leftOut).toBe(3);
    const again = await exportFleetLocalSettings(root);
    expect(again.prompts.map((prompt) => prompt.id)).toEqual(
      document.prompts.map((prompt) => prompt.id),
    );
    expect(stablePromptId("Review.prompt.md")).toBe(
      stablePromptId(" review.prompt.md"),
    );
    expect(stablePromptId("review.prompt.md")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
  });

  it("applies managed settings when the device baseline cannot be uploaded", async () => {
    await setup();
    const reports: unknown[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/snapshot"))
        return new Response(null, { status: 500 });
      if (path.endsWith("/sync-status")) {
        reports.push(JSON.parse(String(init?.body)));
        return new Response(null, { status: 204 });
      }
      return Response.json(delivery());
    });
    await synchronizeFleetSettings({
      config,
      signal: controller().signal,
      fetch,
      captureLocalSettings: async () => delivery().profile!.document,
    });
    expect(await loadFleetManagedProfile()).toMatchObject({ revision: 1 });
    expect(reports).toEqual([
      expect.objectContaining({
        status: "applied",
        warnings: [
          "Device settings could not be uploaded: machdoch.cloud rejected device settings status (500).",
        ],
      }),
    ]);
  });

  it("does not send version 3 report fields to clouds that delivered version 2", async () => {
    await setup();
    const reports: unknown[] = [];
    const legacy = delivery();
    legacy.schemaVersion = 2;
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/snapshot"))
        return new Response(null, { status: 404 });
      if (path.endsWith("/enrollment"))
        return new Response(null, { status: 404 });
      if (path.endsWith("/sync-status")) {
        reports.push(JSON.parse(String(init?.body)));
        return new Response(null, { status: 204 });
      }
      return Response.json(legacy);
    });
    await synchronizeFleetSettings({
      config,
      signal: controller().signal,
      fetch,
      captureLocalSettings: async () => delivery().profile!.document,
    });
    expect(reports).toEqual([
      {
        status: "applied",
        managerId: config.managerId,
        profileId: legacy.profile!.profileId,
        revision: 1,
      },
    ]);
  });

  it("reads a cache written by the desktop shell, including secrets this version ignores", async () => {
    await setup();
    await saveUserApiKey("openai", "local-openai-key");
    const value = delivery();
    value.profile!.document.policy = { enforced: ["secret:openai"] };
    value.profile!.secrets = {
      openai: "fleet-openai-key",
      "future-provider": "unknown-key",
    };
    await writeFile(
      getFleetManagedSettingsPath(),
      JSON.stringify({
        connectionDigest: fleetConnectionDigest(config),
        delivery: value,
      }),
    );
    expect(await loadUserApiKeys()).toEqual({ openai: "fleet-openai-key" });
    expect(await loadFleetManagedProfile()).toMatchObject({ revision: 1 });
  });

  it("computes the connection digest the desktop shell uses", () => {
    expect(
      fleetConnectionDigest({
        ...config,
        managerId: "manager_MDEyMzQ1Njc4OTAxMjM0NTY3",
        instanceId: "instance_MDEyMzQ1Njc4OTAxMjM0NTY3",
        instanceSecret:
          "mch_instance_AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM",
      }),
    ).toBe("393cc8e896db8c774251e963eb88ed6fb1a9dd41b121727445ecdd785ef5fad3");
  });

  it("keeps enforced values ahead of environment and workspace settings", async () => {
    const root = await setup();
    const value = delivery();
    value.profile!.document.policy = {
      enforced: ["webSearchProvider", "executorTurns", "reasoning"],
    };
    value.profile!.document.defaults.reasoning = "max";
    await synchronizeFleetSettings({
      config,
      signal: controller().signal,
      fetch: fetchDelivery(value),
    });
    vi.stubEnv("MACHDOCH_WEB_SEARCH_PROVIDER", "serper");
    await mkdir(join(root, ".machdoch"), { recursive: true });
    await writeFile(
      join(root, ".machdoch", "config.json"),
      JSON.stringify({
        agentLimits: { executorTurns: 5, autopilotExecutorIterations: 2 },
      }),
    );
    const runtime = await loadRuntimeConfig(root);
    expect(runtime.webSearch.activeProvider).toBe("tavily");
    expect(runtime.agentLimits).toEqual({
      executorTurns: 42,
      autopilotExecutorIterations: 2,
    });
    // An enforced cap also turns off the user's infinite mode.
    await saveUserAgentLimitsSettings({
      ...(await loadUserAgentLimitsSettings()),
      infinite: true,
    });
    expect(await loadUserAgentLimitsSettings()).toMatchObject({
      infinite: false,
      executorTurns: 42,
    });
    // gpt-5.4 has no "max" reasoning; the enforced value falls back instead of failing.
    expect(runtime.reasoning).toBe("default");
    expect(
      (
        await loadRuntimeConfig(root, undefined, undefined, undefined, {
          executorTurns: 9,
        })
      ).agentLimits?.executorTurns,
    ).toBe(9);
  });
});
