import { z } from "zod";

export const mcpAppMimeType = "text/html;profile=mcp-app";
export const mcpAppProtocolVersion = "2026-01-26";
export const mcpAppToolUiSchema = z.object({
  resourceUri: z.string().max(2048).startsWith("ui://").optional(),
  visibility: z
    .array(z.enum(["model", "app"]))
    .min(1)
    .max(2)
    .optional(),
});
const domain = (allowWebSocket = false) =>
  z
    .string()
    .max(2048)
    .refine((value) => {
      try {
        const url = new URL(value);
        return (
          (url.protocol === "https:" ||
            (allowWebSocket && url.protocol === "wss:")) &&
          url.origin === value &&
          !url.username &&
          !url.password
        );
      } catch {
        return false;
      }
    });
export const mcpAppCspSchema = z.object({
  connectDomains: z.array(domain(true)).max(30).default([]),
  resourceDomains: z.array(domain()).max(30).default([]),
  frameDomains: z.array(domain()).max(10).default([]),
  baseUriDomains: z.array(domain()).max(10).default([]),
});
export const mcpAppRequestSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("settings") }),
  z.strictObject({ action: z.literal("set-enabled"), enabled: z.boolean() }),
  z.strictObject({ action: z.literal("load"), id: z.string().uuid() }),
  z.strictObject({
    action: z.literal("call-tool"),
    id: z.string().uuid(),
    name: z.string().min(1).max(256),
    arguments: z.record(z.string(), z.unknown()),
    confirmed: z.literal(true),
  }),
]);
export type McpAppRequest = z.infer<typeof mcpAppRequestSchema>;
export interface McpAppView {
  id: string;
  title: string;
  html: string;
  csp: z.infer<typeof mcpAppCspSchema>;
  arguments: Record<string, unknown>;
  result: Record<string, unknown>;
}
