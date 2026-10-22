import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const uri = "ui://verification/comparison";
const mimeType = "text/html;profile=mcp-app";
const server = new Server(
  { name: "machdoch-live-verification", version: "1.0.0" },
  { capabilities: { tools: {}, resources: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "show_comparison",
      description:
        "Display the requested research title in an interactive comparison.",
      inputSchema: {
        type: "object",
        properties: { title: { type: "string" } },
        required: ["title"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      _meta: { ui: { resourceUri: uri } },
    },
    {
      name: "rename_comparison",
      inputSchema: {
        type: "object",
        properties: { title: { type: "string" } },
        required: ["title"],
        additionalProperties: false,
      },
      _meta: { ui: { visibility: ["app"] } },
    },
  ],
}));
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  if (
    !["show_comparison", "rename_comparison"].includes(params.name) ||
    typeof params.arguments?.title !== "string"
  )
    throw new Error("Invalid verification tool request.");
  const title = params.arguments.title;
  if (params.name === "rename_comparison")
    await writeFile(
      join(process.argv[2], "app-action.json"),
      JSON.stringify({ title }),
    );
  return {
    content: [{ type: "text", text: title }],
    structuredContent: { title },
  };
});
server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [{ uri, name: "Comparison", mimeType }],
}));
server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
  resourceTemplates: [],
}));
server.setRequestHandler(ReadResourceRequestSchema, async () => ({
  contents: [
    {
      uri,
      mimeType,
      text: `<!doctype html><html><body>
<h1 id="title">Loading comparison</h1><button id="rename">Use revised title</button><p role="status" id="status"></p>
<script>
const send=(message)=>parent.postMessage({jsonrpc:"2.0",...message},"*");
addEventListener("message",({data})=>{
 if(data.id===1&&data.result)send({method:"ui/notifications/initialized",params:{}});
 if(data.method==="ui/notifications/tool-result")document.getElementById("title").textContent=data.params.structuredContent.title;
 if(data.id===2){document.getElementById("status").textContent=data.error?data.error.message:"Saved";if(data.result)document.getElementById("title").textContent=data.result.structuredContent.title;}
});
document.getElementById("rename").onclick=()=>send({id:2,method:"tools/call",params:{name:"rename_comparison",arguments:{title:"Northern Lights"}}});
send({id:1,method:"ui/initialize",params:{protocolVersion:"2026-01-26",appInfo:{name:"Verification",version:"1.0.0"},appCapabilities:{}}});
</script></body></html>`,
    },
  ],
}));
await server.connect(new StdioServerTransport());
process.stdin.on("end", () => void server.close());
