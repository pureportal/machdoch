import { describe, expect, it, vi } from "vitest";
import { AnalyticsClient, type EventMetadata } from "./client.js";
import {
  ANALYTICS_ENDPOINT,
  PROJECTS,
  NOTICE_REVISION,
  commandFeature,
  fleetOperation,
  invocationOperation,
  routeFor,
} from "./catalog.js";

const makeClient = (enabled = true) => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(new Response("{}", { status: 201 }));
  const client = new AnalyticsClient({
    app: "fleet",
    version: "30.1.0",
    surface: "browser",
    enabled: () => enabled,
    fetch,
  });
  return { client, fetch };
};
describe("privacy boundaries", () => {
  it("sends no requests without consent", async () => {
    const { client, fetch } = makeClient(false);
    client.pageview("/instances");
    client.track("feature.used", { feature: "chat" });
    client.error(new Error("private"));
    client.heartbeat();
    await client.flush();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("uses the selected project without credentials or referrer", async () => {
    const { client, fetch } = makeClient();
    client.pageview("/instances");
    await client.flush();
    expect(fetch.mock.calls[0]?.[0]).toBe(ANALYTICS_ENDPOINT);
    const request = fetch.mock.calls[0]?.[1];
    expect(request?.credentials).toBe("omit");
    expect(request?.referrerPolicy).toBe("no-referrer");
    expect(request?.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(request?.body as string).pid).toBe(PROJECTS.fleet);
  });
  it("identifies CLI requests as Machdoch without pretending to be a browser", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response("{}", { status: 201 }));
    const client = new AnalyticsClient({
      app: "software",
      version: "30.1.0",
      surface: "cli",
      enabled: () => true,
      fetch,
    });
    client.pageview("/cli/run");
    await client.flush();
    expect(fetch.mock.calls[0]?.[1]?.headers).toEqual({
      "Content-Type": "application/json",
      "User-Agent": "Machdoch/30.1.0 (CLI)",
    });
  });
  it("rejects personal metadata, unknown feature names, and invalid numbers", async () => {
    const { client, fetch } = makeClient();
    client.track("feature.used", {
      feature: "chat",
      operation: "person@example.com",
      duration_ms: Infinity,
      prompt: "secret task",
      userId: "private-user",
      model: "private-model",
    } as unknown as EventMetadata);
    await client.flush();
    const body = JSON.parse(fetch.mock.calls[0]?.[1]?.body as string);
    expect(body.meta).toEqual({
      app: "fleet",
      version: "30.1.0",
      surface: "browser",
      consent_revision: NOTICE_REVISION,
      feature: "chat",
    });
  });
  it("normalizes private routes and rejects direct private URLs", async () => {
    const { client, fetch } = makeClient();
    expect(routeFor("fleet", "/instances/private-device/runs")).toBe(
      "/instances/:instance/runs",
    );
    client.pageview("/instances/private-device");
    client.pageview("/alice@example.com?token=secret");
    await client.flush();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("removes messages, identifiers, and paths from error reports", async () => {
    const { client, fetch } = makeClient();
    const error = new TypeError(
      "secret prompt person@example.com C:\\Private\\workspace",
    );
    error.stack =
      "TypeError: secret\n at https://private-host/assets/main-abc.js:12:4\n at C:\\Private\\file.ts:1:1";
    client.error(error);
    client.error(error);
    await client.flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetch.mock.calls[0]?.[1]?.body as string);
    expect(body.name).toBe("TypeError");
    expect(body.stackTrace).toBe("main-abc.js:12:4");
    expect(JSON.stringify(body)).not.toMatch(
      /secret|Private|example.com|private-host/,
    );
  });
  it("aborts pending requests on withdrawal", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(
        (_url, init) =>
          new Promise((_resolve, reject) =>
            init?.signal?.addEventListener("abort", () =>
              reject(new Error("aborted")),
            ),
          ),
      );
    const client = new AnalyticsClient({
      app: "fleet",
      version: "30.1.0",
      surface: "browser",
      enabled: () => true,
      fetch,
    });
    client.track("session.started");
    client.stop();
    await client.flush();
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    client.heartbeat();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("does not turn unavailable delivery into an application failure", async () => {
    const { client, fetch } = makeClient();
    fetch.mockRejectedValue(new Error("offline"));
    client.track("session.started");
    await expect(client.flush()).resolves.toBeUndefined();
    expect(client.deliveryFailures).toBe(1);
  });
  it("excludes polling and never returns private paths as operation names", () => {
    expect(commandFeature("media.flow.node.add")).toBe("media.workflows");
    expect(commandFeature("app.view.chat")).toBe("chat");
    expect(commandFeature("workspaces.files.select")).toBe("files");
    expect(commandFeature("workspaces.git.commit")).toBe("git");
    expect(fleetOperation("/api/instances/secret-id", "GET")).toBeUndefined();
    expect(fleetOperation("/api/instances/secret-id", "DELETE")).toBe(
      "fleet.instances.control",
    );
    expect(
      invocationOperation("run_scheduler_command", {
        request: { arguments: ["list", "--cwd", "private"] },
      }),
    ).toBe("");
    expect(
      invocationOperation("run_scheduler_command", {
        request: { arguments: ["create", "secret prompt"] },
      }),
    ).toBe("run_scheduler_command");
    expect(routeFor("fleet", "/media-studio/ralph.html")).toBe("/app/ralph");
    expect(routeFor("fleet", "/media-studio/private-person.html")).toBe(
      "/other",
    );
  });
  it("allows a repeated error after the rate limit interval", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    const { client, fetch } = makeClient();
    const error = new TypeError("private message");
    client.error(error);
    await client.flush();
    clock.mockReturnValue(61_001);
    client.error(error);
    await client.flush();
    expect(fetch).toHaveBeenCalledTimes(2);
    clock.mockRestore();
  });
});
