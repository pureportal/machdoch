import type { ConversationHistoryEntry } from "../types.js";
import {
  sliceUtf16PrefixAtCodePointBoundary,
  sliceUtf16SuffixAtCodePointBoundary,
} from "@machdoch/fleet-protocol/unicode";

const MAX_PAGE_CONTENT_CHARS = 20_000;

const validateHistoryPosition = (
  history: readonly ConversationHistoryEntry[],
  index: number,
): void => {
  if (index > history.length) {
    throw new Error(`startIndex must be between 0 and ${history.length}.`);
  }
};

export const readChatHistory = (
  history: readonly ConversationHistoryEntry[],
  options: {
    startIndex?: number | undefined;
    limit?: number | undefined;
    offset?: number | undefined;
  },
) => {
  if (options.offset !== undefined && options.startIndex === undefined) {
    throw new Error("Provide startIndex when using offset.");
  }
  const limit = options.limit ?? 10;
  const startIndex = options.startIndex ?? Math.max(0, history.length - limit);
  validateHistoryPosition(history, startIndex);
  let index = startIndex;
  let offset = options.offset ?? 0;
  const firstContent = history[index]?.content ?? "";
  if (offset > firstContent.length) {
    throw new Error(`offset must be between 0 and ${firstContent.length}.`);
  }
  const previous = firstContent.charCodeAt(offset - 1);
  const current = firstContent.charCodeAt(offset);
  if (
    previous >= 0xd800 &&
    previous <= 0xdbff &&
    current >= 0xdc00 &&
    current <= 0xdfff
  ) {
    throw new Error("offset splits a Unicode character. Decrease offset by 1.");
  }
  let remainingChars = MAX_PAGE_CONTENT_CHARS;
  const messages = [];
  while (
    index < history.length &&
    messages.length < limit &&
    remainingChars > 0
  ) {
    const entry = history[index]!;
    const content = sliceUtf16PrefixAtCodePointBoundary(
      entry.content.slice(offset),
      remainingChars,
    );
    if (!content && offset < entry.content.length) break;
    messages.push({
      index,
      role: entry.role,
      ...(entry.createdAt === undefined ? {} : { createdAt: entry.createdAt }),
      content,
      offset,
      contentLength: entry.content.length,
    });
    remainingChars -= content.length;
    offset += content.length;
    if (offset < entry.content.length) break;
    index += 1;
    offset = 0;
  }
  return {
    totalMessages: history.length,
    startIndex,
    messages,
    nextIndex: index < history.length ? index : null,
    nextOffset: offset,
  };
};

export const searchChatHistory = (
  history: readonly ConversationHistoryEntry[],
  options: {
    query: string;
    startIndex?: number | undefined;
    limit?: number | undefined;
  },
) => {
  if (!options.query.trim())
    throw new Error("query must contain text to search for.");
  const startIndex = options.startIndex ?? 0;
  validateHistoryPosition(history, startIndex);
  const pattern = new RegExp(
    options.query.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"),
    "iu",
  );
  const limit = options.limit ?? 20;
  const matches = [];
  let index = startIndex;
  while (index < history.length && matches.length < limit) {
    const entry = history[index]!;
    const match = pattern.exec(entry.content);
    if (match) {
      matches.push({
        index,
        role: entry.role,
        ...(entry.createdAt === undefined
          ? {}
          : { createdAt: entry.createdAt }),
        matchOffset: match.index,
        content: [
          sliceUtf16SuffixAtCodePointBoundary(
            entry.content.slice(0, match.index),
            160,
          ),
          sliceUtf16PrefixAtCodePointBoundary(
            entry.content.slice(match.index),
            460,
          ),
        ].join(""),
      });
    }
    index += 1;
  }
  return {
    totalMessages: history.length,
    matches,
    nextIndex: index < history.length ? index : null,
  };
};
