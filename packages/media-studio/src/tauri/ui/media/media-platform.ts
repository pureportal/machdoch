import { invoke as nativeInvoke, isTauri } from "@tauri-apps/api/core";
import { listen as nativeListen } from "@tauri-apps/api/event";
import {
  open as nativeOpen,
  save as nativeSave,
} from "@tauri-apps/plugin-dialog";
import { openUrl as nativeOpenUrl } from "@tauri-apps/plugin-opener";

export interface MediaPlatform {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  listen<T>(
    name: string,
    handler: (event: { payload: T }) => void,
  ): Promise<() => void>;
  open: (
    options?: Parameters<typeof nativeOpen>[0],
  ) => Promise<string | string[] | null>;
  save: typeof nativeSave;
  upload: (blob: Blob, name: string) => Promise<string>;
  storageKey: string;
}

let remotePlatform: MediaPlatform | null = null;

export function configureRemoteMediaPlatform(platform: MediaPlatform): void {
  if (remotePlatform) throw new Error("A media host is already connected.");
  remotePlatform = platform;
}

export const isRemoteMedia = (): boolean => remotePlatform !== null;
export const hasMediaHost = (): boolean => isRemoteMedia() || isTauri();
export const invoke = <T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> =>
  remotePlatform
    ? remotePlatform.invoke<T>(command, args)
    : nativeInvoke<T>(command, args);
export const listen = <T>(
  name: string,
  handler: (event: { payload: T }) => void,
): Promise<() => void> =>
  remotePlatform
    ? remotePlatform.listen(name, handler)
    : nativeListen<T>(name, handler);
export const open: MediaPlatform["open"] = (options) =>
  remotePlatform ? remotePlatform.open(options) : nativeOpen(options);
export const save: typeof nativeSave = (options) =>
  remotePlatform ? remotePlatform.save(options) : nativeSave(options);
export const mediaStorageKey = (key: string): string =>
  remotePlatform ? `${remotePlatform.storageKey}:${key}` : key;
export const openUrl = async (url: string): Promise<void> => {
  if (!remotePlatform) return nativeOpenUrl(url);
  const parsed = new URL(url);
  if (!["https:", "http:"].includes(parsed.protocol))
    throw new Error("Invalid link.");
  window.open(parsed.href, "_blank", "noopener,noreferrer");
};

export const saveClipboardImageAttachment = async (input: {
  blob: Blob;
  fileName?: string;
  mediaType?: string;
}): Promise<string> => {
  if (remotePlatform)
    return remotePlatform.upload(input.blob, input.fileName ?? "clipboard.png");
  const bytes = new Uint8Array(await input.blob.arrayBuffer());
  let encoded = "";
  for (const byte of bytes) encoded += String.fromCharCode(byte);
  return nativeInvoke("save_clipboard_image_attachment", {
    request: {
      dataBase64: btoa(encoded),
      mediaType: input.mediaType ?? input.blob.type,
      fileName: input.fileName,
    },
  });
};

export const subscribeToUserSettingsChanged = async (
  handler: (kind: string) => void,
): Promise<() => void> => {
  if (remotePlatform || !isTauri()) return () => undefined;
  return nativeListen<{ kind: string }>(
    "machdoch://user-settings-changed",
    ({ payload }) => handler(payload.kind),
  );
};
