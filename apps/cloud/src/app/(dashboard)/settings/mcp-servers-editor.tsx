"use client";

import { Pencil, Plus, Server, Trash2 } from "lucide-react";
import { useState } from "react";
import { managedMcpServerSecretReferences } from "@machdoch/fleet-protocol/managed-settings";
import { ConfirmButton } from "@/components/confirm-button";
import { Field } from "@/components/field";
import { FormDialog } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  mcpSecretPlaceholderProblem,
  mcpServerProblem,
} from "@/lib/settings-items";
import type {
  ManagedMcpServer,
  ManagedSettingsDocument,
  SettingsCatalog,
  SettingsProfile,
} from "./types";

export function McpServersEditor({
  profile,
  catalog,
  onSave,
}: {
  profile: SettingsProfile;
  catalog: SettingsCatalog;
  onSave: (document: ManagedSettingsDocument, summary: string) => Promise<void>;
}): React.ReactElement {
  const [editing, setEditing] = useState<ManagedMcpServer | "new" | null>(null);
  const servers = profile.document.mcpServers ?? [];
  const secretIds = new Set(profile.secrets.map((secret) => secret.secretId));
  const mcpSecretPattern = new RegExp(catalog.mcpSecretPattern, "u");
  const full = servers.length >= catalog.maximumMcpServers;
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="grid min-w-0 gap-1">
          <h3 className="font-medium">MCP servers</h3>
          <p className="text-sm text-muted-foreground">
            Put credentials in values as{" "}
            <code className="font-mono text-xs">{"{{secret:mcp_name}}"}</code>{" "}
            and set them under Secrets. Devices substitute them locally.
          </p>
          {full ? (
            <p className="text-sm text-muted-foreground">
              This profile has the maximum of {catalog.maximumMcpServers} MCP
              servers. Delete one to add another.
            </p>
          ) : null}
        </div>
        <Button size="sm" disabled={full} onClick={() => setEditing("new")}>
          <Plus />
          Add MCP server
        </Button>
      </div>
      {servers.length ? (
        <div className="grid gap-2">
          {servers.map((server) => {
            const missing = managedMcpServerSecretReferences(server).filter(
              (id) => !secretIds.has(id),
            );
            const name = server.title ?? server.id;
            return (
              <div
                key={server.id}
                className="flex min-w-0 items-center gap-2 rounded-xl border border-border p-3 sm:gap-3"
              >
                <Server className="size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="break-words text-sm font-medium [overflow-wrap:anywhere]">
                    {name}
                  </p>
                  <p className="break-words text-xs text-muted-foreground [overflow-wrap:anywhere]">
                    {server.enabled ? "Enabled" : "Disabled"} ·{" "}
                    {server.transport.type === "stdio"
                      ? server.transport.command
                      : server.transport.url}
                  </p>
                  {missing.length ? (
                    <p className="mt-1 break-words text-xs text-destructive [overflow-wrap:anywhere]">
                      Missing secret{missing.length > 1 ? "s" : ""}:{" "}
                      {missing.join(", ")}. Set{" "}
                      {missing.length > 1 ? "them" : "it"} under Secrets.
                    </p>
                  ) : null}
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Edit ${name}`}
                  onClick={() => setEditing(server)}
                >
                  <Pencil />
                </Button>
                <ConfirmButton
                  trigger={
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Delete ${name}`}
                    >
                      <Trash2 />
                    </Button>
                  }
                  title={`Delete ${name}?`}
                  description="Devices using this profile will stop loading this MCP server."
                  actionLabel="Delete MCP server"
                  onConfirm={() => {
                    const document = structuredClone(profile.document);
                    document.mcpServers = servers.filter(
                      (item) => item.id !== server.id,
                    );
                    return onSave(document, "Deleted MCP server");
                  }}
                />
              </div>
            );
          })}
        </div>
      ) : (
        <p className="py-10 text-center text-sm text-muted-foreground">
          No MCP servers.
        </p>
      )}
      <McpServerDialog
        key={editing === "new" ? "new" : (editing?.id ?? "closed")}
        editing={editing}
        existingIds={servers.map((server) => server.id)}
        secretIds={[...secretIds].filter((id) => mcpSecretPattern.test(id))}
        isStorableSecret={(id) =>
          mcpSecretPattern.test(id) ||
          catalog.secrets.some((secret) => secret.id === id)
        }
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        onSubmit={async (server, previousId) => {
          const document = structuredClone(profile.document);
          const current = [...(document.mcpServers ?? [])];
          const index = current.findIndex((item) => item.id === previousId);
          if (index === -1) current.push(server);
          else current[index] = server;
          document.mcpServers = current;
          await onSave(
            document,
            index === -1 ? "Added MCP server" : "Updated MCP server",
          );
          setEditing(null);
        }}
      />
    </div>
  );
}

function McpServerDialog({
  editing,
  existingIds,
  secretIds,
  isStorableSecret,
  onOpenChange,
  onSubmit,
}: {
  editing: ManagedMcpServer | "new" | null;
  existingIds: string[];
  /** MCP secrets this profile already stores. */
  secretIds: string[];
  isStorableSecret: (secretId: string) => boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (
    server: ManagedMcpServer,
    previousId: string | null,
  ) => Promise<void>;
}): React.ReactElement {
  const server = editing === "new" ? null : editing;
  const [transport, setTransport] = useState<
    ManagedMcpServer["transport"]["type"]
  >(server?.transport.type ?? "stdio");
  const stdio = server?.transport.type === "stdio" ? server.transport : null;
  const remote =
    server && server.transport.type !== "stdio" ? server.transport : null;
  const secretHint = secretIds.length
    ? ` Stored secrets: ${secretIds.join(", ")}.`
    : " Add the secret values under Secrets after saving.";
  return (
    <FormDialog
      open={editing !== null}
      onOpenChange={onOpenChange}
      title={server ? "Edit MCP server" : "New MCP server"}
      submitLabel="Save MCP server"
      onSubmit={async (form) => {
        const id = String(form.get("id")).trim();
        if (id !== server?.id && existingIds.includes(id))
          throw new Error("Another MCP server already uses that id.");
        const next: ManagedMcpServer = {
          id,
          title: String(form.get("title")).trim() || null,
          enabled: form.get("enabled") === "on",
          transport:
            transport === "stdio"
              ? {
                  type: "stdio",
                  command: String(form.get("command")).trim(),
                  args: lines(String(form.get("args"))),
                  env: entries(String(form.get("env")), "=", "environment"),
                }
              : {
                  type: transport,
                  url: String(form.get("url")).trim(),
                  headers: entries(String(form.get("headers")), ":", "header"),
                },
        };
        const problem =
          mcpServerProblem(next) ??
          mcpSecretPlaceholderProblem(next, isStorableSecret);
        if (problem) throw new Error(problem);
        await onSubmit(next, server?.id ?? null);
      }}
    >
      <div className="grid gap-5 md:grid-cols-2">
        <Field
          label="Server id"
          htmlFor="mcp-server-id"
          hint="Lowercase, for example github."
        >
          <Input
            id="mcp-server-id"
            name="id"
            defaultValue={server?.id ?? ""}
            required
            maxLength={64}
          />
        </Field>
        <Field label="Title" htmlFor="mcp-server-title">
          <Input
            id="mcp-server-title"
            name="title"
            defaultValue={server?.title ?? ""}
            maxLength={200}
          />
        </Field>
      </div>
      <Field label="Transport" htmlFor="mcp-server-transport">
        <Select
          id="mcp-server-transport"
          value={transport}
          onChange={(event) =>
            setTransport(
              event.target.value as ManagedMcpServer["transport"]["type"],
            )
          }
        >
          <option value="stdio">Local command (stdio)</option>
          <option value="streamable-http">Streamable HTTP</option>
          <option value="sse">Server-sent events</option>
        </Select>
      </Field>
      {transport === "stdio" ? (
        <>
          <Field label="Command" htmlFor="mcp-server-command">
            <Input
              id="mcp-server-command"
              name="command"
              defaultValue={stdio?.command ?? ""}
              required
              className="font-mono"
            />
          </Field>
          <Field
            label="Arguments"
            htmlFor="mcp-server-args"
            hint="One argument per line."
          >
            <Textarea
              id="mcp-server-args"
              name="args"
              className="min-h-24 font-mono"
              defaultValue={stdio?.args.join("\n") ?? ""}
            />
          </Field>
          <Field
            label="Environment"
            htmlFor="mcp-server-env"
            hint={`One NAME=value per line, for example GITHUB_TOKEN={{secret:mcp_github}}.${secretHint}`}
          >
            <Textarea
              id="mcp-server-env"
              name="env"
              className="min-h-24 font-mono"
              defaultValue={Object.entries(stdio?.env ?? {})
                .map(([key, value]) => `${key}=${value}`)
                .join("\n")}
            />
          </Field>
        </>
      ) : (
        <>
          <Field label="URL" htmlFor="mcp-server-url">
            <Input
              id="mcp-server-url"
              name="url"
              type="url"
              defaultValue={remote?.url ?? ""}
              required
              className="font-mono"
            />
          </Field>
          <Field
            label="Headers"
            htmlFor="mcp-server-headers"
            hint={`One Name: value per line, for example Authorization: Bearer {{secret:mcp_api}}.${secretHint}`}
          >
            <Textarea
              id="mcp-server-headers"
              name="headers"
              className="min-h-24 font-mono"
              defaultValue={Object.entries(remote?.headers ?? {})
                .map(([key, value]) => `${key}: ${value}`)
                .join("\n")}
            />
          </Field>
        </>
      )}
      <label className="flex items-center gap-2 text-sm font-medium">
        <input
          name="enabled"
          type="checkbox"
          defaultChecked={server?.enabled ?? true}
          className="size-4 accent-primary"
        />
        Enabled
      </label>
    </FormDialog>
  );
}

function lines(value: string): string[] {
  return value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
}

function entries(
  value: string,
  separator: string,
  label: "environment" | "header",
): Record<string, string> {
  const result: Record<string, string> = {};
  // Header names are case-insensitive, environment names are not.
  const seen = new Set<string>();
  for (const line of lines(value)) {
    const index = line.indexOf(separator);
    if (index <= 0)
      throw new Error(`Each ${label} line needs a name and a value.`);
    const name = line.slice(0, index).trim();
    const identity = label === "header" ? name.toLowerCase() : name;
    if (seen.has(identity)) throw new Error(`${name} is listed twice.`);
    seen.add(identity);
    result[name] = line.slice(index + 1).trim();
  }
  return result;
}
