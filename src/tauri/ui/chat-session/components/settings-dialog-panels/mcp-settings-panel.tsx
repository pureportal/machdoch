import {
  Database,
  ExternalLink,
  KeyRound,
  Plus,
  RefreshCw,
  Save,
  Search,
  Trash2,
} from "lucide-react";
import { useMemo, useState, type JSX } from "react";
import { Button } from "../../../components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../../../components/ui/dialog";
import { Input } from "../../../components/ui/input";
import { Textarea } from "../../../components/ui/textarea";
import { cn } from "../../../lib/utils";
import { MCP_CONFIG_SCOPE_OPTIONS } from "../../../runtime";
import {
  ChoiceButtons,
  SettingPanel,
  SettingsCard,
  SettingsStatus,
} from "./shared";
import type { McpSettingsControls } from "./types";

export interface McpSettingsPanelProps {
  setup: McpSettingsControls;
}

type ServerRecord = Record<string, unknown>;
type TransportType = "stdio" | "streamable-http" | "sse";
type AuthType = "none" | "bearer" | "headers" | "oauth";

interface ParsedMcpDraft {
  config: ServerRecord;
  servers: ServerRecord[];
  error: string | null;
}

const MCP_CONFIG_SCHEMA_VERSION = 1;

const INPUT_CLASS =
  "h-9 rounded-lg border-slate-800 bg-slate-950 font-mono text-sm text-slate-100";
const TEXTAREA_CLASS =
  "min-h-20 rounded-lg border-slate-800 bg-slate-950 font-mono text-sm text-slate-100";
const SELECT_CLASS =
  "h-9 w-full rounded-lg border border-slate-800 bg-slate-950 px-3 text-sm text-slate-100 outline-none transition focus:border-sky-500/40 focus:ring-2 focus:ring-sky-500/15 disabled:cursor-not-allowed disabled:opacity-60";

const isRecord = (value: unknown): value is ServerRecord => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const normalizeServerId = (value: string): string => {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);
};

const getString = (record: ServerRecord | undefined, key: string): string => {
  const value = record?.[key];
  return typeof value === "string" ? value : "";
};

const getBoolean = (
  record: ServerRecord | undefined,
  key: string,
  fallback: boolean,
): boolean => {
  const value = record?.[key];
  return typeof value === "boolean" ? value : fallback;
};

const getRecord = (
  record: ServerRecord | undefined,
  key: string,
): ServerRecord | undefined => {
  const value = record?.[key];
  return isRecord(value) ? value : undefined;
};

const getServerId = (server: ServerRecord, index: number): string => {
  return getString(server, "id") || `server-${index + 1}`;
};

const parseServers = (value: unknown): ServerRecord[] => {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => (isRecord(entry) ? [{ ...entry }] : []));
  }

  if (!isRecord(value)) {
    return [];
  }

  return Object.entries(value).flatMap(([id, entry]) =>
    isRecord(entry) ? [{ id, ...entry }] : [],
  );
};

const parseDraft = (raw: string): ParsedMcpDraft => {
  try {
    const parsed = JSON.parse(raw) as unknown;

    if (!isRecord(parsed)) {
      return {
        config: { schemaVersion: MCP_CONFIG_SCHEMA_VERSION, servers: [] },
        servers: [],
        error: "Config must be an object.",
      };
    }

    return {
      config: parsed,
      servers: parseServers(parsed.servers),
      error: null,
    };
  } catch (error) {
    return {
      config: { schemaVersion: MCP_CONFIG_SCHEMA_VERSION, servers: [] },
      servers: [],
      error: error instanceof Error ? error.message : "Invalid config.",
    };
  }
};

const stringifyDraft = (config: ServerRecord, servers: ServerRecord[]): string => {
  return `${JSON.stringify(
    {
      ...config,
      schemaVersion:
        typeof config.schemaVersion === "number"
          ? config.schemaVersion
          : MCP_CONFIG_SCHEMA_VERSION,
      servers,
    },
    null,
    2,
  )}\n`;
};

const setRecordValue = (
  record: ServerRecord,
  key: string,
  value: unknown,
): ServerRecord => {
  const next = { ...record };

  if (value === undefined || value === "") {
    delete next[key];
  } else {
    next[key] = value;
  }

  return next;
};

const parseStringList = (value: string): string[] | undefined => {
  const entries = value
    .split(/\r?\n|,/u)
    .map((entry) => entry.trim())
    .filter(Boolean);

  return entries.length > 0 ? entries : undefined;
};

const formatStringList = (value: unknown): string => {
  return Array.isArray(value)
    ? value.filter((entry) => typeof entry === "string").join("\n")
    : "";
};

const parseStringRecord = (
  value: string,
): Record<string, string> | undefined => {
  const entries = value
    .split(/\r?\n/u)
    .flatMap((line) => {
      const separatorIndex = line.indexOf("=");

      if (separatorIndex <= 0) {
        return [];
      }

      const key = line.slice(0, separatorIndex).trim();
      const entryValue = line.slice(separatorIndex + 1).trim();

      return key ? [[key, entryValue] as const] : [];
    });

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
};

const formatStringRecord = (value: unknown): string => {
  if (!isRecord(value)) {
    return "";
  }

  return Object.entries(value)
    .flatMap(([key, entry]) => (typeof entry === "string" ? [`${key}=${entry}`] : []))
    .join("\n");
};

const parseOptionalInteger = (value: string): number | undefined => {
  const normalized = value.trim();

  if (!normalized) {
    return undefined;
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : undefined;
};

const getTransportType = (server: ServerRecord | undefined): TransportType => {
  const type = getString(getRecord(server, "transport"), "type");

  return type === "streamable-http" || type === "sse" ? type : "stdio";
};

const createTransport = (type: TransportType): ServerRecord => {
  if (type === "stdio") {
    return { type, command: "" };
  }

  return { type, url: "" };
};

const getAuthType = (server: ServerRecord | undefined): AuthType => {
  const type = getString(getRecord(server, "auth"), "type");

  if (type === "bearer" || type === "headers" || type === "oauth") {
    return type;
  }

  return "none";
};

const createAuth = (type: AuthType): ServerRecord => {
  return { type };
};

const getUniqueServerId = (servers: ServerRecord[], preferredId: string): string => {
  const normalized = normalizeServerId(preferredId) || "mcp-server";
  const used = new Set(
    servers.map((server, index) => normalizeServerId(getServerId(server, index))),
  );

  if (!used.has(normalized)) {
    return normalized;
  }

  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${normalized}-${index}`;

    if (!used.has(candidate)) {
      return candidate;
    }
  }

  return `${normalized}-${Date.now()}`;
};

const Field = ({
  label,
  children,
}: {
  label: string;
  children: JSX.Element;
}): JSX.Element => {
  return (
    <label className="grid gap-1 text-xs font-medium text-slate-400">
      <span>{label}</span>
      {children}
    </label>
  );
};

const CheckboxField = ({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}): JSX.Element => {
  return (
    <label className="flex min-h-9 items-center gap-2 text-sm text-slate-200">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="h-4 w-4 rounded border-slate-700 bg-slate-950 text-sky-400"
      />
      {label}
    </label>
  );
};

export const McpSettingsPanel = ({
  setup,
}: McpSettingsPanelProps): JSX.Element => {
  const [selectedServerId, setSelectedServerId] = useState<string | null>(null);
  const [actionServerIdDraft, setActionServerIdDraft] = useState("");
  const [oauthCallbackDraft, setOauthCallbackDraft] = useState("");
  const parsed = useMemo(() => parseDraft(setup.draft), [setup.draft]);
  const disabled = setup.loading || setup.saving || Boolean(parsed.error);
  const actionDisabled =
    setup.loading ||
    setup.saving ||
    setup.discoveryBusy ||
    setup.oauthBusy ||
    !setup.workspaceAvailable ||
    Boolean(parsed.error);
  const scopeOptions = MCP_CONFIG_SCOPE_OPTIONS.map((option) => ({
    ...option,
    disabled: option.value === "workspace" && !setup.workspaceAvailable,
  }));
  const selectedIndex = parsed.servers.findIndex(
    (server, index) => getServerId(server, index) === selectedServerId,
  );
  const effectiveSelectedIndex =
    selectedIndex >= 0 ? selectedIndex : parsed.servers.length > 0 ? 0 : -1;
  const selectedServer =
    effectiveSelectedIndex >= 0 ? parsed.servers[effectiveSelectedIndex] : undefined;
  const effectiveSelectedServerId = selectedServer
    ? getServerId(selectedServer, effectiveSelectedIndex)
    : "";
  const actionServerId =
    actionServerIdDraft ||
    setup.discoveryServerId ||
    setup.oauthServerId ||
    effectiveSelectedServerId;
  const oauthCallback = oauthCallbackDraft || setup.oauthCallback;

  const writeServers = (servers: ServerRecord[]): void => {
    setup.onDraftChange(stringifyDraft(parsed.config, servers));
  };

  const updateSelectedServer = (
    updater: (server: ServerRecord) => ServerRecord,
  ): void => {
    if (effectiveSelectedIndex < 0) {
      return;
    }

    const servers = parsed.servers.map((server, index) =>
      index === effectiveSelectedIndex ? updater(server) : server,
    );

    writeServers(servers);
  };

  const updateSelectedField = (key: string, value: unknown): void => {
    updateSelectedServer((server) => setRecordValue(server, key, value));
  };

  const updateSelectedRecord = (
    key: string,
    updater: (record: ServerRecord) => ServerRecord,
  ): void => {
    updateSelectedServer((server) => ({
      ...server,
      [key]: updater(getRecord(server, key) ?? {}),
    }));
  };

  const selectServer = (serverId: string): void => {
    setSelectedServerId(serverId);
    setActionServerIdDraft(serverId);
    setup.onDiscoveryServerIdChange(serverId);
    setup.onOAuthServerIdChange(serverId);
  };

  const addCustomServer = (): void => {
    const id = getUniqueServerId(parsed.servers, "mcp-server");
    writeServers([
      ...parsed.servers,
      {
        id,
        title: "MCP Server",
        enabled: true,
        transport: createTransport("stdio"),
        auth: createAuth("none"),
      },
    ]);
    selectServer(id);
  };

  const removeSelectedServer = (): void => {
    if (effectiveSelectedIndex < 0) {
      return;
    }

    const nextServers = parsed.servers.filter(
      (_server, index) => index !== effectiveSelectedIndex,
    );
    const nextSelected = nextServers[effectiveSelectedIndex] ?? nextServers.at(-1);

    writeServers(nextServers);
    setSelectedServerId(
      nextSelected
        ? getServerId(nextSelected, Math.max(0, effectiveSelectedIndex - 1))
        : null,
    );
  };

  const handleActionServerChange = (serverId: string): void => {
    setActionServerIdDraft(serverId);
    setup.onDiscoveryServerIdChange(serverId);
    setup.onOAuthServerIdChange(serverId);
  };

  const addPreset = (presetId: string, serverId: string): void => {
    setup.onPresetInsert(presetId);
    selectServer(serverId);
  };

  const transport = getRecord(selectedServer, "transport");
  const transportType = getTransportType(selectedServer);
  const auth = getRecord(selectedServer, "auth");
  const authType = getAuthType(selectedServer);
  const exposure = getRecord(selectedServer, "exposure");

  return (
    <SettingsCard title="MCP servers">
      <SettingPanel label="Scope" contentClassName="grid gap-2">
        <ChoiceButtons
          value={setup.scope}
          options={scopeOptions}
          disabled={setup.loading || setup.saving}
          onChange={setup.onScopeChange}
        />
        <p className="min-w-0 text-xs leading-5 text-slate-500">
          <span className="break-all font-mono text-slate-400">
            {setup.document.path}
          </span>
        </p>
      </SettingPanel>

      <SettingPanel
        label="Servers"
        className="md:items-start"
        contentClassName="grid gap-3"
      >
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={disabled}
            onClick={addCustomServer}
            className="h-9 rounded-lg border-slate-800 bg-slate-950 px-3 text-sm text-slate-200 hover:border-sky-500/30 hover:bg-slate-900"
          >
            <Plus className="h-4 w-4" />
            Add
          </Button>
          <Dialog>
            <DialogTrigger asChild>
              <Button
                type="button"
                variant="outline"
                disabled={disabled}
                className="h-9 rounded-lg border-slate-800 bg-slate-950 px-3 text-sm text-slate-200 hover:border-sky-500/30 hover:bg-slate-900"
              >
                <Plus className="h-4 w-4" />
                Preset
              </Button>
            </DialogTrigger>
            <DialogContent
              aria-describedby={undefined}
              className="border-slate-800 bg-slate-950 text-slate-100 sm:max-w-xl"
            >
              <DialogHeader>
                <DialogTitle>Add preset</DialogTitle>
              </DialogHeader>
              <div className="grid gap-2 sm:grid-cols-2">
                {setup.presets.map((preset) => (
                  <DialogClose key={preset.id} asChild>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => addPreset(preset.id, preset.serverId)}
                      className="h-10 justify-start rounded-lg border-slate-800 bg-slate-950 px-3 text-left text-sm text-slate-200 shadow-none hover:border-sky-500/30 hover:bg-slate-900"
                    >
                      {preset.title}
                    </Button>
                  </DialogClose>
                ))}
              </div>
            </DialogContent>
          </Dialog>
          <Button
            type="button"
            disabled={setup.loading || setup.saving || Boolean(parsed.error)}
            onClick={() => {
              void setup.onSave();
            }}
            className="h-9 rounded-lg bg-sky-500 px-3 text-sm font-medium text-slate-950 hover:bg-sky-400"
          >
            <Save className="h-4 w-4" />
            {setup.saving ? "Saving" : "Save"}
          </Button>
        </div>

        {parsed.error ? (
          <p className="rounded-lg border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
            {parsed.error}
          </p>
        ) : (
          <div className="grid gap-3 xl:grid-cols-[minmax(12rem,0.85fr)_minmax(0,1.6fr)]">
            <div className="grid max-h-[32rem] content-start gap-2 overflow-auto pr-1">
              {parsed.servers.length === 0 ? (
                <p className="rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-500">
                  No servers
                </p>
              ) : null}
              {parsed.servers.map((server, index) => {
                const serverId = getServerId(server, index);
                const selected = index === effectiveSelectedIndex;

                return (
                  <Button
                    key={`${serverId}-${index}`}
                    type="button"
                    variant="outline"
                    aria-pressed={selected}
                    onClick={() => selectServer(serverId)}
                    className={cn(
                      "h-auto justify-start rounded-lg border-slate-800 bg-slate-950 px-3 py-2 text-left shadow-none hover:border-sky-500/30 hover:bg-slate-900",
                      selected && "border-sky-500/40 bg-sky-500/10",
                    )}
                  >
                    <span className="grid min-w-0 gap-1">
                      <span className="truncate text-sm font-medium text-slate-100">
                        {getString(server, "title") || serverId}
                      </span>
                      <span className="truncate font-mono text-xs text-slate-500">
                        {serverId} · {getTransportType(server)}
                      </span>
                    </span>
                  </Button>
                );
              })}
            </div>

            {selectedServer ? (
              <div className="grid gap-4 rounded-lg border border-slate-800 bg-slate-950 p-3">
                <div className="grid gap-3 md:grid-cols-2">
                  <Field label="ID">
                    <Input
                      value={getString(selectedServer, "id")}
                      disabled={disabled}
                      onChange={(event) => {
                        const id = normalizeServerId(event.target.value);
                        updateSelectedField("id", id);
                        setSelectedServerId(id);
                      }}
                      className={INPUT_CLASS}
                    />
                  </Field>
                  <Field label="Title">
                    <Input
                      value={getString(selectedServer, "title")}
                      disabled={disabled}
                      onChange={(event) =>
                        updateSelectedField("title", event.target.value)
                      }
                      className={INPUT_CLASS}
                    />
                  </Field>
                  <CheckboxField
                    label="Enabled"
                    checked={getBoolean(selectedServer, "enabled", true)}
                    disabled={disabled}
                    onChange={(checked) => updateSelectedField("enabled", checked)}
                  />
                  <Field label="Security">
                    <select
                      value={getString(selectedServer, "securityProfile") || "weak"}
                      disabled={disabled}
                      onChange={(event) =>
                        updateSelectedField("securityProfile", event.target.value)
                      }
                      className={SELECT_CLASS}
                    >
                      <option value="weak">Weak</option>
                      <option value="balanced">Balanced</option>
                      <option value="strict">Strict</option>
                    </select>
                  </Field>
                </div>

                <div className="grid gap-3 md:grid-cols-2">
                  <Field label="Transport">
                    <select
                      value={transportType}
                      disabled={disabled}
                      onChange={(event) =>
                        updateSelectedField(
                          "transport",
                          createTransport(event.target.value as TransportType),
                        )
                      }
                      className={SELECT_CLASS}
                    >
                      <option value="stdio">stdio</option>
                      <option value="streamable-http">streamable-http</option>
                      <option value="sse">sse</option>
                    </select>
                  </Field>
                  {transportType === "stdio" ? (
                    <Field label="Command">
                      <Input
                        value={getString(transport, "command")}
                        disabled={disabled}
                        onChange={(event) =>
                          updateSelectedRecord("transport", (record) =>
                            setRecordValue(record, "command", event.target.value),
                          )
                        }
                        className={INPUT_CLASS}
                      />
                    </Field>
                  ) : (
                    <Field label="URL">
                      <Input
                        value={getString(transport, "url")}
                        disabled={disabled}
                        onChange={(event) =>
                          updateSelectedRecord("transport", (record) =>
                            setRecordValue(record, "url", event.target.value),
                          )
                        }
                        className={INPUT_CLASS}
                      />
                    </Field>
                  )}
                </div>

                {transportType === "stdio" ? (
                  <div className="grid gap-3 md:grid-cols-2">
                    <Field label="Args">
                      <Textarea
                        value={formatStringList(transport?.args)}
                        disabled={disabled}
                        onChange={(event) =>
                          updateSelectedRecord("transport", (record) =>
                            setRecordValue(
                              record,
                              "args",
                              parseStringList(event.target.value),
                            ),
                          )
                        }
                        className={TEXTAREA_CLASS}
                      />
                    </Field>
                    <Field label="Env">
                      <Textarea
                        value={formatStringRecord(transport?.env)}
                        disabled={disabled}
                        onChange={(event) =>
                          updateSelectedRecord("transport", (record) =>
                            setRecordValue(
                              record,
                              "env",
                              parseStringRecord(event.target.value),
                            ),
                          )
                        }
                        className={TEXTAREA_CLASS}
                      />
                    </Field>
                  </div>
                ) : null}

                <div className="grid gap-3 md:grid-cols-2">
                  <Field label="Auth">
                    <select
                      value={authType}
                      disabled={disabled}
                      onChange={(event) =>
                        updateSelectedField(
                          "auth",
                          createAuth(event.target.value as AuthType),
                        )
                      }
                      className={SELECT_CLASS}
                    >
                      <option value="none">none</option>
                      <option value="bearer">bearer</option>
                      <option value="headers">headers</option>
                      <option value="oauth">oauth</option>
                    </select>
                  </Field>
                  <Field label="Exposure">
                    <select
                      value={getString(exposure, "mode") || "hybrid"}
                      disabled={disabled}
                      onChange={(event) =>
                        updateSelectedRecord("exposure", (record) =>
                          setRecordValue(record, "mode", event.target.value),
                        )
                      }
                      className={SELECT_CLASS}
                    >
                      <option value="meta-tools">meta-tools</option>
                      <option value="direct-tools">direct-tools</option>
                      <option value="hybrid">hybrid</option>
                    </select>
                  </Field>
                </div>

                {authType === "bearer" ? (
                  <div className="grid gap-3 md:grid-cols-2">
                    <Field label="Token env">
                      <Input
                        value={getString(auth, "tokenEnv")}
                        disabled={disabled}
                        onChange={(event) =>
                          updateSelectedRecord("auth", (record) =>
                            setRecordValue(record, "tokenEnv", event.target.value),
                          )
                        }
                        className={INPUT_CLASS}
                      />
                    </Field>
                    <Field label="Token">
                      <Input
                        value={getString(auth, "token")}
                        disabled={disabled}
                        onChange={(event) =>
                          updateSelectedRecord("auth", (record) =>
                            setRecordValue(record, "token", event.target.value),
                          )
                        }
                        className={INPUT_CLASS}
                      />
                    </Field>
                  </div>
                ) : null}

                {authType === "headers" ? (
                  <Field label="Headers">
                    <Textarea
                      value={formatStringRecord(auth?.headers)}
                      disabled={disabled}
                      onChange={(event) =>
                        updateSelectedRecord("auth", (record) =>
                          setRecordValue(
                            record,
                            "headers",
                            parseStringRecord(event.target.value),
                          ),
                        )
                      }
                      className={TEXTAREA_CLASS}
                    />
                  </Field>
                ) : null}

                {authType === "oauth" ? (
                  <div className="grid gap-3 md:grid-cols-2">
                    <Field label="Client ID">
                      <Input
                        value={getString(auth, "clientId")}
                        disabled={disabled}
                        onChange={(event) =>
                          updateSelectedRecord("auth", (record) =>
                            setRecordValue(record, "clientId", event.target.value),
                          )
                        }
                        className={INPUT_CLASS}
                      />
                    </Field>
                    <Field label="Redirect URL">
                      <Input
                        value={getString(auth, "redirectUrl")}
                        disabled={disabled}
                        onChange={(event) =>
                          updateSelectedRecord("auth", (record) =>
                            setRecordValue(record, "redirectUrl", event.target.value),
                          )
                        }
                        className={INPUT_CLASS}
                      />
                    </Field>
                    <Field label="Scopes">
                      <Input
                        value={formatStringList(auth?.scopes).replace(/\n/gu, ", ")}
                        disabled={disabled}
                        onChange={(event) =>
                          updateSelectedRecord("auth", (record) =>
                            setRecordValue(
                              record,
                              "scopes",
                              parseStringList(event.target.value),
                            ),
                          )
                        }
                        className={INPUT_CLASS}
                      />
                    </Field>
                    <Field label="Access token env">
                      <Input
                        value={getString(auth, "accessTokenEnv")}
                        disabled={disabled}
                        onChange={(event) =>
                          updateSelectedRecord("auth", (record) =>
                            setRecordValue(
                              record,
                              "accessTokenEnv",
                              event.target.value,
                            ),
                          )
                        }
                        className={INPUT_CLASS}
                      />
                    </Field>
                  </div>
                ) : null}

                <div className="grid gap-3 md:grid-cols-3">
                  <CheckboxField
                    label="Direct tools"
                    checked={getBoolean(exposure, "directTools", true)}
                    disabled={disabled}
                    onChange={(checked) =>
                      updateSelectedRecord("exposure", (record) =>
                        setRecordValue(record, "directTools", checked),
                      )
                    }
                  />
                  <Field label="Timeout ms">
                    <Input
                      type="number"
                      min={0}
                      value={
                        typeof selectedServer.timeoutMs === "number"
                          ? selectedServer.timeoutMs
                          : ""
                      }
                      disabled={disabled}
                      onChange={(event) =>
                        updateSelectedField(
                          "timeoutMs",
                          parseOptionalInteger(event.target.value),
                        )
                      }
                      className={INPUT_CLASS}
                    />
                  </Field>
                  <Field label="Max chars">
                    <Input
                      type="number"
                      min={0}
                      value={
                        typeof selectedServer.maxResponseChars === "number"
                          ? selectedServer.maxResponseChars
                          : ""
                      }
                      disabled={disabled}
                      onChange={(event) =>
                        updateSelectedField(
                          "maxResponseChars",
                          parseOptionalInteger(event.target.value),
                        )
                      }
                      className={INPUT_CLASS}
                    />
                  </Field>
                </div>

                <div className="flex justify-end">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={disabled}
                    onClick={removeSelectedServer}
                    className="h-9 rounded-lg border-rose-500/20 bg-rose-500/10 px-3 text-sm text-rose-200 hover:bg-rose-500/15"
                  >
                    <Trash2 className="h-4 w-4" />
                    Remove
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        )}
      </SettingPanel>

      <SettingPanel
        label="Actions"
        className="md:items-start"
        contentClassName="grid gap-3"
      >
        <div className="grid gap-3">
          <div className="grid gap-3 md:grid-cols-2">
            <Input
              aria-label="MCP action server id"
              value={actionServerId}
              placeholder="server id"
              disabled={actionDisabled}
              onChange={(event) => handleActionServerChange(event.target.value)}
              className={INPUT_CLASS}
            />
            <Input
              aria-label="MCP OAuth callback URL or code"
              value={oauthCallback}
              placeholder="callback URL or code"
              disabled={actionDisabled}
              onChange={(event) => {
                setOauthCallbackDraft(event.target.value);
                setup.onOAuthCallbackChange(event.target.value);
              }}
              className={INPUT_CLASS}
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={actionDisabled}
              onClick={() => {
                void setup.onDiscoverServer(actionServerId);
              }}
              className="h-9 rounded-lg border-slate-800 bg-slate-950 px-3 text-sm text-slate-200 hover:border-sky-500/30 hover:bg-slate-900"
            >
              <Search className="h-4 w-4" />
              Discover
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={actionDisabled}
              onClick={() => {
                void setup.onRefreshDiscoveryCache(actionServerId);
              }}
              className="h-9 rounded-lg border-slate-800 bg-slate-950 px-3 text-sm text-slate-200 hover:border-sky-500/30 hover:bg-slate-900"
            >
              <RefreshCw className="h-4 w-4" />
              Refresh
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={actionDisabled}
              onClick={() => {
                void setup.onListDiscoveryCache();
              }}
              className="h-9 rounded-lg border-slate-800 bg-slate-950 px-3 text-sm text-slate-200 hover:border-sky-500/30 hover:bg-slate-900"
            >
              <Database className="h-4 w-4" />
              Cache
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={actionDisabled}
              onClick={() => {
                void setup.onStartOAuth(actionServerId);
              }}
              className="h-9 rounded-lg border-slate-800 bg-slate-950 px-3 text-sm text-slate-200 hover:border-sky-500/30 hover:bg-slate-900"
            >
              <ExternalLink className="h-4 w-4" />
              OAuth
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={actionDisabled}
              onClick={() => {
                void setup.onFinishOAuth(actionServerId, oauthCallback);
              }}
              className="h-9 rounded-lg border-slate-800 bg-slate-950 px-3 text-sm text-slate-200 hover:border-sky-500/30 hover:bg-slate-900"
            >
              <KeyRound className="h-4 w-4" />
              Finish
            </Button>
          </div>
        </div>

        {setup.discoveryOutput ? (
          <pre className="max-h-80 overflow-auto rounded-lg border border-slate-800 bg-slate-950 p-3 text-xs leading-5 text-slate-200">
            {setup.discoveryOutput}
          </pre>
        ) : null}
        <SettingsStatus message={setup.message} />
      </SettingPanel>
    </SettingsCard>
  );
};
