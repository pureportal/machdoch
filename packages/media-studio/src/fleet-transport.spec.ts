import { afterEach, describe, expect, it, vi } from "vitest";
import type { MediaRequest } from "@machdoch/fleet-protocol";
import { createFleetMediaTransport } from "./fleet-transport";

const encodeJson = (value: unknown): string =>
  btoa(
    Array.from(new TextEncoder().encode(JSON.stringify(value)), (byte) =>
      String.fromCharCode(byte),
    ).join(""),
  );

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Fleet media transport", () => {
  it("reserves a new RefMod export destination and keeps the permanent result after downloading", async () => {
    vi.useFakeTimers();
    const click = vi.fn();
    vi.stubGlobal("document", { createElement: () => ({ click }) });
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:refmod");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const invoked: Array<{ command: string; args: Record<string, unknown> }> =
      [];
    const operations = new Map<
      string,
      { command: string; args: Record<string, unknown> }
    >();
    const transport = createFleetMediaTransport("host", async (request) => {
      if (request.kind === "invoke") {
        const operation = { command: request.command, args: request.args };
        invoked.push(operation);
        operations.set(request.id, operation);
        return { state: "pending" };
      }
      if (request.kind !== "read") return { state: "pending" };
      const operation = operations.get(request.id)!;
      const value =
        operation.command === "media_create_transfer"
          ? { path: `C:/transfers/${operation.args.id}-${operation.args.name}` }
          : operation.command === "media_write_transfer"
            ? { offset: 1 }
            : operation.command === "media_read_transfer"
              ? { data: "AA==", total: 1 }
              : operation.command === "media_refmod_operation"
                ? { path: "C:/models/refmods/permanent.safetensors", tokens: 4 }
                : null;
      const chunk = encodeJson(value);
      return { state: "complete", chunk, offset: 0, total: chunk.length };
    });
    const source = await transport.upload(
      new Blob([new Uint8Array([0])]),
      "source.png",
    );
    const outputPath = await transport.save({
      defaultPath: "hero.safetensors",
    });
    const created = transport.invoke("media_refmod_operation", {
      workspaceRoot: "C:/work",
      request: {
        operation: "create",
        sources: [{ path: source }],
        outputPath,
        keepInLibrary: true,
      },
    });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(created).resolves.toMatchObject({
      path: "C:/models/refmods/permanent.safetensors",
    });
    expect(
      invoked
        .filter((operation) => operation.command === "media_create_transfer")
        .map((operation) => operation.args.direction),
    ).toEqual(["upload", "download"]);
    expect(click).toHaveBeenCalledOnce();
    expect(
      invoked.filter(
        (operation) => operation.command === "media_remove_transfer",
      ),
    ).toHaveLength(2);
    expect(
      invoked.some((operation) =>
        JSON.stringify(operation.args).includes(
          "C:/models/refmods/permanent.safetensors",
        ),
      ),
    ).toBe(false);
  });

  it("removes an uploaded RefMod after importing it into the permanent library", async () => {
    const commands = new Map<string, string>();
    const invoked: string[] = [];
    const transport = createFleetMediaTransport("host", async (request) => {
      if (request.kind === "invoke") {
        commands.set(request.id, request.command);
        invoked.push(request.command);
        return { state: "pending" };
      }
      if (request.kind !== "read") return { state: "pending" };
      const command = commands.get(request.id);
      const chunk = encodeJson(
        command === "media_create_transfer"
          ? { path: "C:/transfers/upload.safetensors" }
          : command === "media_write_transfer"
            ? { offset: 1 }
            : { path: "C:/models/refmods/permanent.safetensors" },
      );
      return { state: "complete", chunk, offset: 0, total: chunk.length };
    });
    const path = await transport.upload(
      new Blob([new Uint8Array([0])]),
      "hero.safetensors",
    );
    await expect(
      transport.invoke("media_refmod_operation", {
        request: { operation: "import", path },
      }),
    ).resolves.toEqual({ path: "C:/models/refmods/permanent.safetensors" });
    expect(invoked.at(-1)).toBe("media_remove_transfer");
  });

  it("routes Advanced flow assistant requests through the connected host", async () => {
    const requests: MediaRequest[] = [];
    const value = { message: "Flow updated", flow: null };
    const chunk = encodeJson(value);
    const transport = createFleetMediaTransport("host-a", async (request) => {
      requests.push(request);
      return request.kind === "read"
        ? { state: "complete", chunk, offset: 0, total: chunk.length }
        : { state: "pending" };
    });
    await expect(
      transport.invoke("run_media_flow_agent", {
        workspaceRoot: "C:\\work",
        request: { prompt: "Add an image output" },
      }),
    ).resolves.toEqual(value);
    expect(requests[0]).toMatchObject({
      kind: "invoke",
      command: "run_media_flow_agent",
      args: {
        workspaceRoot: "C:\\work",
        request: { prompt: "Add an image output" },
      },
    });
  });

  it("reassembles bounded Unicode results and releases the operation", async () => {
    const value = {
      name: "模型 🖼️",
      entries: Array.from({ length: 500 }, (_, id) => id),
    };
    const encoded = encodeJson(value);
    const requests: MediaRequest[] = [];
    const transport = createFleetMediaTransport("host-a", async (request) => {
      requests.push(request);
      if (request.kind === "read")
        return {
          state: "complete",
          chunk: encoded.slice(request.offset, request.offset + 80),
          offset: request.offset,
          total: encoded.length,
        };
      return { state: "pending" };
    });
    await expect(
      transport.invoke("media_get_model_catalog", {
        configuredProviderIds: [],
      }),
    ).resolves.toEqual(value);
    expect(requests[0]).toMatchObject({
      kind: "invoke",
      command: "media_get_model_catalog",
      args: { configuredProviderIds: [] },
    });
    expect(requests.at(-1)).toMatchObject({
      kind: "release",
      id: (requests[0] as { id: string }).id,
    });
  });

  it("does not block cancellation while generation is pending", async () => {
    vi.useFakeTimers();
    let generating = true;
    const commands = new Map<string, string>();
    const transport = createFleetMediaTransport("host-a", async (request) => {
      if (request.kind === "invoke") {
        commands.set(request.id, request.command);
        return { state: "pending" };
      }
      if (request.kind === "read") {
        if (commands.get(request.id) === "media_generate_images" && generating)
          return { state: "pending" };
        const chunk = encodeJson({ status: "cancelled" });
        return { state: "complete", chunk, offset: 0, total: chunk.length };
      }
      return { state: "pending" };
    });
    const generation = transport.invoke("media_generate_images", {
      request: { runId: "run-1", seed: undefined },
    });
    await vi.advanceTimersByTimeAsync(1);
    await expect(
      transport.invoke("media_cancel_run", { runId: "run-1" }),
    ).resolves.toEqual({ status: "cancelled" });
    generating = false;
    await vi.advanceTimersByTimeAsync(250);
    await expect(generation).resolves.toEqual({ status: "cancelled" });
  });

  it("preserves native error details and does not repeat a lost submission", async () => {
    const error = {
      code: "MODEL_NOT_INSTALLED",
      message: "Install the selected model.",
    };
    const send = vi.fn(async (request: MediaRequest) =>
      request.kind === "read"
        ? { state: "failed", error }
        : { state: "pending" },
    );
    const transport = createFleetMediaTransport("host-a", send);
    await expect(transport.invoke("media_generate_images", {})).rejects.toEqual(
      error,
    );
    expect(
      send.mock.calls.filter(([request]) => request.kind === "invoke"),
    ).toHaveLength(1);
    const disconnected = createFleetMediaTransport("host-b", async () => {
      throw new Error("Disconnected");
    });
    await expect(
      disconnected.invoke("media_generate_images", {}),
    ).rejects.toThrow("Disconnected");
  });

  it("rejects non-media invocation and converts binary previews", async () => {
    const send = vi.fn(async (request: MediaRequest) => {
      const chunk = encodeJson({ binary: "AAH/" });
      return request.kind === "read"
        ? { state: "complete", chunk, offset: 0, total: chunk.length }
        : { state: "pending" };
    });
    const transport = createFleetMediaTransport("host-a", send);
    await expect(transport.invoke("execute_shell", {})).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
    const bytes = await transport.invoke<ArrayBuffer>(
      "media_read_asset_preview",
      { assetId: "image-1" },
    );
    expect(Array.from(new Uint8Array(bytes))).toEqual([0, 1, 255]);
  });
  it("bounds thumbnail work without delaying cancellation", async () => {
    const waiting: Array<() => void> = [];
    let previews = 0;
    const commands = new Map<string, string>();
    const transport = createFleetMediaTransport("host", async (request) => {
      if (request.kind === "invoke") {
        commands.set(request.id, request.command);
        if (request.command === "media_read_asset_preview") previews++;
        return { state: "pending" };
      }
      if (request.kind === "read") {
        if (commands.get(request.id) === "media_read_asset_preview")
          await new Promise<void>((resolve) => waiting.push(resolve));
        const chunk = encodeJson({ binary: "AAH/" });
        return { state: "complete", chunk, offset: 0, total: chunk.length };
      }
      return { state: "pending" };
    });
    const jobs = Array.from({ length: 10 }, (_, index) =>
      transport.invoke("media_read_asset_preview", { assetId: String(index) }),
    );
    await vi.waitFor(() => expect(waiting).toHaveLength(4));
    expect(previews).toBe(4);
    await expect(
      transport.invoke("media_cancel_run", { runId: "running" }),
    ).resolves.toEqual({ binary: "AAH/" });
    while (previews < 10 || waiting.length) {
      for (const release of waiting.splice(0)) release();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await expect(Promise.all(jobs)).resolves.toHaveLength(10);
  });
});
