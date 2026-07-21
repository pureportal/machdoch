import {
  AlertTriangle,
  Database,
  ExternalLink,
  KeyRound,
  Plus,
  RefreshCw,
  Save,
  Search,
  Server,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState, type JSX, type ReactNode } from "react";
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
import {
  doctorProviderSync,
  getProviderSyncStatus,
  MCP_CONFIG_SCOPE_OPTIONS,
  planProviderSync,
  refreshProviderSync,
  setProviderSyncEnabled,
  type ProviderSyncStatus,
} from "../../../runtime";
import {
  ChoiceButtons,
  SettingsCard,
  SettingsStatus,
} from "./shared";
import { useSettingsNavigationGuard } from "./navigation-guard";
import type { McpSettingsControls } from "./types";

export interface McpSettingsPanelProps {
  setup: McpSettingsControls;
}

type ServerRecord = Record<string, unknown>;
type TransportType = "stdio" | "streamable-http" | "sse";
type AuthType = "none" | "bearer" | "headers" | "oauth";
type ServerTab = "setup" | "auth" | "capabilities" | "advanced";
type IssueTone = "error" | "warning";
type McpPresetOption = McpSettingsControls["presets"][number];
type McpPresetCategoryId =
  | "web-search"
  | "docs-knowledge"
  | "planning-design"
  | "code-ci"
  | "data-observability"
  | "browser-apps"
  | "more";

interface ParsedMcpDraft {
  config: ServerRecord;
  servers: ServerRecord[];
  error: string | null;
}

interface ValidationIssue {
  serverKey: string;
  tone: IssueTone;
  text: string;
}

interface DiscoverySummary {
  serverId: string | null;
  transportType: string | null;
  protocolVersion: string | null;
  cachePath: string | null;
  discoveredAt: string | null;
  tools: number | null;
  resources: number | null;
  resourceTemplates: number | null;
  prompts: number | null;
}

interface CustomServerDraft {
  id: string;
  title: string;
  transportType: TransportType;
  command: string;
  url: string;
}

interface McpPresetCategory {
  id: McpPresetCategoryId;
  label: string;
}

const MCP_CONFIG_SCHEMA_VERSION = 1;

const SERVER_TABS: ReadonlyArray<{ value: ServerTab; label: string }> = [
  { value: "setup", label: "Setup" },
  { value: "auth", label: "Auth" },
  { value: "capabilities", label: "Capabilities" },
  { value: "advanced", label: "Advanced" },
];

const MCP_PRESET_CATEGORIES: readonly McpPresetCategory[] = [
  { id: "web-search", label: "Web & Search" },
  { id: "docs-knowledge", label: "Docs & Knowledge" },
  { id: "planning-design", label: "Planning & Design" },
  { id: "code-ci", label: "Code & CI" },
  { id: "data-observability", label: "Data & Observability" },
  { id: "browser-apps", label: "Browser & Apps" },
  { id: "more", label: "More" },
];

const MCP_PRESET_CATEGORY_BY_ID: Partial<Record<string, McpPresetCategoryId>> = {
  "serper-search": "web-search",
  "firecrawl-web": "web-search",
  "context7-docs": "docs-knowledge",
  "notion-remote": "docs-knowledge",
  "linear-remote": "planning-design",
  "figma-remote": "planning-design",
  "github-remote": "code-ci",
  "github-local-docker": "code-ci",
  "gitlab-remote": "code-ci",
  "sentry-remote": "data-observability",
  "supabase-remote": "data-observability",
  "chrome-devtools": "browser-apps",
  "playwright-browser": "browser-apps",
  "tauri-mcp-server": "browser-apps",
};

const getMcpPresetCategoryId = (presetId: string): McpPresetCategoryId => {
  return MCP_PRESET_CATEGORY_BY_ID[presetId] ?? "more";
};

const createEmptyCustomServerDraft = (
  servers: ServerRecord[],
): CustomServerDraft => {
  const id = getUniqueServerId(servers, "mcp-server");

  return {
    id,
    title: "MCP Server",
    transportType: "stdio",
    command: "",
    url: "",
  };
};

const INPUT_CLASS =
  "h-9 rounded-lg border-slate-800 bg-slate-950 font-mono text-sm text-slate-100 placeholder:text-slate-600";
const TEXTAREA_CLASS =
  "min-h-20 rounded-lg border-slate-800 bg-slate-950 font-mono text-sm text-slate-100 placeholder:text-slate-600";
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

const getServerKey = (server: ServerRecord, index: number): string => {
  return `${getServerId(server, index)}:${index}`;
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

const parseRootsInput = (value: string): string[] | string | undefined => {
  const normalized = value.trim();

  if (!normalized) {
    return undefined;
  }

  if (normalized === "workspace" || normalized === "disabled") {
    return normalized;
  }

  return parseStringList(value);
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

const formatOptionalNumber = (value: unknown): string | number => {
  return typeof value === "number" ? value : "";
};

const getTransportType = (server: ServerRecord | undefined): TransportType => {
  const type = getString(getRecord(server, "transport"), "type");

  return type === "streamable-http" || type === "sse" ? type : "stdio";
};

const createTransport = (
  type: TransportType,
  current: ServerRecord | undefined = {},
): ServerRecord => {
  if (type === "stdio") {
    return {
      ...current,
      type,
      command: getString(current, "command"),
    };
  }

  return {
    ...current,
    type,
    url: getString(current, "url"),
  };
};

const getAuthType = (server: ServerRecord | undefined): AuthType => {
  const type = getString(getRecord(server, "auth"), "type");

  if (type === "bearer" || type === "headers" || type === "oauth") {
    return type;
  }

  return "none";
};

const createAuth = (
  type: AuthType,
  current: ServerRecord | undefined = {},
): ServerRecord => {
  return { ...current, type };
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

const isValidHttpUrl = (value: string): boolean => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
};

const validateServers = (servers: ServerRecord[]): ValidationIssue[] => {
  const idCounts = new Map<string, number>();

  for (const [index, server] of servers.entries()) {
    const id = normalizeServerId(getServerId(server, index));
    idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
  }

  return servers.flatMap((server, index) => {
    const issues: ValidationIssue[] = [];
    const serverId = getServerId(server, index);
    const normalizedId = normalizeServerId(serverId);
    const serverKey = getServerKey(server, index);
    const transport = getRecord(server, "transport");
    const transportType = getTransportType(server);

    if (!normalizedId) {
      issues.push({
        serverKey,
        tone: "error",
        text: "Server ID is required.",
      });
    } else if ((idCounts.get(normalizedId) ?? 0) > 1) {
      issues.push({
        serverKey,
        tone: "error",
        text: `Server ID "${normalizedId}" is used more than once.`,
      });
    }

    if (transportType === "stdio") {
      if (!getString(transport, "command").trim()) {
        issues.push({
          serverKey,
          tone: "error",
          text: "Stdio transport requires a command.",
        });
      }
    } else {
      const url = getString(transport, "url").trim();

      if (!url) {
        issues.push({
          serverKey,
          tone: "error",
          text: "Remote transport requires a URL.",
        });
      } else if (!isValidHttpUrl(url)) {
        issues.push({
          serverKey,
          tone: "error",
          text: "Remote transport URL must use HTTP or HTTPS.",
        });
      }
    }

    if (getAuthType(server) === "bearer") {
      const auth = getRecord(server, "auth");

      if (!getString(auth, "token").trim() && !getString(auth, "tokenEnv").trim()) {
        issues.push({
          serverKey,
          tone: "warning",
          text: "Bearer auth should use a token env var or token.",
        });
      }
    }

    return issues;
  });
};

const parseDiscoverySummary = (raw: string | null): DiscoverySummary | null => {
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    const result = isRecord(parsed) ? parsed : undefined;
    const discovery = isRecord(result?.discovery) ? result.discovery : undefined;

    if (!result && !discovery) {
      return null;
    }

    return {
      serverId: getString(discovery, "serverId") || null,
      transportType: getString(discovery, "transportType") || null,
      protocolVersion: getString(discovery, "protocolVersion") || null,
      cachePath: getString(result, "cachePath") || null,
      discoveredAt: getString(discovery, "discoveredAt") || null,
      tools: Array.isArray(discovery?.tools) ? discovery.tools.length : null,
      resources: Array.isArray(discovery?.resources) ? discovery.resources.length : null,
      resourceTemplates: Array.isArray(discovery?.resourceTemplates)
        ? discovery.resourceTemplates.length
        : null,
      prompts: Array.isArray(discovery?.prompts) ? discovery.prompts.length : null,
    };
  } catch {
    return null;
  }
};

const Field = ({
  label,
  detail,
  children,
}: {
  label: string;
  detail?: string;
  children: JSX.Element;
}): JSX.Element => {
  return (
    <label className="grid gap-1.5 text-xs font-medium text-slate-400">
      <span className="text-slate-300">{label}</span>
      {children}
      {detail ? (
        <span aria-hidden="true" className="text-xs leading-5 text-slate-500">
          {detail}
        </span>
      ) : null}
    </label>
  );
};

const CheckboxField = ({
  label,
  detail,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  detail?: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}): JSX.Element => {
  return (
    <label className="flex min-h-9 items-start gap-2 text-sm text-slate-200">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-1 h-4 w-4 rounded border-slate-700 bg-slate-950 text-sky-400 accent-sky-400"
      />
      <span className="grid gap-1">
        <span>{label}</span>
        {detail ? (
          <span aria-hidden="true" className="text-xs leading-5 text-slate-500">
            {detail}
          </span>
        ) : null}
      </span>
    </label>
  );
};

const PanelBlock = ({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}): JSX.Element => {
  return (
    <section className="grid gap-3 border-t border-slate-800/75 pt-4 first:border-t-0 first:pt-0">
      <div className="grid gap-1">
        <h4 className="text-sm font-semibold text-slate-100">{title}</h4>
        {description ? (
          <p className="text-xs leading-5 text-slate-500">{description}</p>
        ) : null}
      </div>
      {children}
    </section>
  );
};

const IssueList = ({
  issues,
}: {
  issues: ValidationIssue[];
}): JSX.Element | null => {
  if (issues.length === 0) {
    return null;
  }

  return (
    <div className="grid gap-2 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-sm text-amber-100">
      {issues.map((issue) => (
        <div key={`${issue.serverKey}-${issue.text}`} className="flex gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{issue.text}</span>
        </div>
      ))}
    </div>
  );
};

const SummaryMetric = ({
  label,
  value,
}: {
  label: string;
  value: number | string | null;
}): JSX.Element => {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950 px-3 py-2">
      <p className="text-xs text-slate-500">{label}</p>
      <p className="mt-1 text-sm font-semibold text-slate-100">{value ?? "Unknown"}</p>
    </div>
  );
};

export const McpSettingsPanel = ({
  setup,
}: McpSettingsPanelProps): JSX.Element => {
  const [selectedServerId, setSelectedServerId] = useState<string | null>(null);
  const [selectedTab, setSelectedTab] = useState<ServerTab>("setup");
  const [oauthCallbackDraft, setOauthCallbackDraft] = useState("");
  const [customDialogOpen, setCustomDialogOpen] = useState(false);
  const [providerSyncStatus, setProviderSyncStatus] =
    useState<ProviderSyncStatus | null>(null);
  const [providerSyncBusy, setProviderSyncBusy] = useState(false);
  const [providerSyncMessage, setProviderSyncMessage] = useState<string | null>(null);
  const [customDraft, setCustomDraft] = useState<CustomServerDraft>(() =>
    createEmptyCustomServerDraft([]),
  );
  const parsed = useMemo(() => parseDraft(setup.draft), [setup.draft]);
  const validationIssues = useMemo(
    () => (parsed.error ? [] : validateServers(parsed.servers)),
    [parsed.error, parsed.servers],
  );
  const validationErrors = validationIssues.filter((issue) => issue.tone === "error");
  const dirty = setup.draft !== setup.document.raw;
  const disabled = setup.loading || setup.saving || Boolean(parsed.error);
  const saveDisabled = disabled || !dirty || validationErrors.length > 0;
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
  const selectedServerKey = selectedServer
    ? getServerKey(selectedServer, effectiveSelectedIndex)
    : "";
  const selectedIssues = validationIssues.filter(
    (issue) => issue.serverKey === selectedServerKey,
  );
  const selectedHasErrors = selectedIssues.some((issue) => issue.tone === "error");
  const transport = getRecord(selectedServer, "transport");
  const transportType = getTransportType(selectedServer);
  const auth = getRecord(selectedServer, "auth");
  const authType = getAuthType(selectedServer);
  const exposure = getRecord(selectedServer, "exposure");
  const discoverySummary = useMemo(
    () => parseDiscoverySummary(setup.discoveryOutput),
    [setup.discoveryOutput],
  );
  useSettingsNavigationGuard({
    dirty: dirty || setup.saving,
    title: setup.saving
      ? "Saving MCP server changes"
      : "Discard MCP server changes?",
    description: setup.saving
      ? "Wait for the MCP configuration save to finish before leaving."
      : "The MCP configuration contains changes that have not been saved.",
    canDiscard: !setup.saving,
    onDiscard: () => {
      setup.onDraftChange(setup.document.raw);
    },
  });
  const oauthCallback = oauthCallbackDraft || setup.oauthCallback;
  const normalizedCustomId = normalizeServerId(customDraft.id);
  const customIdAlreadyExists = parsed.servers.some((server, index) => {
    return normalizeServerId(getServerId(server, index)) === normalizedCustomId;
  });
  const customTransportReady =
    customDraft.transportType === "stdio"
      ? customDraft.command.trim().length > 0
      : isValidHttpUrl(customDraft.url.trim());
  const customDraftReady =
    normalizedCustomId.length > 0 && !customIdAlreadyExists && customTransportReady;
  const presetGroups = useMemo(
    () =>
      MCP_PRESET_CATEGORIES.flatMap((category) => {
        const presets = setup.presets.filter(
          (preset) => getMcpPresetCategoryId(preset.id) === category.id,
        );

        return presets.length > 0 ? [{ ...category, presets }] : [];
      }),
    [setup.presets],
  );

  useEffect(() => {
    let active = true;
    void refreshProviderSync(setup.workspaceRoot)
      .then((status) => {
        if (active) setProviderSyncStatus(status);
      })
      .catch((error: unknown) => {
        if (active) {
          setProviderSyncMessage(
            error instanceof Error ? error.message : String(error),
          );
        }
      });
    return () => {
      active = false;
    };
  }, [setup.workspaceRoot]);

  const runProviderSyncAction = async (
    action: "enable" | "disable" | "refresh" | "plan" | "doctor",
  ): Promise<void> => {
    setProviderSyncBusy(true);
    setProviderSyncMessage(null);
    try {
      if (action === "plan") {
        const plan = await planProviderSync(setup.workspaceRoot);
        const providers = Array.isArray(plan.providers) ? plan.providers.length : 0;
        setProviderSyncMessage(`Plan is current for ${providers} provider surface${providers === 1 ? "" : "s"}.`);
      } else if (action === "doctor") {
        const doctor = await doctorProviderSync(setup.workspaceRoot);
        setProviderSyncMessage(
          doctor.healthy === true
            ? "Provider enrollment doctor reports complete coverage."
            : "Provider enrollment doctor found degraded or pending coverage.",
        );
      } else {
        const status =
          action === "refresh"
            ? await refreshProviderSync(setup.workspaceRoot)
            : await setProviderSyncEnabled(
                setup.workspaceRoot,
                action === "enable",
              );
        setProviderSyncStatus(status);
        setProviderSyncMessage(
          action === "refresh"
            ? "Provider projections reconciled."
            : `Provider sync ${action === "enable" ? "enabled" : "disabled"}.`,
        );
      }
      setProviderSyncStatus(await getProviderSyncStatus(setup.workspaceRoot));
    } catch (error) {
      setProviderSyncMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setProviderSyncBusy(false);
    }
  };

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
    setup.onDiscoveryServerIdChange(serverId);
    setup.onOAuthServerIdChange(serverId);
  };

  const openCustomServerDialog = (): void => {
    setCustomDraft(createEmptyCustomServerDraft(parsed.servers));
    setCustomDialogOpen(true);
  };

  const addCustomServer = (): void => {
    if (!customDraftReady) {
      return;
    }

    const id = normalizedCustomId;
    const transport =
      customDraft.transportType === "stdio"
        ? {
            type: "stdio" as const,
            command: customDraft.command.trim(),
          }
        : {
            type: customDraft.transportType,
            url: customDraft.url.trim(),
          };

    writeServers([
      ...parsed.servers,
      {
        id,
        title: customDraft.title.trim() || id,
        enabled: true,
        transport,
        auth: createAuth("none"),
        exposure: {
          mode: "hybrid",
          directTools: true,
        },
      },
    ]);
    selectServer(id);
    setSelectedTab("setup");
    setCustomDialogOpen(false);
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

  const addPreset = (presetId: string, serverId: string): void => {
    setup.onPresetInsert(presetId);
    selectServer(serverId);
    setSelectedTab("setup");
  };

  const renderCustomServerDialog = (): JSX.Element => {
    return (
      <Dialog open={customDialogOpen} onOpenChange={setCustomDialogOpen}>
        <DialogTrigger asChild>
          <Button
            type="button"
            variant="outline"
            disabled={disabled}
            onClick={openCustomServerDialog}
            className="h-9 rounded-lg border-slate-800 bg-slate-950 px-3 text-sm text-slate-200 hover:border-sky-500/30 hover:bg-slate-900"
          >
            <Plus className="h-4 w-4" />
            Add custom
          </Button>
        </DialogTrigger>
        <DialogContent
          aria-describedby={undefined}
          className="w-[min(36rem,calc(100vw-2rem))] max-w-none border-slate-800 bg-slate-950 text-slate-100 sm:max-w-none"
        >
          <DialogHeader>
            <DialogTitle>Add custom MCP server</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="ID">
                <Input
                  value={customDraft.id}
                  onChange={(event) =>
                    setCustomDraft((current) => ({
                      ...current,
                      id: normalizeServerId(event.target.value),
                    }))
                  }
                  className={INPUT_CLASS}
                />
              </Field>
              <Field label="Title">
                <Input
                  value={customDraft.title}
                  onChange={(event) =>
                    setCustomDraft((current) => ({
                      ...current,
                      title: event.target.value,
                    }))
                  }
                  className={INPUT_CLASS}
                />
              </Field>
              <Field label="Transport">
                <select
                  value={customDraft.transportType}
                  onChange={(event) =>
                    setCustomDraft((current) => ({
                      ...current,
                      transportType: event.target.value as TransportType,
                    }))
                  }
                  className={SELECT_CLASS}
                >
                  <option value="stdio">stdio</option>
                  <option value="streamable-http">streamable-http</option>
                  <option value="sse">sse</option>
                </select>
              </Field>
              {customDraft.transportType === "stdio" ? (
                <Field label="Command">
                  <Input
                    value={customDraft.command}
                    placeholder="npx"
                    onChange={(event) =>
                      setCustomDraft((current) => ({
                        ...current,
                        command: event.target.value,
                      }))
                    }
                    className={INPUT_CLASS}
                  />
                </Field>
              ) : (
                <Field label="URL">
                  <Input
                    value={customDraft.url}
                    placeholder="https://example.com/mcp"
                    onChange={(event) =>
                      setCustomDraft((current) => ({
                        ...current,
                        url: event.target.value,
                      }))
                    }
                    className={INPUT_CLASS}
                  />
                </Field>
              )}
            </div>
            {customIdAlreadyExists ? (
              <p className="rounded-lg border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
                A server with this ID already exists.
              </p>
            ) : null}
            {!customTransportReady ? (
              <p className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-sm text-amber-100">
                {customDraft.transportType === "stdio"
                  ? "Enter a command before adding the server."
                  : "Enter a valid HTTP or HTTPS URL before adding the server."}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <DialogClose asChild>
                <Button
                  type="button"
                  variant="outline"
                  className="h-9 rounded-lg border-slate-800 bg-slate-950 px-3 text-sm text-slate-200 hover:bg-slate-900"
                >
                  Cancel
                </Button>
              </DialogClose>
              <Button
                type="button"
                disabled={!customDraftReady}
                onClick={addCustomServer}
                className="h-9 rounded-lg bg-sky-500 px-3 text-sm font-medium text-slate-950 hover:bg-sky-400"
              >
                Add server
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    );
  };

  const renderPresetDialog = (): JSX.Element => {
    return (
      <Dialog>
        <DialogTrigger asChild>
          <Button
            type="button"
            variant="outline"
            disabled={disabled}
            className="h-9 rounded-lg border-slate-800 bg-slate-950 px-3 text-sm text-slate-200 hover:border-sky-500/30 hover:bg-slate-900"
          >
            <Plus className="h-4 w-4" />
            Add preset
          </Button>
        </DialogTrigger>
        <DialogContent
          aria-describedby={undefined}
          className="max-h-[min(44rem,calc(100vh-2rem))] w-[min(42rem,calc(100vw-2rem))] max-w-none overflow-hidden border-slate-800 bg-slate-950 text-slate-100 sm:max-w-none"
        >
          <DialogHeader>
            <DialogTitle>Add MCP preset</DialogTitle>
          </DialogHeader>
          <div
            role="region"
            aria-label="MCP preset categories"
            className="grid min-h-0 max-h-[min(32rem,calc(100vh-10rem))] min-w-0 gap-4 overflow-y-auto overscroll-contain pr-1 [scrollbar-gutter:stable] [scrollbar-width:thin]"
          >
            {presetGroups.length === 0 ? (
              <p className="rounded-lg border border-dashed border-slate-800 bg-slate-950/60 px-3 py-6 text-center text-sm text-slate-500">
                No MCP presets available.
              </p>
            ) : null}
            {presetGroups.map((group) => (
              <section key={group.id} className="grid min-w-0 gap-2">
                <h3 className="sticky top-0 z-10 bg-slate-950/95 py-1 text-xs font-semibold text-slate-400 backdrop-blur">
                  {group.label}
                </h3>
                <div className="grid min-w-0 gap-2">
                  {group.presets.map((preset: McpPresetOption) => (
                    <DialogClose key={preset.id} asChild>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => addPreset(preset.id, preset.serverId)}
                        className="h-auto w-full max-w-full min-w-0 justify-start whitespace-normal rounded-lg border-slate-800 bg-slate-950 px-3 py-3 text-left text-sm text-slate-200 shadow-none hover:border-sky-500/30 hover:bg-slate-900"
                      >
                        <span className="grid min-w-0 flex-1 gap-1">
                          <span className="min-w-0 break-words font-semibold text-slate-100">
                            {preset.title}
                          </span>
                          <span className="min-w-0 break-words text-xs leading-5 text-slate-500">
                            {preset.description}
                          </span>
                          <span className="min-w-0 break-all font-mono text-xs text-slate-500">
                            {preset.serverId}
                          </span>
                        </span>
                      </Button>
                    </DialogClose>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    );
  };

  const renderServerList = (): JSX.Element => {
    return (
      <div className="grid content-start gap-2">
        {parsed.servers.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-800 bg-slate-950/60 px-3 py-6 text-center text-sm text-slate-500">
            No MCP servers configured.
          </div>
        ) : null}
        {parsed.servers.map((server, index) => {
          const serverId = getServerId(server, index);
          const serverKey = getServerKey(server, index);
          const selected = index === effectiveSelectedIndex;
          const enabled = getBoolean(server, "enabled", true);
          const serverIssues = validationIssues.filter(
            (issue) => issue.serverKey === serverKey,
          );
          const hasErrors = serverIssues.some((issue) => issue.tone === "error");
          const metadata = [
            getTransportType(server),
            getAuthType(server) === "none" ? "no auth" : getAuthType(server),
            enabled ? "enabled" : "disabled",
          ].join(" · ");

          return (
            <Button
              key={serverKey}
              type="button"
              variant="outline"
              aria-pressed={selected}
              onClick={() => selectServer(serverId)}
              className={cn(
                "h-auto w-full justify-start rounded-lg border-slate-800 bg-slate-950 px-3 py-3 text-left shadow-none hover:border-sky-500/30 hover:bg-slate-900",
                selected && "border-sky-500/40 bg-sky-500/10",
                hasErrors && "border-rose-500/30",
              )}
            >
              <span className="flex min-w-0 flex-1 items-start justify-between gap-3">
                <span className="grid min-w-0 gap-1">
                  <span className="truncate text-sm font-semibold text-slate-100">
                    {getString(server, "title") || serverId}
                  </span>
                  <span className="truncate font-mono text-xs text-slate-500">
                    {serverId}
                  </span>
                  <span className="truncate text-xs text-slate-500">{metadata}</span>
                </span>
                {hasErrors ? (
                  <span className="shrink-0 text-xs font-medium text-rose-200">
                    Needs setup
                  </span>
                ) : null}
              </span>
            </Button>
          );
        })}
      </div>
    );
  };

  const renderSelectedHeader = (): JSX.Element | null => {
    if (!selectedServer) {
      return null;
    }

    const enabled = getBoolean(selectedServer, "enabled", true);

    return (
      <div className="grid gap-3 border-b border-slate-800 px-4 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <h4 className="truncate text-base font-semibold text-slate-100">
                {getString(selectedServer, "title") || effectiveSelectedServerId}
              </h4>
            </div>
            <p className="mt-1 break-all font-mono text-xs text-slate-500">
              {effectiveSelectedServerId}
            </p>
            <p
              className={cn(
                "mt-2 text-xs font-medium",
                selectedHasErrors
                  ? "text-rose-200"
                  : enabled
                    ? "text-emerald-200"
                    : "text-slate-500",
              )}
            >
              {selectedHasErrors
                ? "Needs required setup"
                : enabled
                  ? "Enabled"
                  : "Disabled"}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-1 rounded-lg border border-slate-800 bg-slate-950/80 p-1">
          {SERVER_TABS.map((tab) => (
            <Button
              key={tab.value}
              type="button"
              variant="ghost"
              aria-pressed={selectedTab === tab.value}
              onClick={() => setSelectedTab(tab.value)}
              className={cn(
                "h-8 rounded-md px-3 text-xs text-slate-400 hover:bg-slate-900 hover:text-slate-100",
                selectedTab === tab.value && "bg-sky-500/15 text-sky-100",
              )}
            >
              {tab.label}
            </Button>
          ))}
        </div>
      </div>
    );
  };

  const renderSetupTab = (): JSX.Element | null => {
    if (!selectedServer) {
      return null;
    }

    return (
      <div className="grid gap-4">
        <IssueList issues={selectedIssues} />
        <PanelBlock title="Identity">
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="ID" detail="Lowercase letters, numbers, underscores, and dashes.">
              <Input
                value={getString(selectedServer, "id")}
                disabled={disabled}
                onChange={(event) => {
                  const id = normalizeServerId(event.target.value);
                  updateSelectedField("id", id);
                  setSelectedServerId(id);
                  setup.onDiscoveryServerIdChange(id);
                  setup.onOAuthServerIdChange(id);
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
            <Field label="Description">
              <Textarea
                value={getString(selectedServer, "description")}
                disabled={disabled}
                onChange={(event) =>
                  updateSelectedField("description", event.target.value)
                }
                className={cn(TEXTAREA_CLASS, "md:col-span-2")}
              />
            </Field>
            <CheckboxField
              label="Enabled"
              checked={getBoolean(selectedServer, "enabled", true)}
              disabled={disabled}
              onChange={(checked) => updateSelectedField("enabled", checked)}
            />
          </div>
        </PanelBlock>

        <PanelBlock title="Transport">
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Transport">
              <select
                value={transportType}
                disabled={disabled}
                onChange={(event) =>
                  updateSelectedField(
                    "transport",
                    createTransport(event.target.value as TransportType, transport),
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
                  placeholder="npx"
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
                  placeholder="https://example.com/mcp"
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
              <Field label="Args" detail="One argument per line or comma separated.">
                <Textarea
                  value={formatStringList(transport?.args)}
                  disabled={disabled}
                  placeholder="-y&#10;@modelcontextprotocol/server-filesystem"
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
              <Field label="Env" detail="KEY=value, one per line. Prefer env references for secrets.">
                <Textarea
                  value={formatStringRecord(transport?.env)}
                  disabled={disabled}
                  placeholder="API_KEY=${env:API_KEY}"
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
              <Field label="Working directory">
                <Input
                  value={getString(transport, "cwd")}
                  disabled={disabled}
                  placeholder="${workspaceRoot}"
                  onChange={(event) =>
                    updateSelectedRecord("transport", (record) =>
                      setRecordValue(record, "cwd", event.target.value),
                    )
                  }
                  className={INPUT_CLASS}
                />
              </Field>
              <Field label="stderr">
                <select
                  value={getString(transport, "stderr")}
                  disabled={disabled}
                  onChange={(event) =>
                    updateSelectedRecord("transport", (record) =>
                      setRecordValue(record, "stderr", event.target.value),
                    )
                  }
                  className={SELECT_CLASS}
                >
                  <option value="">Default</option>
                  <option value="pipe">pipe</option>
                  <option value="inherit">inherit</option>
                  <option value="ignore">ignore</option>
                </select>
              </Field>
            </div>
          ) : (
            <Field label="Headers" detail="KEY=value, one per line.">
              <Textarea
                value={formatStringRecord(transport?.headers)}
                disabled={disabled}
                onChange={(event) =>
                  updateSelectedRecord("transport", (record) =>
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
          )}
        </PanelBlock>
      </div>
    );
  };

  const renderAuthTab = (): JSX.Element | null => {
    if (!selectedServer) {
      return null;
    }

    return (
      <div className="grid gap-4">
        <PanelBlock title="Authentication">
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Auth">
              <select
                value={authType}
                disabled={disabled}
                onChange={(event) =>
                  updateSelectedField(
                    "auth",
                    createAuth(event.target.value as AuthType, auth),
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

          {authType === "bearer" ? (
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="Token env" detail="Recommended for secrets.">
                <Input
                  value={getString(auth, "tokenEnv")}
                  disabled={disabled}
                  placeholder="GITHUB_PERSONAL_ACCESS_TOKEN"
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
                  type="password"
                  value={getString(auth, "token")}
                  disabled={disabled}
                  autoComplete="off"
                  onChange={(event) =>
                    updateSelectedRecord("auth", (record) =>
                      setRecordValue(record, "token", event.target.value),
                    )
                  }
                  className={INPUT_CLASS}
                />
              </Field>
              <Field label="Header name">
                <Input
                  value={getString(auth, "headerName")}
                  disabled={disabled}
                  placeholder="Authorization"
                  onChange={(event) =>
                    updateSelectedRecord("auth", (record) =>
                      setRecordValue(record, "headerName", event.target.value),
                    )
                  }
                  className={INPUT_CLASS}
                />
              </Field>
            </div>
          ) : null}

          {authType === "headers" ? (
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="Headers" detail="KEY=value, one per line.">
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
              <Field label="Env headers" detail="Header=ENV_VAR, one per line.">
                <Textarea
                  value={formatStringRecord(auth?.envHeaders)}
                  disabled={disabled}
                  onChange={(event) =>
                    updateSelectedRecord("auth", (record) =>
                      setRecordValue(
                        record,
                        "envHeaders",
                        parseStringRecord(event.target.value),
                      ),
                    )
                  }
                  className={TEXTAREA_CLASS}
                />
              </Field>
            </div>
          ) : null}

          {authType === "oauth" ? (
            <div className="grid gap-3">
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
                <Field label="Client secret env">
                  <Input
                    value={getString(auth, "clientSecretEnv")}
                    disabled={disabled}
                    onChange={(event) =>
                      updateSelectedRecord("auth", (record) =>
                        setRecordValue(record, "clientSecretEnv", event.target.value),
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
                <Field label="Refresh token env">
                  <Input
                    value={getString(auth, "refreshTokenEnv")}
                    disabled={disabled}
                    onChange={(event) =>
                      updateSelectedRecord("auth", (record) =>
                        setRecordValue(
                          record,
                          "refreshTokenEnv",
                          event.target.value,
                        ),
                      )
                    }
                    className={INPUT_CLASS}
                  />
                </Field>
              </div>
              <div className="grid gap-2 rounded-lg border border-slate-800 bg-slate-950 p-3">
                <Field
                  label="OAuth callback URL or code"
                  detail="Manual fallback: paste a callback URL or code here only if automatic browser authorization cannot receive the localhost redirect."
                >
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
                </Field>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={actionDisabled || !effectiveSelectedServerId}
                    onClick={() => {
                      void setup.onStartOAuth(effectiveSelectedServerId);
                    }}
                    className="h-9 rounded-lg border-slate-800 bg-slate-950 px-3 text-sm text-slate-200 hover:border-sky-500/30 hover:bg-slate-900"
                  >
                    <ExternalLink className="h-4 w-4" />
                    Start OAuth
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={actionDisabled || !effectiveSelectedServerId}
                    onClick={() => {
                      void setup.onFinishOAuth(effectiveSelectedServerId, oauthCallback);
                    }}
                    className="h-9 rounded-lg border-slate-800 bg-slate-950 px-3 text-sm text-slate-200 hover:border-sky-500/30 hover:bg-slate-900"
                  >
                    <KeyRound className="h-4 w-4" />
                    Finish OAuth
                  </Button>
                </div>
              </div>
            </div>
          ) : null}
        </PanelBlock>
      </div>
    );
  };

  const renderCapabilitiesTab = (): JSX.Element | null => {
    if (!selectedServer) {
      return null;
    }

    return (
      <div className="grid gap-4">
        <PanelBlock title="Exposure">
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Exposure mode">
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
            <CheckboxField
              label="Direct tools"
              detail="Expose discovered tools as first-class tools."
              checked={getBoolean(exposure, "directTools", true)}
              disabled={disabled}
              onChange={(checked) =>
                updateSelectedRecord("exposure", (record) =>
                  setRecordValue(record, "directTools", checked),
                )
              }
            />
          </div>
        </PanelBlock>

        <PanelBlock title="Limits">
          <div className="grid gap-3 md:grid-cols-3">
            <Field label="Timeout ms">
              <Input
                type="number"
                min={0}
                value={formatOptionalNumber(selectedServer.timeoutMs)}
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
            <Field label="Max total timeout ms">
              <Input
                type="number"
                min={0}
                value={formatOptionalNumber(selectedServer.maxTotalTimeoutMs)}
                disabled={disabled}
                onChange={(event) =>
                  updateSelectedField(
                    "maxTotalTimeoutMs",
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
                value={formatOptionalNumber(selectedServer.maxResponseChars)}
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
        </PanelBlock>

        <PanelBlock title="Discovery">
          {selectedHasErrors ? (
            <p className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-sm text-amber-100">
              Complete the required setup fields before running discovery.
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={actionDisabled || selectedHasErrors || !effectiveSelectedServerId}
              onClick={() => {
                void setup.onDiscoverServer(effectiveSelectedServerId);
              }}
              className="h-9 rounded-lg border-slate-800 bg-slate-950 px-3 text-sm text-slate-200 hover:border-sky-500/30 hover:bg-slate-900"
            >
              <Search className="h-4 w-4" />
              Discover
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={actionDisabled || selectedHasErrors || !effectiveSelectedServerId}
              onClick={() => {
                void setup.onRefreshDiscoveryCache(effectiveSelectedServerId);
              }}
              className="h-9 rounded-lg border-slate-800 bg-slate-950 px-3 text-sm text-slate-200 hover:border-sky-500/30 hover:bg-slate-900"
            >
              <RefreshCw className="h-4 w-4" />
              Refresh cache
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
              List cache
            </Button>
          </div>

          {discoverySummary ? (
            <div className="grid gap-3">
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                <SummaryMetric label="Tools" value={discoverySummary.tools} />
                <SummaryMetric label="Resources" value={discoverySummary.resources} />
                <SummaryMetric
                  label="Templates"
                  value={discoverySummary.resourceTemplates}
                />
                <SummaryMetric label="Prompts" value={discoverySummary.prompts} />
              </div>
              <div className="grid gap-2 rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-xs leading-5 text-slate-400">
                {discoverySummary.serverId ? (
                  <p>
                    Server:{" "}
                    <span className="font-mono text-slate-200">
                      {discoverySummary.serverId}
                    </span>
                  </p>
                ) : null}
                {discoverySummary.transportType ? (
                  <p>Transport: {discoverySummary.transportType}</p>
                ) : null}
                {discoverySummary.protocolVersion ? (
                  <p>Protocol: {discoverySummary.protocolVersion}</p>
                ) : null}
                {discoverySummary.cachePath ? (
                  <p className="break-all">Cache: {discoverySummary.cachePath}</p>
                ) : null}
                {discoverySummary.discoveredAt ? (
                  <p>Discovered: {discoverySummary.discoveredAt}</p>
                ) : null}
              </div>
            </div>
          ) : setup.discoveryOutput ? (
            <p className="rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-400">
              Discovery output is available as raw JSON below.
            </p>
          ) : null}

          {setup.discoveryOutput ? (
            <details className="rounded-lg border border-slate-800 bg-slate-950">
              <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-slate-300">
                Raw discovery output
              </summary>
              <pre className="max-h-80 overflow-auto border-t border-slate-800 p-3 text-xs leading-5 text-slate-200">
                {setup.discoveryOutput}
              </pre>
            </details>
          ) : null}
        </PanelBlock>
      </div>
    );
  };

  const renderAdvancedTab = (): JSX.Element | null => {
    if (!selectedServer) {
      return null;
    }

    return (
      <div className="grid gap-4">
        <PanelBlock title="Runtime permissions">
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Roots">
              <Input
                value={
                  Array.isArray(selectedServer.roots)
                    ? selectedServer.roots.join(", ")
                    : getString(selectedServer, "roots")
                }
                disabled={disabled}
                placeholder="workspace"
                onChange={(event) =>
                  updateSelectedField("roots", parseRootsInput(event.target.value))
                }
                className={INPUT_CLASS}
              />
            </Field>
            <Field label="Sampling">
              <select
                value={getString(selectedServer, "sampling") || "disabled"}
                disabled={disabled}
                onChange={(event) =>
                  updateSelectedField("sampling", event.target.value)
                }
                className={SELECT_CLASS}
              >
                <option value="disabled">disabled</option>
                <option value="ask-agent">ask-agent</option>
              </select>
            </Field>
            <Field label="Tasks">
              <select
                value={getString(selectedServer, "tasks") || "optional"}
                disabled={disabled}
                onChange={(event) => updateSelectedField("tasks", event.target.value)}
                className={SELECT_CLASS}
              >
                <option value="disabled">disabled</option>
                <option value="optional">optional</option>
              </select>
            </Field>
            <Field label="Idle shutdown ms">
              <Input
                type="number"
                min={0}
                value={formatOptionalNumber(selectedServer.idleShutdownMs)}
                disabled={disabled}
                onChange={(event) =>
                  updateSelectedField(
                    "idleShutdownMs",
                    parseOptionalInteger(event.target.value),
                  )
                }
                className={INPUT_CLASS}
              />
            </Field>
          </div>
        </PanelBlock>

        <PanelBlock title="Cache policy">
          <div className="grid gap-3 md:grid-cols-3">
            <CheckboxField
              label="Cache enabled"
              checked={getBoolean(getRecord(selectedServer, "cache"), "enabled", true)}
              disabled={disabled}
              onChange={(checked) =>
                updateSelectedRecord("cache", (record) =>
                  setRecordValue(record, "enabled", checked),
                )
              }
            />
            <Field label="TTL ms">
              <Input
                type="number"
                min={0}
                value={formatOptionalNumber(getRecord(selectedServer, "cache")?.ttlMs)}
                disabled={disabled}
                onChange={(event) =>
                  updateSelectedRecord("cache", (record) =>
                    setRecordValue(
                      record,
                      "ttlMs",
                      parseOptionalInteger(event.target.value),
                    ),
                  )
                }
                className={INPUT_CLASS}
              />
            </Field>
            <CheckboxField
              label="Force refresh"
              checked={getBoolean(getRecord(selectedServer, "cache"), "forceRefresh", false)}
              disabled={disabled}
              onChange={(checked) =>
                updateSelectedRecord("cache", (record) =>
                  setRecordValue(record, "forceRefresh", checked),
                )
              }
            />
          </div>
        </PanelBlock>

        <PanelBlock title="Notes">
          <Field label="Notes">
            <Textarea
              value={getString(selectedServer, "notes")}
              disabled={disabled}
              onChange={(event) => updateSelectedField("notes", event.target.value)}
              className={TEXTAREA_CLASS}
            />
          </Field>
        </PanelBlock>

        <PanelBlock title="Selected server JSON">
          <pre className="max-h-80 overflow-auto rounded-lg border border-slate-800 bg-slate-950 p-3 text-xs leading-5 text-slate-200">
            {JSON.stringify(selectedServer, null, 2)}
          </pre>
        </PanelBlock>
      </div>
    );
  };

  const renderSelectedTab = (): JSX.Element | null => {
    switch (selectedTab) {
      case "setup":
        return renderSetupTab();
      case "auth":
        return renderAuthTab();
      case "capabilities":
        return renderCapabilitiesTab();
      case "advanced":
        return renderAdvancedTab();
    }
  };

  return (
    <SettingsCard
      title="MCP servers"
      description="Manage Model Context Protocol servers, credentials, discovery, and tool exposure."
    >
      <div className="grid gap-4 py-4">
        <PanelBlock
          title="Automatic provider enrollment"
          description="Machdoch continuously projects managed instructions and MCP servers into every detected Codex, Claude, and Copilot CLI. Machdoch-launched runs still receive an exact per-task snapshot."
        >
          <div className="grid gap-3 rounded-lg border border-slate-800 bg-slate-950/60 p-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="grid gap-1 text-sm text-slate-300">
                <span>
                  Sync: {providerSyncStatus?.enabled ? "enabled" : "disabled"}
                  {providerSyncStatus?.daemon.running
                    ? ` · daemon ${providerSyncStatus.daemon.pid ?? "running"}`
                    : " · daemon stopped"}
                </span>
                <span className="text-xs text-slate-500">
                  {providerSyncStatus?.lastReconciledAt
                    ? `Last reconciled ${providerSyncStatus.lastReconciledAt}`
                    : "Not reconciled yet"}
                  {providerSyncStatus?.daemon.autostartInstalled
                    ? " · login autostart installed"
                    : " · login autostart pending"}
                </span>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={providerSyncBusy}
                  onClick={() => void runProviderSyncAction(
                    providerSyncStatus?.enabled ? "disable" : "enable",
                  )}
                  className="h-8 rounded-lg border-slate-700 bg-slate-900 px-3 text-xs"
                >
                  {providerSyncStatus?.enabled ? "Disable" : "Enable all"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={providerSyncBusy}
                  onClick={() => void runProviderSyncAction("refresh")}
                  className="h-8 rounded-lg border-slate-700 bg-slate-900 px-3 text-xs"
                >
                  <RefreshCw className="h-3.5 w-3.5" /> Refresh
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={providerSyncBusy}
                  onClick={() => void runProviderSyncAction("plan")}
                  className="h-8 rounded-lg border-slate-700 bg-slate-900 px-3 text-xs"
                >
                  Plan
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={providerSyncBusy}
                  onClick={() => void runProviderSyncAction("doctor")}
                  className="h-8 rounded-lg border-slate-700 bg-slate-900 px-3 text-xs"
                >
                  Doctor
                </Button>
              </div>
            </div>
            {providerSyncStatus?.targets.length ? (
              <div className="grid gap-1 text-xs text-slate-400 sm:grid-cols-2">
                {providerSyncStatus.targets.map((target) => (
                  <span key={`${target.provider}-${target.scope}`}>
                    {target.provider} · {target.scope}: {target.state}
                  </span>
                ))}
              </div>
            ) : null}
            {providerSyncMessage ? (
              <p className="text-xs leading-5 text-slate-400">{providerSyncMessage}</p>
            ) : null}
          </div>
        </PanelBlock>

        <div className="sticky top-0 z-10 -mx-2 grid gap-3 border-b border-slate-800 bg-slate-950/95 px-2 py-3 shadow-sm shadow-black/20">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <ChoiceButtons
                label="MCP configuration scope"
                value={setup.scope}
                options={scopeOptions}
                disabled={setup.loading || setup.saving || dirty}
                onChange={setup.onScopeChange}
              />
              <p className="text-xs text-slate-500">
                {setup.saving
                  ? "Saving changes..."
                  : dirty
                    ? "Unsaved changes"
                    : "Saved"}
                {parsed.servers.length > 0
                  ? ` · ${parsed.servers.length} server${
                      parsed.servers.length === 1 ? "" : "s"
                    }`
                  : ""}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {renderCustomServerDialog()}
              {renderPresetDialog()}
              {dirty ? (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={setup.saving}
                  onClick={() => setup.onDraftChange(setup.document.raw)}
                  className="h-9 rounded-lg px-3 text-sm text-slate-300 hover:bg-slate-900 hover:text-slate-100"
                >
                  Discard changes
                </Button>
              ) : null}
              <Button
                type="button"
                disabled={saveDisabled}
                onClick={() => {
                  void setup.onSave();
                }}
                className="h-9 rounded-lg bg-sky-500 px-3 text-sm font-medium text-slate-950 hover:bg-sky-400"
              >
                <Save className="h-4 w-4" />
                {setup.saving ? "Saving" : "Save changes"}
              </Button>
            </div>
          </div>
          <p className="min-w-0 break-all font-mono text-xs leading-5 text-slate-500">
            {setup.document.path}
          </p>
        </div>

        {parsed.error ? (
          <p className="rounded-lg border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
            {parsed.error}
          </p>
        ) : (
          <>
            <div className="grid gap-4">
              <section className="grid gap-3">
                <div className="text-sm font-semibold text-slate-200">
                  Installed servers
                </div>
                {renderServerList()}
              </section>

              {selectedServer ? (
                <section className="min-w-0 overflow-hidden rounded-lg border border-slate-800 bg-slate-950/60">
                  {renderSelectedHeader()}
                  <div className="grid gap-4 p-4">{renderSelectedTab()}</div>
                  <div className="flex justify-end border-t border-slate-800 px-4 py-3">
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
                </section>
              ) : (
                <section className="grid min-h-64 place-items-center rounded-lg border border-dashed border-slate-800 bg-slate-950/50 p-8 text-center">
                  <div className="grid gap-2">
                    <Server className="mx-auto h-8 w-8 text-slate-600" />
                    <p className="text-sm text-slate-500">
                      Add a preset or custom server to start configuring MCP.
                    </p>
                  </div>
                </section>
              )}
            </div>
          </>
        )}

        <SettingsStatus message={setup.message} />
      </div>
    </SettingsCard>
  );
};
