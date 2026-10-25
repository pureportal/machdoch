import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cloudRequest, createCommandSender } from "./api-client";

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("document", { cookie: "__Host-machdoch_cloud_csrf=test-csrf" });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function stalledFetch() {
  const transport = vi.fn<typeof fetch>(
    (_input, init) =>
      new Promise((_resolve, reject) => {
        init!.signal!.addEventListener(
          "abort",
          () => reject(init!.signal!.reason),
          { once: true },
        );
      }),
  );
  vi.stubGlobal("fetch", transport);
  return transport;
}

it("bounds a connection that never returns headers", async () => {
  stalledFetch();
  const response = expect(cloudRequest("workspace")).rejects.toMatchObject({
    status: 408,
    code: "request_timeout",
  });
  await vi.advanceTimersByTimeAsync(30000);
  await response;
  expect(vi.getTimerCount()).toBe(0);
});

it("also bounds a response body that stalls after its headers", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(
      async (_input, init) =>
        new Response(
          new ReadableStream({
            start(controller) {
              init!.signal!.addEventListener(
                "abort",
                () => controller.error(init!.signal!.reason),
                { once: true },
              );
            },
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
    ),
  );
  const response = expect(cloudRequest("workspace")).rejects.toMatchObject({
    code: "request_timeout",
  });
  await vi.advanceTimersByTimeAsync(30000);
  await response;
  expect(vi.getTimerCount()).toBe(0);
});

it("preserves caller cancellation and releases its deadline", async () => {
  stalledFetch();
  const controller = new AbortController();
  const reason = new DOMException("Page closed", "AbortError");
  const response = expect(
    cloudRequest("workspace", { signal: controller.signal }),
  ).rejects.toBe(reason);
  controller.abort(reason);
  await response;
  expect(vi.getTimerCount()).toBe(0);
});

it("retains the command identity after an uncertain response and creates a new identity for changed input", async () => {
  const transport = vi
    .fn<typeof fetch>()
    .mockRejectedValueOnce(new TypeError("Connection closed"))
    .mockResolvedValueOnce(Response.json({ id: "saved" }))
    .mockResolvedValueOnce(Response.json({ id: "changed" }));
  vi.stubGlobal("fetch", transport);
  const send = createCommandSender();
  await expect(
    send("projects/one", { name: "First" }, "PATCH"),
  ).rejects.toMatchObject({ code: "network_unavailable" });
  expect(await send("projects/one", { name: "First" }, "PATCH")).toEqual({
    id: "saved",
  });
  await send("projects/one", { name: "Second" }, "PATCH");
  const requests = transport.mock.calls.map(
    ([, init]) => new Headers(init!.headers),
  );
  expect(requests[0]!.get("Idempotency-Key")).toBe(
    requests[1]!.get("Idempotency-Key"),
  );
  expect(requests[2]!.get("Idempotency-Key")).not.toBe(
    requests[1]!.get("Idempotency-Key"),
  );
  expect(requests[0]!.get("x-machdoch-cloud-csrf")).toBe("test-csrf");
  expect(vi.getTimerCount()).toBe(0);
});

it("reports malformed gateway bodies without displaying them and preserves structured server errors", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response("<html>private upstream detail</html>", { status: 502 }),
      )
      .mockResolvedValueOnce(
        Response.json(
          { error: "This item changed.", code: "revision_conflict" },
          { status: 409 },
        ),
      ),
  );
  await expect(cloudRequest("workspace")).rejects.toMatchObject({
    message: "Cloud returned an invalid response. Try again.",
    status: 502,
    code: "invalid_response",
  });
  await expect(cloudRequest("workspace")).rejects.toMatchObject({
    message: "This item changed.",
    status: 409,
    code: "revision_conflict",
  });
  expect(vi.getTimerCount()).toBe(0);
});
