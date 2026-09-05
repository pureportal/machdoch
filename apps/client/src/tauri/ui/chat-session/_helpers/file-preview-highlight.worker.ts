import { highlightFilePreviewContent } from "./file-preview-highlight";
import type { FilePreviewLanguage } from "./file-preview-language";

globalThis.onmessage = (
  event: MessageEvent<{ content: string; language: FilePreviewLanguage }>,
) => {
  const { content, language } = event.data;
  globalThis.postMessage({
    value: highlightFilePreviewContent(content, language),
  });
};
globalThis.postMessage({ ready: true });
