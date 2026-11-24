import { z } from "zod";
import { cloudId } from "./cloud-contract";

export const maximumMcpConnectors = 8;

export const mcpConnectorInputSchema = z.strictObject({
  name: z
    .string()
    .trim()
    .regex(
      /^[a-z0-9][a-z0-9-]{0,23}$/u,
      "Use up to 24 lowercase letters, digits or hyphens.",
    ),
  url: z
    .url()
    .max(500)
    .refine((value) => {
      const url = new URL(value);
      return (
        url.protocol === "https:" && !url.username && !url.password && !url.hash
      );
    }, "Use an https URL without credentials."),
  token: z.string().trim().min(1).max(4_000).nullable(),
});
export type McpConnectorInput = z.infer<typeof mcpConnectorInputSchema>;

export const allowedRepositoriesSchema = z.strictObject({
  repositoryIds: z.array(cloudId).max(500),
});

export type AgentMcpConnector = {
  id: string;
  name: string;
  url: string;
  authenticated: boolean;
  createdAt: string;
};

export interface AgentPersonalization {
  connectors: AgentMcpConnector[];
  repositoryIds: string[];
}

export interface AgentModelPreference {
  providerId: string;
  model: string;
}

export function defaultAgentModel(
  providers: { id: string; models: string[] }[],
  preferred: AgentModelPreference | null | undefined,
): AgentModelPreference | null {
  if (
    preferred &&
    providers.some(
      (provider) =>
        provider.id === preferred.providerId &&
        provider.models.includes(preferred.model),
    )
  )
    return preferred;
  const provider = providers.find((entry) => entry.models.length);
  return provider
    ? { providerId: provider.id, model: provider.models[0]! }
    : null;
}

export function connectorToolName(
  connector: string,
  tool: string,
): string | null {
  const name = `mcp_${connector.replaceAll("-", "_")}_${tool.replace(/[^A-Za-z0-9_-]/gu, "_")}`;
  return name.length <= 64 ? name : null;
}
