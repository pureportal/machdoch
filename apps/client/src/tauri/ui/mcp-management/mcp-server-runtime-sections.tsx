import { Database, RefreshCw, Search } from "lucide-react";
import type { JSX } from "react";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import { CopyContextMenu } from "@machdoch/media-studio/tauri/ui/components/ui/copy-context-menu.js";
import { Input } from "@machdoch/media-studio/tauri/ui/components/ui/input.js";
import { Textarea } from "@machdoch/media-studio/tauri/ui/components/ui/textarea.js";
import { ParsedField } from "../chat-session/components/settings-dialog-panels/parsed-field";
import {
  formatOptionalNumber,
  formatRoots,
  getBoolean,
  getRecord,
  getString,
  parseOptionalInteger,
  parseRootsInput,
  setRecordValue,
  type DiscoverySummary,
  type ServerRecord,
} from "./mcp-config-model";
import {
  Field,
  MCP_INPUT_CLASS,
  MCP_PROSE_TEXTAREA_CLASS,
  MCP_SECONDARY_BUTTON_CLASS,
  MCP_SELECT_CLASS,
  McpSection,
  ToggleField,
} from "./mcp-form-fields";
import type { McpServerEditor } from "./use-mcp-server-editor";

interface SectionProps {
  editor: McpServerEditor;
  server: ServerRecord;
}

const NumberField = ({
  editor,
  label,
  value,
  onChange,
}: {
  editor: McpServerEditor;
  label: string;
  value: unknown;
  onChange: (value: number | undefined) => void;
}): JSX.Element => (
  <Field label={label}>
    <Input
      type="number"
      min={0}
      value={formatOptionalNumber(value)}
      disabled={editor.disabled}
      onChange={(event) => onChange(parseOptionalInteger(event.target.value))}
      className={MCP_INPUT_CLASS}
    />
  </Field>
);

const DiscoveryMetrics = ({
  summary,
}: {
  summary: DiscoverySummary;
}): JSX.Element => {
  const metrics = [
    ["Tools", summary.tools],
    ["Resources", summary.resources],
    ["Templates", summary.resourceTemplates],
    ["Prompts", summary.prompts],
  ] as const;
  const details = [
    summary.transportType ? `Transport: ${summary.transportType}` : null,
    summary.protocolVersion ? `Protocol: ${summary.protocolVersion}` : null,
    summary.discoveredAt ? `Discovered: ${summary.discoveredAt}` : null,
  ].filter((detail): detail is string => detail !== null);

  return (
    <div className="grid gap-3">
      <dl className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        {metrics.map(([label, value]) => (
          <div
            key={label}
            className="rounded-lg border border-slate-800 bg-slate-950 px-3 py-2"
          >
            <dt className="text-xs text-slate-500">{label}</dt>
            <dd className="mt-0.5 text-lg font-semibold tabular-nums text-slate-100">
              {value ?? "–"}
            </dd>
          </div>
        ))}
      </dl>
      <div className="grid gap-1 text-xs leading-5 text-slate-400">
        {summary.serverId ? (
          <p>
            Server:{" "}
            <span className="font-mono text-slate-200">{summary.serverId}</span>
          </p>
        ) : null}
        {details.map((detail) => (
          <p key={detail}>{detail}</p>
        ))}
        {summary.cachePath ? (
          <p className="break-all">Cache: {summary.cachePath}</p>
        ) : null}
      </div>
    </div>
  );
};

const DiscoverySection = ({
  editor,
}: {
  editor: McpServerEditor;
}): JSX.Element => {
  const { setup, selectedServerId, selectedHasErrors, discoverySummary } =
    editor;
  const serverActionDisabled =
    editor.actionDisabled || selectedHasErrors || !selectedServerId;

  return (
    <McpSection
      title="Discovery"
      action={
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={serverActionDisabled}
            onClick={() => {
              void setup.onDiscoverServer(selectedServerId);
            }}
            className={MCP_SECONDARY_BUTTON_CLASS}
          >
            <Search className="size-4" />
            Discover
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={serverActionDisabled}
            onClick={() => {
              void setup.onRefreshDiscoveryCache(selectedServerId);
            }}
            className={MCP_SECONDARY_BUTTON_CLASS}
          >
            <RefreshCw className="size-4" />
            Refresh cache
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={editor.actionDisabled}
            onClick={() => {
              void setup.onListDiscoveryCache();
            }}
            className={MCP_SECONDARY_BUTTON_CLASS}
          >
            <Database className="size-4" />
            List cache
          </Button>
        </div>
      }
    >
      {!setup.commandsAvailable ? (
        <p className="text-sm text-slate-400">
          Select a workspace to run discovery.
        </p>
      ) : selectedHasErrors ? (
        <p className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-sm text-amber-100">
          Complete the required setup fields before running discovery.
        </p>
      ) : null}

      {discoverySummary ? (
        <DiscoveryMetrics summary={discoverySummary} />
      ) : null}

      {setup.discoveryOutput ? (
        <details className="rounded-lg border border-slate-800 bg-slate-950">
          <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-slate-300">
            Raw discovery output
          </summary>
          <CopyContextMenu
            values={[
              {
                label: "Copy discovery output",
                value: setup.discoveryOutput,
              },
            ]}
          >
            <pre className="max-h-80 overflow-auto border-t border-slate-800 p-3 text-xs leading-5 text-slate-200">
              {setup.discoveryOutput}
            </pre>
          </CopyContextMenu>
        </details>
      ) : null}
    </McpSection>
  );
};

export const McpCapabilitiesSection = ({
  editor,
  server,
}: SectionProps): JSX.Element => {
  const exposure = getRecord(server, "exposure");

  return (
    <div className="grid gap-4">
      <McpSection title="Exposure">
        <div className="grid gap-4 md:grid-cols-2 md:items-end">
          <Field label="Exposure mode">
            <select
              value={getString(exposure, "mode") || "hybrid"}
              disabled={editor.disabled}
              onChange={(event) =>
                editor.updateSelectedRecord("exposure", (record) =>
                  setRecordValue(record, "mode", event.target.value),
                )
              }
              className={MCP_SELECT_CLASS}
            >
              <option value="meta-tools">meta-tools</option>
              <option value="direct-tools">direct-tools</option>
              <option value="hybrid">hybrid</option>
            </select>
          </Field>
          <ToggleField
            label="Direct tools"
            checked={getBoolean(exposure, "directTools", true)}
            disabled={editor.disabled}
            onChange={(checked) =>
              editor.updateSelectedRecord("exposure", (record) =>
                setRecordValue(record, "directTools", checked),
              )
            }
          />
        </div>
      </McpSection>

      <McpSection title="Limits">
        <div className="grid gap-4 md:grid-cols-3">
          <NumberField
            editor={editor}
            label="Timeout ms"
            value={server.timeoutMs}
            onChange={(value) => editor.updateSelectedField("timeoutMs", value)}
          />
          <NumberField
            editor={editor}
            label="Max total timeout ms"
            value={server.maxTotalTimeoutMs}
            onChange={(value) =>
              editor.updateSelectedField("maxTotalTimeoutMs", value)
            }
          />
          <NumberField
            editor={editor}
            label="Max chars"
            value={server.maxResponseChars}
            onChange={(value) =>
              editor.updateSelectedField("maxResponseChars", value)
            }
          />
        </div>
      </McpSection>

      <DiscoverySection editor={editor} />
    </div>
  );
};

export const McpAdvancedSection = ({
  editor,
  server,
}: SectionProps): JSX.Element => {
  const cache = getRecord(server, "cache");
  const serverJson = JSON.stringify(server, null, 2);

  return (
    <div className="grid gap-4">
      <McpSection title="Runtime permissions">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Roots">
            <ParsedField
              key={editor.selectedServerKey}
              value={server.roots}
              format={formatRoots}
              parse={parseRootsInput}
              disabled={editor.disabled}
              placeholder="workspace"
              onChange={(roots) => editor.updateSelectedField("roots", roots)}
              className={MCP_INPUT_CLASS}
            />
          </Field>
          <Field label="Sampling">
            <select
              value={getString(server, "sampling") || "disabled"}
              disabled={editor.disabled}
              onChange={(event) =>
                editor.updateSelectedField("sampling", event.target.value)
              }
              className={MCP_SELECT_CLASS}
            >
              <option value="disabled">disabled</option>
              <option value="ask-agent">ask-agent</option>
            </select>
          </Field>
          <Field label="Tasks">
            <select
              value={getString(server, "tasks") || "optional"}
              disabled={editor.disabled}
              onChange={(event) =>
                editor.updateSelectedField("tasks", event.target.value)
              }
              className={MCP_SELECT_CLASS}
            >
              <option value="disabled">disabled</option>
              <option value="optional">optional</option>
            </select>
          </Field>
          <NumberField
            editor={editor}
            label="Idle shutdown ms"
            value={server.idleShutdownMs}
            onChange={(value) =>
              editor.updateSelectedField("idleShutdownMs", value)
            }
          />
        </div>
      </McpSection>

      <McpSection title="Cache policy">
        <div className="grid gap-4 md:grid-cols-3 md:items-end">
          <ToggleField
            label="Cache enabled"
            checked={getBoolean(cache, "enabled", true)}
            disabled={editor.disabled}
            onChange={(checked) =>
              editor.updateSelectedRecord("cache", (record) =>
                setRecordValue(record, "enabled", checked),
              )
            }
          />
          <NumberField
            editor={editor}
            label="TTL ms"
            value={cache?.ttlMs}
            onChange={(value) =>
              editor.updateSelectedRecord("cache", (record) =>
                setRecordValue(record, "ttlMs", value),
              )
            }
          />
          <ToggleField
            label="Force refresh"
            checked={getBoolean(cache, "forceRefresh", false)}
            disabled={editor.disabled}
            onChange={(checked) =>
              editor.updateSelectedRecord("cache", (record) =>
                setRecordValue(record, "forceRefresh", checked),
              )
            }
          />
        </div>
      </McpSection>

      <McpSection title="Notes">
        <Textarea
          aria-label="Notes"
          value={getString(server, "notes")}
          disabled={editor.disabled}
          onChange={(event) =>
            editor.updateSelectedField("notes", event.target.value)
          }
          className={MCP_PROSE_TEXTAREA_CLASS}
        />
      </McpSection>

      <McpSection title="Server JSON">
        <CopyContextMenu
          values={[{ label: "Copy server JSON", value: serverJson }]}
        >
          <pre className="max-h-80 overflow-auto rounded-lg border border-slate-800 bg-slate-950 p-3 text-xs leading-5 text-slate-200">
            {serverJson}
          </pre>
        </CopyContextMenu>
      </McpSection>
    </div>
  );
};
