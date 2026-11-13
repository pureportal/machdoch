import { Check, Plus } from "lucide-react";
import { useId, useMemo, useState, type JSX } from "react";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@machdoch/media-studio/tauri/ui/components/ui/dialog.js";
import { Input } from "@machdoch/media-studio/tauri/ui/components/ui/input.js";
import {
  SUBMIT_SHORTCUT_ACTION_PROPS,
  SubmitShortcut,
} from "@machdoch/media-studio/tauri/ui/components/ui/submit-shortcut.js";
import { cn } from "@machdoch/media-studio/tauri/ui/lib/utils.js";
import {
  createAuth,
  getServerId,
  getUniqueServerId,
  groupMcpPresets,
  isValidHttpUrl,
  normalizeServerId,
  TRANSPORT_TYPES,
  type TransportType,
} from "./mcp-config-model";
import {
  Field,
  MCP_INPUT_CLASS,
  MCP_SECONDARY_BUTTON_CLASS,
  MCP_SELECT_CLASS,
  MCP_TEXT_INPUT_CLASS,
} from "./mcp-form-fields";
import type { McpServerEditor } from "./use-mcp-server-editor";

interface CustomServerDraft {
  id: string;
  title: string;
  transportType: TransportType;
  command: string;
  url: string;
}

export const CustomServerDialog = ({
  editor,
}: {
  editor: McpServerEditor;
}): JSX.Element => {
  const [open, setOpen] = useState(false);
  const [transportTouched, setTransportTouched] = useState(false);
  const transportErrorId = useId();
  const [draft, setDraft] = useState<CustomServerDraft>({
    id: "mcp-server",
    title: "MCP Server",
    transportType: "stdio",
    command: "",
    url: "",
  });
  const servers = editor.parsed.servers;
  const normalizedId = normalizeServerId(draft.id);
  const idAlreadyExists = servers.some(
    (server, index) =>
      normalizeServerId(getServerId(server, index)) === normalizedId,
  );
  const transportReady =
    draft.transportType === "stdio"
      ? draft.command.trim().length > 0
      : isValidHttpUrl(draft.url.trim());
  const ready = normalizedId.length > 0 && !idAlreadyExists && transportReady;
  const showTransportError = transportTouched && !transportReady;

  const openDialog = (): void => {
    setDraft({
      id: getUniqueServerId(servers, "mcp-server"),
      title: "MCP Server",
      transportType: "stdio",
      command: "",
      url: "",
    });
    setTransportTouched(false);
    setOpen(true);
  };

  const addServer = (): void => {
    if (!ready) {
      return;
    }

    editor.addServer({
      id: normalizedId,
      title: draft.title.trim() || normalizedId,
      enabled: true,
      transport:
        draft.transportType === "stdio"
          ? { type: "stdio", command: draft.command.trim() }
          : { type: draft.transportType, url: draft.url.trim() },
      auth: createAuth("none"),
      exposure: { mode: "hybrid", directTools: true },
    });
    setOpen(false);
  };

  const transportFieldProps = {
    required: true,
    "aria-invalid": showTransportError,
    "aria-describedby": showTransportError ? transportErrorId : undefined,
    onBlur: () => setTransportTouched(true),
    className: MCP_INPUT_CLASS,
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="outline"
          disabled={editor.disabled}
          onClick={openDialog}
          className={MCP_SECONDARY_BUTTON_CLASS}
        >
          <Plus className="size-4" />
          Add custom
        </Button>
      </DialogTrigger>
      <SubmitShortcut asChild>
        <DialogContent
          aria-describedby={undefined}
          className="w-[min(36rem,calc(100vw-2rem))] max-w-none gap-5 border-slate-800 bg-slate-950 text-slate-100 sm:max-w-none"
        >
          <DialogHeader>
            <DialogTitle>Add custom MCP server</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="ID">
              <Input
                value={draft.id}
                aria-invalid={idAlreadyExists}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    id: normalizeServerId(event.target.value),
                  }))
                }
                className={MCP_INPUT_CLASS}
              />
            </Field>
            <Field label="Title">
              <Input
                value={draft.title}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    title: event.target.value,
                  }))
                }
                className={MCP_TEXT_INPUT_CLASS}
              />
            </Field>
            <Field label="Transport">
              <select
                value={draft.transportType}
                onChange={(event) => {
                  setTransportTouched(false);
                  setDraft((current) => ({
                    ...current,
                    transportType: event.target.value as TransportType,
                  }));
                }}
                className={MCP_SELECT_CLASS}
              >
                {TRANSPORT_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
            </Field>
            {draft.transportType === "stdio" ? (
              <Field label="Command">
                <Input
                  {...transportFieldProps}
                  value={draft.command}
                  placeholder="npx"
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      command: event.target.value,
                    }))
                  }
                />
              </Field>
            ) : (
              <Field label="URL">
                <Input
                  {...transportFieldProps}
                  value={draft.url}
                  type="url"
                  placeholder="https://example.com/mcp"
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      url: event.target.value,
                    }))
                  }
                />
              </Field>
            )}
          </div>
          {idAlreadyExists ? (
            <p className="rounded-lg border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
              A server with this ID already exists.
            </p>
          ) : null}
          {showTransportError ? (
            <p
              id={transportErrorId}
              role="alert"
              className="rounded-lg border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-sm text-rose-200"
            >
              {draft.transportType === "stdio"
                ? "Enter a command before adding the server."
                : "Enter a valid HTTP or HTTPS URL before adding the server."}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <DialogClose asChild>
              <Button
                type="button"
                variant="ghost"
                className="h-9 rounded-lg px-3 text-sm text-slate-300 hover:bg-slate-900 hover:text-slate-100"
              >
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="button"
              disabled={!ready}
              onClick={addServer}
              {...SUBMIT_SHORTCUT_ACTION_PROPS}
              className="h-9 rounded-lg bg-sky-600 px-4 text-sm font-medium text-white hover:bg-sky-700"
            >
              Add server
            </Button>
          </div>
        </DialogContent>
      </SubmitShortcut>
    </Dialog>
  );
};

export const PresetDialog = ({
  editor,
}: {
  editor: McpServerEditor;
}): JSX.Element => {
  const groups = useMemo(
    () => groupMcpPresets(editor.setup.presets),
    [editor.setup.presets],
  );
  const installedIds = new Set(
    editor.parsed.servers.map((server, index) =>
      normalizeServerId(getServerId(server, index)),
    ),
  );

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="outline"
          disabled={editor.disabled}
          className={MCP_SECONDARY_BUTTON_CLASS}
        >
          <Plus className="size-4" />
          Add preset
        </Button>
      </DialogTrigger>
      <DialogContent
        aria-describedby={undefined}
        className="max-h-[min(46rem,calc(100vh-2rem))] w-[min(52rem,calc(100vw-2rem))] max-w-none gap-4 overflow-hidden border-slate-800 bg-slate-950 text-slate-100 sm:max-w-none"
      >
        <DialogHeader>
          <DialogTitle>Add MCP preset</DialogTitle>
        </DialogHeader>
        <div
          role="region"
          aria-label="MCP preset categories"
          className="grid max-h-[min(36rem,calc(100vh-10rem))] min-h-0 min-w-0 gap-5 overflow-y-auto overscroll-contain pr-1 [scrollbar-gutter:stable] [scrollbar-width:thin]"
        >
          {groups.length === 0 ? (
            <p className="rounded-lg border border-dashed border-slate-800 bg-slate-950/60 px-3 py-6 text-center text-sm text-slate-500">
              No MCP presets available.
            </p>
          ) : null}
          {groups.map((group) => (
            <section key={group.id} className="grid min-w-0 gap-2">
              <h3 className="sticky top-0 z-10 bg-slate-950/95 py-1 text-xs font-semibold text-slate-400 backdrop-blur">
                {group.label}
              </h3>
              <div className="grid min-w-0 gap-2 sm:grid-cols-2">
                {group.presets.map((preset) => {
                  const installed = installedIds.has(preset.serverId);

                  return (
                    <DialogClose key={preset.id} asChild>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() =>
                          editor.addPreset(preset.id, preset.serverId)
                        }
                        className={cn(
                          "h-auto w-full min-w-0 items-start justify-start whitespace-normal rounded-xl border-slate-800 bg-slate-900/40 px-4 py-3 text-left text-sm text-slate-200 shadow-none hover:border-sky-500/30 hover:bg-slate-900",
                          installed && "border-emerald-500/25",
                        )}
                      >
                        <span className="grid min-w-0 flex-1 gap-1">
                          <span className="flex min-w-0 items-center justify-between gap-2">
                            <span className="min-w-0 break-words font-semibold text-slate-100">
                              {preset.title}
                            </span>
                            {installed ? (
                              <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-emerald-300">
                                <Check
                                  aria-hidden="true"
                                  className="size-3.5"
                                />
                                Added
                              </span>
                            ) : null}
                          </span>
                          <span className="min-w-0 break-words text-xs leading-5 text-slate-400">
                            {preset.description}
                          </span>
                          <span className="min-w-0 break-all font-mono text-xs text-slate-500">
                            {preset.serverId}
                          </span>
                        </span>
                      </Button>
                    </DialogClose>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
};
