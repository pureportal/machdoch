import { listen } from "@tauri-apps/api/event";
import {
  getCurrentWindow,
  type DragDropEvent as TauriDragDropEvent,
} from "@tauri-apps/api/window";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FileDropTarget } from "./session-context-attachments";

const TEXT_URI_LIST_TYPE = "text/uri-list";
const TEXT_PLAIN_TYPE = "text/plain";
const MOZ_URL_TYPE = "text/x-moz-url";
const URL_DROP_PROTOCOLS = new Set(["http:", "https:", "mailto:", "ftp:"]);

export interface SessionDropPayload {
  paths?: string[];
  references?: string[];
  text?: string;
}

interface BrowserSessionDropPayload extends SessionDropPayload {
  imageFiles?: File[];
}

const normalizeStringList = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(
    new Set(
      value
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    ),
  );
};

const normalizeSessionDropPayload = (
  value: unknown,
): SessionDropPayload | null => {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  const paths = normalizeStringList(record.paths);
  const references = normalizeStringList(record.references);
  const text = typeof record.text === "string" ? record.text.trim() : "";

  if (paths.length === 0 && references.length === 0 && !text) {
    return null;
  }

  return {
    ...(paths.length > 0 ? { paths } : {}),
    ...(references.length > 0 ? { references } : {}),
    ...(text ? { text } : {}),
  };
};

const getDataTransferTypes = (dataTransfer: DataTransfer): string[] => {
  return Array.from(dataTransfer.types).map((type) => type.toLowerCase());
};

const isSupportedUrl = (value: string): boolean => {
  try {
    return URL_DROP_PROTOCOLS.has(new URL(value).protocol);
  } catch {
    return false;
  }
};

const getPathFromFileUrl = (value: string): string | null => {
  try {
    const url = new URL(value);

    if (url.protocol !== "file:") {
      return null;
    }

    const decodedPath = decodeURIComponent(url.pathname);

    if (url.hostname) {
      return `//${url.hostname}${decodedPath}`;
    }

    return decodedPath.replace(/^\/([a-zA-Z]:\/)/u, "$1");
  } catch {
    return null;
  }
};

const parseUriList = (value: string): string[] => {
  return value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
};

const getTransferData = (
  dataTransfer: DataTransfer,
  type: string,
): string => {
  try {
    return dataTransfer.getData(type).trim();
  } catch {
    return "";
  }
};

const splitDroppedUriValues = (
  values: string[],
): { paths: string[]; references: string[] } => {
  const paths: string[] = [];
  const references: string[] = [];

  for (const value of values) {
    const path = getPathFromFileUrl(value);

    if (path) {
      paths.push(path);
      continue;
    }

    if (isSupportedUrl(value)) {
      references.push(value);
    }
  }

  return {
    paths: normalizeStringList(paths),
    references: normalizeStringList(references),
  };
};

const getDroppedText = (
  dataTransfer: DataTransfer,
  references: string[],
): string | undefined => {
  const text = getTransferData(dataTransfer, TEXT_PLAIN_TYPE);

  if (!text || isSupportedUrl(text)) {
    return undefined;
  }

  const startsWithDroppedReference = references.some(
    (reference) => text === reference || text.startsWith(`${reference}\n`),
  );

  return startsWithDroppedReference ? undefined : text;
};

const createBrowserSessionDropPayload = (
  dataTransfer: DataTransfer,
): BrowserSessionDropPayload | null => {
  const uriValues = parseUriList(getTransferData(dataTransfer, TEXT_URI_LIST_TYPE));
  const mozUrl = getTransferData(dataTransfer, MOZ_URL_TYPE)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  const plainText = getTransferData(dataTransfer, TEXT_PLAIN_TYPE);
  const { paths, references } = splitDroppedUriValues([
    ...uriValues,
    ...(mozUrl ? [mozUrl] : []),
    ...(plainText && isSupportedUrl(plainText) ? [plainText] : []),
  ]);
  const text = getDroppedText(dataTransfer, references);
  const imageFiles =
    paths.length > 0
      ? []
      : Array.from(dataTransfer.files).filter((file) =>
          file.type.startsWith("image/"),
        );

  if (
    paths.length === 0 &&
    references.length === 0 &&
    !text &&
    imageFiles.length === 0
  ) {
    return null;
  }

  return {
    ...(paths.length > 0 ? { paths } : {}),
    ...(references.length > 0 ? { references } : {}),
    ...(text ? { text } : {}),
    ...(imageFiles.length > 0 ? { imageFiles } : {}),
  };
};

const hasSupportedBrowserDropData = (dataTransfer: DataTransfer): boolean => {
  const types = getDataTransferTypes(dataTransfer);

  return (
    dataTransfer.files.length > 0 ||
    types.includes("files") ||
    types.includes(TEXT_URI_LIST_TYPE) ||
    types.includes(TEXT_PLAIN_TYPE) ||
    types.includes(MOZ_URL_TYPE)
  );
};

export const useSessionFileDrops = (options: {
  fileDropTarget?: FileDropTarget;
  isDesktop: boolean;
  onAttachPaths: (paths: string[], target: FileDropTarget) => Promise<void>;
  onAttachReferences?: (
    references: string[],
    target: FileDropTarget,
  ) => void | Promise<void>;
  onAppendText?: (text: string, target: FileDropTarget) => void | Promise<void>;
  onAttachImageFiles?: (
    files: File[],
    target: FileDropTarget,
  ) => Promise<void>;
  forwardedDropEventName?: string;
}): { isActive: boolean } => {
  const [isNativeDropActive, setIsNativeDropActive] = useState(false);
  const [isBrowserDropActive, setIsBrowserDropActive] = useState(false);
  const browserDragDepthRef = useRef(0);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const attachDropPayload = useCallback(
    async (
      payload: BrowserSessionDropPayload | SessionDropPayload,
      target: FileDropTarget,
    ): Promise<void> => {
      const handlers = optionsRef.current;
      const operations: Promise<unknown>[] = [];

      if (payload.paths?.length) {
        operations.push(Promise.resolve(handlers.onAttachPaths(payload.paths, target)));
      }

      if (payload.references?.length) {
        operations.push(
          Promise.resolve(handlers.onAttachReferences?.(payload.references, target)),
        );
      }

      if (payload.text) {
        operations.push(Promise.resolve(handlers.onAppendText?.(payload.text, target)));
      }

      if ("imageFiles" in payload && payload.imageFiles?.length) {
        operations.push(
          Promise.resolve(handlers.onAttachImageFiles?.(payload.imageFiles, target)),
        );
      }

      await Promise.all(operations);
    },
    [],
  );

  useEffect(() => {
    const fileDropTarget = options.fileDropTarget;

    if (!fileDropTarget || !options.isDesktop) {
      setIsNativeDropActive(false);
      return;
    }

    let disposed = false;
    let unsubscribe: (() => void) | undefined;

    void getCurrentWindow()
      .onDragDropEvent((event: { payload: TauriDragDropEvent }) => {
        const payload = event.payload;

        if (payload.type === "enter" || payload.type === "over") {
          setIsNativeDropActive(true);
          return;
        }

        if (payload.type === "leave") {
          setIsNativeDropActive(false);
          return;
        }

        setIsNativeDropActive(false);
        void attachDropPayload({ paths: payload.paths }, fileDropTarget).catch(
          (error) => {
            console.error("Failed to attach dropped files", error);
          },
        );
      })
      .then((unlisten) => {
        if (disposed) {
          unlisten();
          return;
        }

        unsubscribe = unlisten;
      })
      .catch((error) => {
        console.error("Failed to subscribe to dropped files", error);
      });

    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [
    attachDropPayload,
    options.fileDropTarget,
    options.isDesktop,
  ]);

  useEffect(() => {
    const fileDropTarget = options.fileDropTarget;
    const eventName = options.forwardedDropEventName;

    if (!fileDropTarget || !eventName || !options.isDesktop) {
      return;
    }

    let disposed = false;
    let unsubscribe: (() => void) | undefined;

    void listen<unknown>(eventName, (event) => {
      const payload = normalizeSessionDropPayload(event.payload);

      if (!payload) {
        return;
      }

      void attachDropPayload(payload, fileDropTarget).catch((error) => {
        console.error("Failed to attach forwarded dropped content", error);
      });
    })
      .then((unlisten) => {
        if (disposed) {
          unlisten();
          return;
        }

        unsubscribe = unlisten;
      })
      .catch((error) => {
        console.error("Failed to subscribe to forwarded dropped content", error);
      });

    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [
    attachDropPayload,
    options.fileDropTarget,
    options.forwardedDropEventName,
    options.isDesktop,
  ]);

  useEffect(() => {
    const fileDropTarget = options.fileDropTarget;

    if (!fileDropTarget) {
      setIsBrowserDropActive(false);
      browserDragDepthRef.current = 0;
      return;
    }

    const activateBrowserDrop = (event: DragEvent): boolean => {
      const dataTransfer = event.dataTransfer;

      if (!dataTransfer || !hasSupportedBrowserDropData(dataTransfer)) {
        return false;
      }

      event.preventDefault();
      dataTransfer.dropEffect = "copy";
      setIsBrowserDropActive(true);
      return true;
    };

    const handleDragEnter = (event: DragEvent): void => {
      if (!activateBrowserDrop(event)) {
        return;
      }

      browserDragDepthRef.current += 1;
    };

    const handleDragOver = (event: DragEvent): void => {
      activateBrowserDrop(event);
    };

    const handleDragLeave = (): void => {
      if (browserDragDepthRef.current === 0) {
        return;
      }

      browserDragDepthRef.current = Math.max(0, browserDragDepthRef.current - 1);

      if (browserDragDepthRef.current === 0) {
        setIsBrowserDropActive(false);
      }
    };

    const handleDrop = (event: DragEvent): void => {
      const dataTransfer = event.dataTransfer;

      browserDragDepthRef.current = 0;
      setIsBrowserDropActive(false);

      if (!dataTransfer || !hasSupportedBrowserDropData(dataTransfer)) {
        return;
      }

      event.preventDefault();
      const payload = createBrowserSessionDropPayload(dataTransfer);

      if (!payload) {
        return;
      }

      void attachDropPayload(payload, fileDropTarget).catch((error) => {
        console.error("Failed to attach dropped content", error);
      });
    };

    window.addEventListener("dragenter", handleDragEnter);
    window.addEventListener("dragover", handleDragOver);
    window.addEventListener("dragleave", handleDragLeave);
    window.addEventListener("drop", handleDrop);

    return () => {
      window.removeEventListener("dragenter", handleDragEnter);
      window.removeEventListener("dragover", handleDragOver);
      window.removeEventListener("dragleave", handleDragLeave);
      window.removeEventListener("drop", handleDrop);
      browserDragDepthRef.current = 0;
      setIsBrowserDropActive(false);
    };
  }, [
    attachDropPayload,
    options.fileDropTarget,
  ]);

  return { isActive: isNativeDropActive || isBrowserDropActive };
};
