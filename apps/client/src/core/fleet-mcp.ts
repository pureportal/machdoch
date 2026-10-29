import {
  managedMcpServerSchema,
  type FleetManagedMcpServer,
} from "@machdoch/fleet-protocol";
import {
  managedMcpServerSecretReferences,
  substituteManagedSecrets,
} from "@machdoch/fleet-protocol/managed-settings";
import type { McpServerConfig } from "./mcp/types.js";

const slug = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "_")
    .replace(/^[_-]+|[_-]+$/gu, "");

/** Builds the profile secret id that replaces one MCP value in uploads. */
export const fleetMcpSecretId = (serverId: string, name: string): string =>
  `mcp_${`${slug(serverId)}_${slug(name)}`.replace(/^_+/u, "").slice(0, 60) || "value"}`;

const placeholder = (serverId: string, name: string): string =>
  `{{secret:${fleetMcpSecretId(serverId, name)}}}`;

const environmentName = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const headerName = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/u;
const sensitiveName =
  /key|token|secret|passw|pwd|credential|auth|bearer|cookie|header|session/iu;
const credentialPrefix =
  /^(?:gh[oprsu]_|github_pat_|glpat-|sk-|xox[abeoprs]-|AKIA|ASIA|AIza|ya29\.|eyJ)/u;

const entropyBits = (value: string): number => {
  const counts = new Map<string, number>();
  for (const character of value)
    counts.set(character, (counts.get(character) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const share = count / value.length;
    bits -= share * Math.log2(share);
  }
  return bits;
};

/**
 * Known token formats, or long random-looking values that are neither paths,
 * hosts nor package names.
 */
const looksLikeCredential = (value: string): boolean =>
  (value.length >= 16 && credentialPrefix.test(value)) ||
  (value.length >= 32 &&
    !/[\s/\\:@.]/u.test(value) &&
    /[A-Za-z]/u.test(value) &&
    /\d/u.test(value) &&
    entropyBits(value) >= 3.5);

/** Userinfo and query values become placeholders; fragments are dropped. */
const sanitizeUrl = (serverId: string, value: string): string | null => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!url.host) return null;
  const userinfo =
    url.username || url.password
      ? `${placeholder(serverId, "username")}${url.password ? `:${placeholder(serverId, "password")}` : ""}@`
      : "";
  const names = [...new Set(url.searchParams.keys())];
  const query = names.length
    ? `?${names.map((name) => `${encodeURIComponent(name)}=${placeholder(serverId, name)}`).join("&")}`
    : "";
  return `${url.protocol}//${userinfo}${url.host}${url.pathname}${query}`;
};

/**
 * Replaces argument values that commonly carry credentials: URL userinfo and
 * query values, values of options such as `--api-key` (also as
 * `--api-key=value`), `NAME=value` pairs with a sensitive name, and values that
 * look like tokens.
 */
const sanitizeArgs = (serverId: string, args: string[]): string[] =>
  args.map((arg, index) => {
    const positional = `arg_${index + 1}`;
    if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(arg))
      return sanitizeUrl(serverId, arg) ?? placeholder(serverId, positional);
    const assignment = /^([^=\s]+)=(.+)$/su.exec(arg);
    if (assignment) {
      const [, name = "", value = ""] = assignment;
      if (sensitiveName.test(name) || looksLikeCredential(value))
        return `${name}=${placeholder(serverId, name.replace(/^-+/u, ""))}`;
      const [, nested = "", nestedValue = ""] =
        /^([A-Za-z_][A-Za-z0-9_]*)=(.+)$/su.exec(value) ?? [];
      if (
        nested &&
        (sensitiveName.test(nested) || looksLikeCredential(nestedValue))
      )
        return `${name}=${nested}=${placeholder(serverId, nested)}`;
    }
    if (looksLikeCredential(arg)) return placeholder(serverId, positional);
    const option = /^-{1,2}([^-=\s][^=\s]*)$/u.exec(args[index - 1] ?? "")?.[1];
    return option && !arg.startsWith("-") && sensitiveName.test(option)
      ? placeholder(serverId, option)
      : arg;
  });

/**
 * Converts a local MCP server into the shape machdoch.cloud stores. Values that
 * may hold credentials (environment variables, headers, bearer tokens, URL
 * userinfo and query values, sensitive arguments) become `{{secret:…}}`
 * placeholders; OAuth state, URL fragments and the working directory are dropped.
 */
export function sanitizeMcpServerForFleet(
  server: Pick<
    McpServerConfig,
    "id" | "title" | "enabled" | "transport" | "auth"
  >,
): FleetManagedMcpServer | null {
  const id = server.id
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^[^a-z0-9]+/u, "")
    .slice(0, 64);
  if (!id) return null;
  const title = server.title?.trim().slice(0, 200) || null;
  const enabled = server.enabled ?? true;
  const { transport } = server;
  let candidate: FleetManagedMcpServer;
  if (transport.type === "stdio") {
    candidate = {
      id,
      title,
      enabled,
      transport: {
        type: "stdio",
        command: transport.command,
        args: sanitizeArgs(id, transport.args ?? []),
        env: Object.fromEntries(
          Object.keys(transport.env ?? {})
            .filter((name) => environmentName.test(name))
            .slice(0, 64)
            .map((name) => [name, placeholder(id, name)]),
        ),
      },
    };
  } else {
    const url = sanitizeUrl(id, transport.url);
    if (!url) return null;
    const headers: Record<string, string> = {};
    for (const name of Object.keys(transport.headers ?? {})) {
      if (headerName.test(name)) headers[name] = placeholder(id, name);
    }
    if (
      server.auth?.type === "bearer" &&
      (server.auth.token || server.auth.tokenEnv)
    ) {
      const name = server.auth.headerName ?? "Authorization";
      if (headerName.test(name))
        headers[name] = `Bearer ${placeholder(id, name)}`;
    } else if (server.auth?.type === "headers") {
      for (const name of [
        ...Object.keys(server.auth.headers ?? {}),
        ...Object.keys(server.auth.envHeaders ?? {}),
      ]) {
        if (headerName.test(name)) headers[name] = placeholder(id, name);
      }
    }
    candidate = {
      id,
      title,
      enabled,
      transport: {
        type: transport.type,
        url,
        headers: Object.fromEntries(Object.entries(headers).slice(0, 64)),
      },
    };
  }
  const parsed = managedMcpServerSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/**
 * Maps a delivered MCP server onto the local configuration. Placeholders are
 * resolved from the delivered secrets; a server missing any secret stays
 * disabled so it never starts with a literal placeholder.
 */
export function managedMcpServerConfig(
  server: FleetManagedMcpServer,
  secrets: Record<string, string>,
): { server: McpServerConfig; missingSecrets: string[] } {
  const missing = new Set<string>();
  const resolve = (value: string): string => {
    const result = substituteManagedSecrets(value, secrets);
    result.missing.forEach((id) => missing.add(id));
    return result.value;
  };
  const resolveEntries = (entries: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(entries).map(([name, value]) => [name, resolve(value)]),
    );
  const transport: McpServerConfig["transport"] =
    server.transport.type === "stdio"
      ? {
          type: "stdio",
          command: resolve(server.transport.command),
          args: server.transport.args.map(resolve),
          env: resolveEntries(server.transport.env),
        }
      : {
          type: server.transport.type,
          url: resolve(server.transport.url),
          headers: resolveEntries(server.transport.headers),
        };
  const missingSecrets = [...missing].sort();
  return {
    server: {
      id: server.id,
      ...(server.title ? { title: server.title } : {}),
      enabled: server.enabled && missingSecrets.length === 0,
      transport,
    },
    missingSecrets,
  };
}

/** One warning per enabled delivered MCP server that lacks a profile secret. */
export function managedMcpServerWarnings(profile: {
  document: { mcpServers?: FleetManagedMcpServer[] | undefined };
  secrets: Record<string, string>;
}): string[] {
  return (profile.document.mcpServers ?? []).flatMap((server) => {
    const missing = managedMcpServerSecretReferences(server).filter(
      (secretId) => profile.secrets[secretId] === undefined,
    );
    return server.enabled && missing.length
      ? [
          `MCP server "${server.title ?? server.id}" stays off until machdoch.cloud provides ${missing.length === 1 ? "the secret" : "the secrets"} ${missing.join(", ")}.`,
        ]
      : [];
  });
}
