import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { bearerToken } from "../../request-auth";
import { isCloudError } from "../access";
import { readBody } from "../request-body";
import type { CloudRuntime } from "../runtime";
import { cloudMcpTools } from "./tools";

export async function handleCloudMcp(
  runtime: CloudRuntime,
  request: Request,
): Promise<Response> {
  if (
    request.headers.has("origin") &&
    request.headers.get("origin") !== runtime.origin
  )
    return Response.json({ error: "Origin is not allowed." }, { status: 403 });
  const credentials = await runtime.oauthTokens.authenticate(
    bearerToken(request) ?? "",
  );
  if (!credentials)
    return Response.json(
      { error: "Connect this app to machdoch.cloud." },
      {
        status: 401,
        headers: {
          "WWW-Authenticate": `Bearer resource_metadata="${runtime.origin}/.well-known/oauth-protected-resource", scope="cloud:read"`,
        },
      },
    );
  if (request.method !== "POST")
    return new Response(null, { status: 405, headers: { Allow: "POST" } });
  const parsedBody = await readBody(request, z.unknown());
  const tools = cloudMcpTools(runtime).filter((tool) =>
    credentials.scopes.includes(tool.scope),
  );
  const server = new Server(
    { name: "machdoch.cloud", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((tool) => tool.definition),
  }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const tool = tools.find((entry) => entry.definition.name === params.name);
    if (!tool)
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: "Tool is unavailable for this connection.",
          },
        ],
      };
    try {
      const actor = {
        ...credentials.actor,
        delegation: { ...credentials.actor.delegation!, scope: tool.scope },
      };
      const result = await tool.call(actor, params.arguments ?? {});
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    } catch (error) {
      if (isCloudError(error))
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ code: error.code, error: error.message }),
            },
          ],
        };
      if (error instanceof z.ZodError)
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                code: "invalid_input",
                issues: error.issues,
              }),
            },
          ],
        };
      console.error(
        "Cloud MCP tool failed",
        error instanceof Error ? error.name : "Unknown error",
      );
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: "Request failed. Retry with the same commandId and arguments.",
          },
        ],
      };
    }
  });
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
  });
  try {
    await server.connect(transport);
    return await transport.handleRequest(request, { parsedBody });
  } finally {
    await server.close();
  }
}
