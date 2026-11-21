import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cloudRequest, cloudUpload, createCommandSender } from "./api-client";

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

it("retains the command identity after an uncertain response and creates a new identity for changed or repeated input", async () => {
  const transport = vi
    .fn<typeof fetch>()
    .mockRejectedValueOnce(new TypeError("Connection closed"))
    .mockResolvedValueOnce(Response.json({ id: "saved" }))
    .mockResolvedValueOnce(Response.json({ id: "changed" }))
    .mockResolvedValueOnce(Response.json({ id: "repeated" }));
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
  await send("projects/one", { name: "Second" }, "PATCH");
  expect(
    new Headers(transport.mock.calls[3]![1]!.headers).get("Idempotency-Key"),
  ).not.toBe(requests[2]!.get("Idempotency-Key"));
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

class FakeUpload {
  static last: FakeUpload;
  status = 0;
  response: unknown = null;
  responseType = "";
  headers: Record<string, string> = {};
  upload: { onprogress?: (event: ProgressEvent) => void } = {};
  onload?: () => void;
  onerror?: () => void;
  constructor() {
    FakeUpload.last = this;
  }
  open() {}
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  send() {}
}

it("reports upload progress and returns the stored file", async () => {
  vi.stubGlobal("XMLHttpRequest", FakeUpload);
  const progress = vi.fn();
  const result = cloudUpload("attachments", new Blob(["hello"]), progress);
  const request = FakeUpload.last;
  expect(request.headers["x-machdoch-cloud-csrf"]).toBe("test-csrf");
  request.upload.onprogress?.({
    loaded: 2,
    total: 5,
    lengthComputable: true,
  } as ProgressEvent);
  request.status = 201;
  request.response = { id: "file" };
  request.onload?.();
  await expect(result).resolves.toEqual({ id: "file" });
  expect(progress).toHaveBeenCalledWith(2, 5);
});

it("explains rejected and interrupted uploads", async () => {
  vi.stubGlobal("XMLHttpRequest", FakeUpload);
  const rejected = cloudUpload("attachments", new Blob(["x"]));
  FakeUpload.last.status = 413;
  FakeUpload.last.response = { error: "File is too large.", code: "too_large" };
  FakeUpload.last.onload?.();
  await expect(rejected).rejects.toMatchObject({
    message: "File is too large.",
    status: 413,
  });
  const interrupted = cloudUpload("attachments", new Blob(["x"]));
  FakeUpload.last.onerror?.();
  await expect(interrupted).rejects.toMatchObject({
    code: "network_unavailable",
  });
});
