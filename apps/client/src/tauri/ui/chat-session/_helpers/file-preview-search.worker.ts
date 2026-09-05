import { findFilePreviewMatches } from "./file-preview-search";

globalThis.onmessage = (
  event: MessageEvent<{ content: string; query: string; isRegex: boolean }>,
) => {
  const { content, query, isRegex } = event.data;
  globalThis.postMessage({
    value: findFilePreviewMatches(content, query, isRegex),
  });
};
globalThis.postMessage({ ready: true });
