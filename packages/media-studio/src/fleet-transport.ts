import {
  mediaRequestSchema,
  mediaResponseSchema,
  type MediaRequest,
  type MediaResponse,
} from "@machdoch/fleet-protocol";
import type { MediaPlatform } from "./tauri/ui/media/media-platform";

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
const decode = (value: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
const encode = (bytes: Uint8Array): string => {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value);
};

export function createFleetMediaTransport(
  storageKey: string,
  send: (request: MediaRequest) => Promise<unknown>,
): MediaPlatform {
  const listeners = new Map<
    string,
    Set<(event: { payload: unknown }) => void>
  >();
  const transfers = new Map<
    string,
    { id: string; name: string; download: boolean }
  >();
  let cursor = 0;
  let eventTimer: ReturnType<typeof setTimeout> | undefined;
  let polling = false;
  let activePreviews = 0;
  const previewWaiters: Array<() => void> = [];
  const exchange = async (request: MediaRequest): Promise<MediaResponse> =>
    mediaResponseSchema.parse(await send(mediaRequestSchema.parse(request)));

  const call = async <T>(
    command: string,
    args: Record<string, unknown> = {},
  ): Promise<T> => {
    const request = mediaRequestSchema.parse({
      kind: "invoke",
      id: crypto.randomUUID(),
      command,
      args: JSON.parse(JSON.stringify(args)),
    });
    if (request.kind !== "invoke") throw new Error("Invalid media request.");
    const started = await exchange(request);
    if (started.state === "failed") throw started.error;
    let content = "";
    let complete = false;
    try {
      for (;;) {
        const response = await exchange({
          kind: "read",
          id: request.id,
          offset: content.length,
        });
        if (response.state === "failed") {
          complete = true;
          throw response.error;
        }
        if (response.state === "pending") {
          await delay(250);
          continue;
        }
        if (
          response.state !== "complete" ||
          response.offset !== content.length ||
          response.total > 64 * 1024 * 1024
        )
          throw new Error("Invalid media response.");
        content += response.chunk;
        if (content.length > response.total)
          throw new Error("Invalid media response size.");
        if (content.length === response.total) {
          complete = true;
          break;
        }
        if (!response.chunk.length)
          throw new Error("Incomplete media response.");
      }
      const value: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(decode(content)),
      );
      if (
        command === "media_read_asset_preview" &&
        value &&
        typeof value === "object" &&
        "binary" in value &&
        typeof value.binary === "string"
      )
        return decode(value.binary).buffer as T;
      return value as T;
    } finally {
      if (complete) {
        try {
          await exchange({ kind: "release", id: request.id });
        } catch (error) {
          console.error("Could not release completed media operation", error);
        }
      }
    }
  };

  const pollEvents = async (): Promise<void> => {
    if (polling || !listeners.size) return;
    polling = true;
    try {
      const response = await exchange({ kind: "events", after: cursor });
      if (response.state !== "events")
        throw new Error("Media progress is unavailable.");
      cursor = response.cursor;
      for (const event of response.events)
        for (const listener of listeners.get(event.name) ?? [])
          listener({ payload: event.payload });
    } catch (error) {
      console.error("Could not refresh media progress", error);
    } finally {
      polling = false;
      if (listeners.size) eventTimer = setTimeout(() => void pollEvents(), 750);
    }
  };

  const removeTransfer = async (path: string): Promise<void> => {
    const transfer = transfers.get(path);
    if (!transfer) return;
    await call("media_remove_transfer", { id: transfer.id });
    transfers.delete(path);
  };

  const upload = async (blob: Blob, name: string): Promise<string> => {
    if (blob.size > 32 * 1024 * 1024 * 1024)
      throw new Error("Files must be smaller than 32 GB.");
    const id = crypto.randomUUID();
    const { path } = await call<{ path: string }>("media_create_transfer", {
      id,
      name,
    });
    transfers.set(path, { id, name, download: false });
    try {
      for (let offset = 0; offset < blob.size; offset += 393_216) {
        const bytes = new Uint8Array(
          await blob.slice(offset, offset + 393_216).arrayBuffer(),
        );
        const result = await call<{ offset: number }>("media_write_transfer", {
          id,
          offset,
          data: encode(bytes),
        });
        if (result.offset !== offset + bytes.length)
          throw new Error(
            "File upload was interrupted. Select the file again.",
          );
      }
      return path;
    } catch (error) {
      await removeTransfer(path);
      throw error;
    }
  };

  const download = async (path: string): Promise<void> => {
    const transfer = transfers.get(path);
    if (!transfer?.download) return;
    try {
      const parts: Uint8Array<ArrayBuffer>[] = [];
      let offset = 0;
      for (;;) {
        await delay(750);
        const chunk = await call<{ data: string; total: number }>(
          "media_read_transfer",
          { id: transfer.id, offset },
        );
        const bytes = decode(chunk.data);
        parts.push(bytes);
        offset += bytes.length;
        if (offset === chunk.total) break;
        if (!bytes.length || offset > chunk.total)
          throw new Error("File download was interrupted.");
      }
      const url = URL.createObjectURL(new Blob(parts));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = transfer.name;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } finally {
      await removeTransfer(path);
    }
  };

  return {
    storageKey,
    upload,
    async invoke<T>(
      command: string,
      args: Record<string, unknown> = {},
    ): Promise<T> {
      if (command === "media_read_asset_preview") {
        if (activePreviews >= 4)
          await new Promise<void>((resolve) => previewWaiters.push(resolve));
        else activePreviews++;
        try {
          return await call<T>(command, args);
        } finally {
          const next = previewWaiters.shift();
          if (next) next();
          else activePreviews--;
        }
      }
      const result = await call<T>(command, args);
      const request = args.request as Record<string, unknown> | undefined;
      if (
        ["media_export_asset", "media_export_flow_revision"].includes(
          command,
        ) &&
        typeof request?.destinationPath === "string"
      )
        await download(request.destinationPath);
      if (
        [
          "media_import_image",
          "media_import_local_model",
          "media_import_model_addon",
          "media_import_flow",
        ].includes(command)
      ) {
        const path = args.path ?? request?.sourcePath;
        if (typeof path === "string") await removeTransfer(path);
      }
      return result;
    },
    async listen<T>(
      name: string,
      handler: (event: { payload: T }) => void,
    ): Promise<() => void> {
      if (
        !["media-import-progress", "media-civitai-download-progress"].includes(
          name,
        )
      )
        throw new Error("Unsupported media event.");
      const listener = handler as (event: { payload: unknown }) => void;
      const subscriptions = listeners.get(name) ?? new Set();
      subscriptions.add(listener);
      listeners.set(name, subscriptions);
      clearTimeout(eventTimer);
      void pollEvents();
      return () => {
        subscriptions.delete(listener);
        if (!subscriptions.size) listeners.delete(name);
        if (!listeners.size) clearTimeout(eventTimer);
      };
    },
    async open(options) {
      if (options?.directory)
        throw new Error("Enter a folder path on the connected host.");
      const files = await new Promise<File[]>((resolve) => {
        const input = document.createElement("input");
        input.type = "file";
        input.multiple = options?.multiple === true;
        input.accept =
          options?.filters
            ?.flatMap((filter) =>
              filter.extensions.map((extension) => `.${extension}`),
            )
            .join(",") ?? "";
        input.addEventListener(
          "change",
          () => resolve(Array.from(input.files ?? [])),
          { once: true },
        );
        input.addEventListener("cancel", () => resolve([]), { once: true });
        input.click();
      });
      if (!files.length) return null;
      const paths: string[] = [];
      for (const file of files) paths.push(await upload(file, file.name));
      return options?.multiple ? paths : paths[0]!;
    },
    async save(options) {
      const id = crypto.randomUUID();
      const name =
        options?.defaultPath?.split(/[\\/]/u).at(-1) ?? "media-export.json";
      const { path } = await call<{ path: string }>("media_create_transfer", {
        id,
        name,
      });
      transfers.set(path, { id, name, download: true });
      return path;
    },
  };
}
