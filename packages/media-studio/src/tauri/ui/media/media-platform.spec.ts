import { expect, it, vi } from "vitest";
import { invoke as nativeInvoke } from "@tauri-apps/api/core";
import { pickedFileName, releaseFile } from "./media-platform";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: () => true,
}));

it("shows native picker names on Windows and Linux", () => {
  expect(pickedFileName("C:\\pictures\\portrait.png")).toBe("portrait.png");
  expect(pickedFileName("/home/user/pictures/portrait.png")).toBe(
    "portrait.png",
  );
});

it("preserves native source files when their picker owner releases them", async () => {
  await expect(
    releaseFile("C:/pictures/original.png"),
  ).resolves.toBeUndefined();
  expect(nativeInvoke).not.toHaveBeenCalled();
});

it("reports a remote media operation once across the platform and transport", async () => {
  vi.resetModules();
  const { configureRemoteMediaPlatform, invoke } =
    await import("./media-platform");
  const { createFleetMediaTransport } =
    await import("../../../fleet-transport");
  const { setOperationAnalytics } =
    await import("@machdoch/analytics/operations");
  const { AnalyticsClient } = await import("@machdoch/analytics/client");
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(new Response());
  const client = new AnalyticsClient({
    app: "fleet",
    version: "30.2.0",
    surface: "browser",
    enabled: () => true,
    fetch,
  });
  const chunk = btoa(JSON.stringify({ id: "private-run" }));
  configureRemoteMediaPlatform(
    createFleetMediaTransport("host", async (request) =>
      request.kind === "read"
        ? { state: "complete", chunk, offset: 0, total: chunk.length }
        : { state: "pending" },
    ),
  );
  setOperationAnalytics({ client, onUse: vi.fn() });
  try {
    await expect(invoke("media_generate_images")).resolves.toEqual({
      id: "private-run",
    });
    await client.flush();
    const events = fetch.mock.calls.map((call) =>
      JSON.parse(call[1]?.body as string),
    );
    expect(events.map((event) => event.ev)).toEqual([
      "operation.started",
      "operation.completed",
    ]);
    expect(JSON.stringify(events)).not.toContain("private-run");
  } finally {
    setOperationAnalytics(null);
    client.stop();
  }
});
