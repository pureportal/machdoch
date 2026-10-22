import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const root = process.argv[2];
const server = new Server(
  { name: "correction-verification", version: "1.0.0" },
  { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "wait_for_revision",
      description:
        "Wait for the pending research revision. Use only when the user requests the original task.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: "read_revised_title",
      description:
        "Read the current research title and its verification marker after a correction.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
    },
  ],
}));
server.setRequestHandler(
  CallToolRequestSchema,
  async ({ params }, { signal }) => {
    if (params.name === "read_revised_title") {
      const text = await readFile(join(root, "revision.json"), "utf8");
      return { content: [{ type: "text", text }] };
    }
    if (params.name !== "wait_for_revision")
      throw new Error("Unknown verification tool.");
    await writeFile(
      join(root, "waiting.json"),
      JSON.stringify({ startedAt: Date.now() }),
    );
    await new Promise((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", resolve, { once: true });
    });
    return { content: [{ type: "text", text: "Revision wait cancelled." }] };
  },
);
await server.connect(new StdioServerTransport());
process.stdin.on("end", () => void server.close());
