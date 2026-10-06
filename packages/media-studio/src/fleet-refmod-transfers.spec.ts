import { afterEach, expect, it, vi } from "vitest";
import { createFleetMediaTransport } from "./fleet-transport";
import type { MediaRequest } from "@machdoch/fleet-protocol";

afterEach(() => vi.restoreAllMocks());

function createHost(cleanupFails = false) {
  const invoked: Array<Extract<MediaRequest, { kind: "invoke" }>> = [];
  const operations = new Map<
    string,
    Extract<MediaRequest, { kind: "invoke" }>
  >();
  const failure = {
    code: "MODEL_NOT_INSTALLED",
    message: "Install the MiniMax H3 video VAE",
  };
  const transport = createFleetMediaTransport(
    "refmod-host",
    async (request) => {
      if (request.kind === "invoke") {
        invoked.push(request);
        operations.set(request.id, request);
        return { state: "pending" };
      }
      if (request.kind === "release")
        return { state: "complete", chunk: "", offset: 0, total: 0 };
      if (request.kind !== "read") return { state: "pending" };
      const operation = operations.get(request.id)!;
      if (operation.command === "media_refmod_operation")
        return { state: "failed", error: failure };
      if (operation.command === "media_remove_transfer" && cleanupFails)
        return { state: "failed", error: "Host disconnected during cleanup" };
      const value =
        operation.command === "media_create_transfer"
          ? { path: `C:/transfers/${operation.args.id}-${operation.args.name}` }
          : operation.command === "media_write_transfer"
            ? { offset: 1 }
            : null;
      const chunk = btoa(JSON.stringify(value));
      return { state: "complete", chunk, offset: 0, total: chunk.length };
    },
  );
  return { transport, invoked, failure };
}

it.each(["create", "save"])(
  "releases a failed RefMod %s destination while retaining its source for retry",
  async (operation) => {
    const { transport, invoked, failure } = createHost();
    const source = await transport.upload(
      new Blob([new Uint8Array([0])]),
      "source.png",
    );
    const outputPath = await transport.save({
      defaultPath: "reference.safetensors",
    });
    expect(transport.fileName(source)).toBe("source.png");
    expect(transport.fileName(outputPath!)).toBe("reference.safetensors");
    await expect(
      transport.invoke("media_refmod_operation", {
        workspaceRoot: "C:/work",
        request: { operation, sources: [{ path: source }], outputPath },
      }),
    ).rejects.toEqual(failure);
    const allocations = invoked.filter(
      (value) => value.command === "media_create_transfer",
    );
    const releases = invoked.filter(
      (value) => value.command === "media_remove_transfer",
    );
    expect(releases.map((value) => value.args.id)).toEqual([
      allocations[1]!.args.id,
    ]);
    await transport.release(source);
    expect(
      invoked
        .filter((value) => value.command === "media_remove_transfer")
        .map((value) => value.args.id),
    ).toEqual([allocations[1]!.args.id, allocations[0]!.args.id]);
  },
);

it("preserves the actionable creation error and reports a cleanup failure", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const { transport, failure } = createHost(true);
  const outputPath = await transport.save({
    defaultPath: "reference.safetensors",
  });
  await expect(
    transport.invoke("media_refmod_operation", {
      request: { operation: "create", outputPath },
    }),
  ).rejects.toEqual(failure);
  expect(log).toHaveBeenCalledWith(
    "Could not release the failed RefMod download",
    expect.any(Error),
  );
});
