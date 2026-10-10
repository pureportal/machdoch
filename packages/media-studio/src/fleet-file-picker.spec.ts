// @vitest-environment jsdom

import { File as NodeFile } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFleetMediaTransport } from "./fleet-transport";

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("Fleet file picker", () => {
  it("mounts the input before opening and removes it when cancelled", async () => {
    const send = vi.fn();
    vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(
      function (this: HTMLInputElement) {
        expect(this.isConnected).toBe(true);
        this.dispatchEvent(new Event("cancel"));
      },
    );
    const transport = createFleetMediaTransport("host", send);
    await expect(transport.open()).resolves.toBeNull();
    expect(document.querySelector("input")).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it("removes the picker before uploading selected files and releases imported transfers", async () => {
    const files = [
      new NodeFile(["photo"], "phone.png"),
      new NodeFile(["other"], "other.jpg"),
    ];
    vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(
      function (this: HTMLInputElement) {
        expect(this.isConnected).toBe(true);
        expect(this.multiple).toBe(true);
        expect(this.accept).toBe(".png,.jpg");
        Object.defineProperty(this, "files", { value: files });
        this.dispatchEvent(new Event("change"));
      },
    );
    const operations = new Map<string, string>();
    const removed: string[] = [];
    const transport = createFleetMediaTransport("host", async (request) => {
      expect(document.querySelector("input")).toBeNull();
      if (request.kind === "invoke") {
        let result: unknown = null;
        if (request.command === "media_create_transfer")
          result = { path: `/transfers/${request.args.id}` };
        if (request.command === "media_write_transfer")
          result = {
            offset:
              Number(request.args.offset) +
              atob(String(request.args.data)).length,
          };
        if (request.command === "media_remove_transfer")
          removed.push(String(request.args.id));
        operations.set(request.id, btoa(JSON.stringify(result)));
        return { state: "pending" };
      }
      if (request.kind === "read") {
        const chunk = operations.get(request.id)!;
        return { state: "complete", chunk, offset: 0, total: chunk.length };
      }
      return { state: "pending" };
    });
    const paths = await transport.open({
      multiple: true,
      filters: [{ name: "Images", extensions: ["png", "jpg"] }],
    });
    expect(Array.isArray(paths)).toBe(true);
    for (const path of paths as string[]) {
      await transport.invoke("media_import_asset", { path });
    }
    expect(removed).toHaveLength(2);
  });

  it("removes the input and reports an error if the picker cannot open", async () => {
    vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {
      throw new Error("Picker unavailable");
    });
    const transport = createFleetMediaTransport("host", vi.fn());
    await expect(transport.open()).rejects.toThrow("Picker unavailable");
    expect(document.querySelector("input")).toBeNull();
  });
});
