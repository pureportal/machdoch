import { createFleetOperationTransport } from "@machdoch/product-ui";
import {
  mediaRequestSchema,
  type MediaRequest,
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

export interface FleetMediaTransport extends MediaPlatform {
  download(path: string): Promise<void>;
}

export function createFleetMediaTransport(
  storageKey: string,
  send: (request: MediaRequest) => Promise<unknown>,
): FleetMediaTransport {
  const transfers = new Map<
    string,
    { id: string; name: string; download: boolean }
  >();
  let activePreviews = 0;
  const previewWaiters: Array<() => void> = [];
  const transport = createFleetOperationTransport((request) =>
    send(mediaRequestSchema.parse(request)),
  );
  const call = async <T>(
    command: string,
    args: Record<string, unknown> = {},
  ): Promise<T> => {
    const value = await transport.invoke<unknown>(command, args);
    if (
      command === "media_read_asset_preview" &&
      value &&
      typeof value === "object" &&
      "binary" in value &&
      typeof value.binary === "string"
    )
      return decode(value.binary).buffer as T;
    return value as T;
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
      direction: "upload",
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
    if (!transfer?.download)
      throw new Error("The download expired. Export the file again.");
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
    download,
    release: removeTransfer,
    fileName: (path) =>
      transfers.get(path)?.name ?? path.split(/[\\/]/u).at(-1)!,
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
      const request = args.request as Record<string, unknown> | undefined;
      let result: T;
      try {
        result = await call<T>(command, args);
      } catch (failure) {
        if (
          command === "media_refmod_operation" &&
          ["save", "create"].includes(String(request?.operation)) &&
          typeof request?.outputPath === "string"
        ) {
          try {
            await removeTransfer(request.outputPath);
          } catch (cleanupFailure) {
            console.error(
              "Could not release the failed RefMod download",
              cleanupFailure,
            );
          }
        }
        throw failure;
      }
      if (
        command === "media_refmod_operation" &&
        request?.operation === "import" &&
        typeof request.path === "string"
      )
        await removeTransfer(request.path);
      if (
        command === "media_refmod_operation" &&
        ["save", "create"].includes(String(request?.operation)) &&
        typeof request?.outputPath === "string"
      )
        await download(request.outputPath);
      if (
        command === "media_refmod_operation" &&
        request?.operation === "create" &&
        Array.isArray(request.sources)
      )
        for (const source of request.sources as Array<{
          path?: string;
          maskPath?: string;
        }>) {
          if (typeof source.path === "string")
            await removeTransfer(source.path);
          if (typeof source.maskPath === "string")
            await removeTransfer(source.maskPath);
        }
      if (
        ["media_export_asset", "media_export_flow_revision"].includes(
          command,
        ) &&
        typeof request?.destinationPath === "string"
      )
        await download(request.destinationPath);
      if (
        [
          "media_import_asset",
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
    listen: transport.listen,
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
      try {
        for (const file of files) paths.push(await upload(file, file.name));
      } catch (failure) {
        await Promise.all(paths.map(removeTransfer));
        throw failure;
      }
      return options?.multiple ? paths : paths[0]!;
    },
    async save(options) {
      const id = crypto.randomUUID();
      const name =
        options?.defaultPath?.split(/[\\/]/u).at(-1) ?? "media-export.json";
      const { path } = await call<{ path: string }>("media_create_transfer", {
        id,
        name,
        direction: "download",
      });
      transfers.set(path, { id, name, download: true });
      return path;
    },
  };
}
