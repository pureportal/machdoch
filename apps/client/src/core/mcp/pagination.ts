import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

const MAX_DISCOVERY_PAGES = 100;
const MAX_DISCOVERY_ITEMS = 10_000;
const MAX_DISCOVERY_BYTES = 16 * 1024 * 1024;

export const collectMcpPages = async <T>(
  load: (
    cursor: string | undefined,
  ) => Promise<{ items: T[]; nextCursor?: string }>,
): Promise<T[]> => {
  const items: T[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let bytes = 0;
  for (let page = 0; page < MAX_DISCOVERY_PAGES; page += 1) {
    const result = await load(cursor);
    if (result.items.length > MAX_DISCOVERY_ITEMS - items.length) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        "MCP discovery exceeded 10,000 entries.",
      );
    }
    for (const item of result.items) {
      bytes += Buffer.byteLength(JSON.stringify(item) ?? "null", "utf8");
      if (bytes > MAX_DISCOVERY_BYTES) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          "MCP discovery exceeded 16 MB of metadata.",
        );
      }
      items.push(item);
    }
    cursor = result.nextCursor;
    if (!cursor) return items;
    if (cursors.has(cursor)) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        "MCP discovery returned a repeated pagination cursor.",
      );
    }
    cursors.add(cursor);
  }
  throw new McpError(
    ErrorCode.InvalidRequest,
    "MCP discovery exceeded 100 pages.",
  );
};
