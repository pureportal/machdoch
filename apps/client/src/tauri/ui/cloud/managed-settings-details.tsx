import { useEffect, useId, useRef, useState, type JSX } from "react";
import { AlertTriangle } from "lucide-react";
import type { FleetManagedSettingsDocument } from "@machdoch/fleet-protocol";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import { Textarea } from "@machdoch/media-studio/tauri/ui/components/ui/textarea.js";
import {
  proposeFleetSetting,
  type FleetConnectionStatus,
  type FleetSettingsProposal,
} from "../runtime";
import {
  exportFleetDeviceSettings,
  uploadFleetDeviceSettings,
} from "../chat-session/_helpers/fleet-managed-settings-sync";

const cardClass =
  "grid gap-3 rounded-lg border border-slate-800 bg-slate-900/50 p-4";
const buttonClass =
  "h-8 rounded-lg border-slate-700 bg-slate-950 px-3 text-xs text-slate-200";
const selectClass =
  "h-9 w-full min-w-0 rounded-md border border-slate-700 bg-slate-950 px-2 text-sm text-slate-100 outline-none focus-visible:border-sky-500/70 focus-visible:ring-1 focus-visible:ring-sky-500/40 disabled:opacity-60";
const VISIBLE_WARNINGS = 3;
const PREVIEW_CHARACTERS = 600;

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

interface Message {
  kind: "status" | "alert";
  text: string;
}

const MessageLine = ({ message }: { message: Message | null }) =>
  message ? (
    <p
      role={message.kind}
      className={`break-words text-xs ${message.kind === "alert" ? "text-rose-300" : "text-slate-400"}`}
    >
      {message.text}
    </p>
  ) : null;

function syncLabel(sync: FleetConnectionStatus["settingsSync"]): string {
  if (!sync) return "Checking";
  if (sync.phase === "syncing") return "Syncing";
  if (sync.phase === "error") return "Sync failed";
  return "Synced";
}

/**
 * Settings delivered by machdoch.cloud: sync state, assigned profiles,
 * per-item warnings and the device settings upload.
 */
export function ManagedSettingsSection({
  status,
  formatTime,
  onRetry,
}: {
  status: FleetConnectionStatus;
  formatTime: (seconds: number) => string;
  onRetry: () => void;
}): JSX.Element {
  const id = useId();
  const sync = status.settingsSync;
  const layers = sync?.layers ?? [];
  const warnings = sync?.warnings ?? [];
  const [showAllWarnings, setShowAllWarnings] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadedAt, setUploadedAt] = useState<number | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const capturedAt = uploadedAt ?? sync?.snapshotCapturedAt ?? null;
  const visibleWarnings = showAllWarnings
    ? warnings
    : warnings.slice(0, VISIBLE_WARNINGS);
  const profile = sync?.profileName
    ? `${sync.profileName}${sync.revision === undefined ? "" : ` · Revision ${sync.revision}`}`
    : null;
  const time =
    sync?.phase === "error"
      ? `Last attempt ${formatTime(sync.lastAttemptAt)}`
      : sync?.lastAppliedAt !== undefined
        ? `Last synced ${formatTime(sync.lastAppliedAt)}`
        : null;

  const upload = async (): Promise<void> => {
    setUploading(true);
    setMessage(null);
    try {
      const current = await uploadFleetDeviceSettings();
      setUploadedAt(Math.floor(Date.now() / 1000));
      setMessage({
        kind: "status",
        text: current
          ? "Device settings uploaded."
          : "Device settings uploaded. Update machdoch.cloud to upload them again later.",
      });
    } catch (error) {
      setMessage({ kind: "alert", text: errorText(error) });
    } finally {
      setUploading(false);
    }
  };

  return (
    <section aria-labelledby={`${id}-heading`} className={cardClass}>
      <div className="flex items-center justify-between gap-3">
        <h3 id={`${id}-heading`} className="text-sm font-medium text-slate-100">
          Settings profiles
        </h3>
        <span className="shrink-0 text-xs text-slate-300">
          {syncLabel(sync)}
        </span>
      </div>
      {layers.length > 1 ? (
        <div className="grid gap-1.5">
          <span className="text-xs text-slate-500">
            Profiles, highest priority first
          </span>
          <ol aria-label="Assigned profiles" className="flex flex-wrap gap-1.5">
            {layers.map((layer, index) => (
              <li
                key={layer.profileId}
                title={`${layer.name} · Revision ${layer.revision}`}
                className="max-w-full truncate rounded-md border border-slate-800 bg-slate-950 px-2 py-0.5 text-xs text-slate-300"
              >
                {index + 1}. {layer.name}
              </li>
            ))}
          </ol>
        </div>
      ) : profile ? (
        <p className="break-words text-xs text-slate-300">{profile}</p>
      ) : sync?.phase === "applied" ? (
        <p className="text-xs text-slate-400">
          No profile is assigned to this device. Your own settings apply.
        </p>
      ) : null}
      {time ? <p className="text-xs text-slate-500">{time}</p> : null}
      {sync?.phase === "error" ? (
        <div className="grid justify-items-start gap-2">
          {sync.lastError ? (
            <p role="alert" className="break-words text-xs text-rose-300">
              {sync.lastError}
            </p>
          ) : null}
          <Button
            type="button"
            variant="outline"
            onClick={onRetry}
            className={buttonClass}
          >
            Retry sync
          </Button>
        </div>
      ) : null}
      {warnings.length ? (
        <div className="grid justify-items-start gap-1.5">
          <ul
            id={`${id}-warnings`}
            aria-label="Settings warnings"
            className="grid w-full gap-1.5"
          >
            {visibleWarnings.map((warning) => (
              <li
                key={warning}
                className="flex gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-100"
              >
                <AlertTriangle
                  aria-hidden="true"
                  className="mt-0.5 size-3.5 shrink-0"
                />
                <span className="min-w-0 break-words">{warning}</span>
              </li>
            ))}
          </ul>
          {warnings.length > VISIBLE_WARNINGS ? (
            <button
              type="button"
              aria-expanded={showAllWarnings}
              aria-controls={`${id}-warnings`}
              onClick={() => setShowAllWarnings((current) => !current)}
              className="rounded text-xs text-sky-300 underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-sky-500"
            >
              {showAllWarnings
                ? "Show fewer warnings"
                : `Show all ${warnings.length} warnings`}
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="grid gap-2 border-t border-slate-800 pt-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="grid min-w-0 gap-0.5 text-xs">
            <span className="text-slate-500">Device settings</span>
            <span className="text-slate-300">
              {capturedAt
                ? `Uploaded ${formatTime(capturedAt)}`
                : "Not uploaded yet"}
            </span>
          </div>
          <Button
            type="button"
            variant="outline"
            disabled={uploading}
            onClick={() => void upload()}
            className={buttonClass}
          >
            {uploading
              ? "Uploading…"
              : capturedAt
                ? "Re-upload device settings"
                : "Upload device settings"}
          </Button>
        </div>
        <p className="text-xs text-slate-500">
          Administrators can create profiles from this device&apos;s own
          settings. Settings from machdoch.cloud and secret values are left out.
        </p>
        <MessageLine message={message} />
      </div>
    </section>
  );
}

type ProposalKind = FleetSettingsProposal["kind"];

interface ProposalCandidate {
  key: string;
  label: string;
  /** The item without a note; the note is added when sending. */
  proposal: FleetSettingsProposal;
}

const kindLabels: Record<ProposalKind, string> = {
  instruction: "Instruction",
  contextPack: "Context pack",
  prompt: "Prompt",
  mcpServer: "MCP server",
};

const proposalKinds = Object.keys(kindLabels) as ProposalKind[];

const candidatesFrom = (
  document: FleetManagedSettingsDocument,
): Record<ProposalKind, ProposalCandidate[]> => ({
  instruction: document.instructions.map((item) => ({
    key: item.id,
    label: item.name,
    proposal: { kind: "instruction", item },
  })),
  contextPack: document.contextPacks.map((item) => ({
    key: item.id,
    label: item.name,
    proposal: { kind: "contextPack", item },
  })),
  prompt: document.prompts.map((item) => ({
    key: item.id,
    label: item.relativePath,
    proposal: { kind: "prompt", item },
  })),
  mcpServer: (document.mcpServers ?? []).map((item) => ({
    key: item.id,
    label: item.title ?? item.id,
    proposal: { kind: "mcpServer", item },
  })),
});

/** The text an administrator will review, shortened for the preview. */
function previewText(proposal: ProposalCandidate["proposal"]): string {
  const text = (() => {
    switch (proposal.kind) {
      case "instruction":
        return proposal.item.body;
      case "contextPack":
        return [proposal.item.instructions, proposal.item.prompt]
          .filter(Boolean)
          .join("\n\n");
      case "prompt":
        return proposal.item.content;
      case "mcpServer": {
        const { transport } = proposal.item;
        return transport.type === "stdio"
          ? [
              [transport.command, ...transport.args].join(" "),
              ...Object.entries(transport.env).map(
                ([name, value]) => `${name}=${value}`,
              ),
            ].join("\n")
          : [
              transport.url,
              ...Object.entries(transport.headers).map(
                ([name, value]) => `${name}: ${value}`,
              ),
            ].join("\n");
      }
    }
  })();
  return text.length > PREVIEW_CHARACTERS
    ? `${text.slice(0, PREVIEW_CHARACTERS).trimEnd()}…`
    : text;
}

/** Sends one of the device's own settings to machdoch.cloud for review. */
export function ProposeToOrganization({
  status,
}: {
  status: FleetConnectionStatus;
}): JSX.Element {
  const id = useId();
  const [candidates, setCandidates] = useState<Record<
    ProposalKind,
    ProposalCandidate[]
  > | null>(null);
  const [kind, setKind] = useState<ProposalKind>("instruction");
  const [selected, setSelected] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const openButton = useRef<HTMLButtonElement>(null);
  const typeSelect = useRef<HTMLSelectElement>(null);
  const emptyDone = useRef<HTMLButtonElement>(null);
  const focusAfterRender = useRef<"form" | "open" | null>(null);
  const kinds = candidates
    ? proposalKinds.filter((entry) => candidates[entry].length > 0)
    : [];
  const options = candidates?.[kind] ?? [];
  const choice = options.find((candidate) => candidate.key === selected);

  // Opening and closing the form replaces the focused button.
  useEffect(() => {
    const target = focusAfterRender.current;
    focusAfterRender.current = null;
    if (target === "form") (typeSelect.current ?? emptyDone.current)?.focus();
    if (target === "open") openButton.current?.focus();
  }, [candidates]);

  const load = async (): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      const next = candidatesFrom(await exportFleetDeviceSettings());
      const firstKind = proposalKinds.find((entry) => next[entry].length > 0);
      if (firstKind) {
        setKind(firstKind);
        setSelected(next[firstKind][0]!.key);
      }
      focusAfterRender.current = "form";
      setCandidates(next);
    } catch (error) {
      setMessage({ kind: "alert", text: errorText(error) });
    } finally {
      setBusy(false);
    }
  };

  const close = (): void => {
    focusAfterRender.current = "open";
    setCandidates(null);
    setNote("");
    setMessage(null);
  };

  const send = async (): Promise<void> => {
    if (!choice) return;
    if (!status.managerId || !status.instanceId) {
      setMessage({
        kind: "alert",
        text: "Connect this device to machdoch.cloud first.",
      });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const trimmed = note.trim();
      await proposeFleetSetting(status.managerId, status.instanceId, {
        ...choice.proposal,
        ...(trimmed ? { note: trimmed } : {}),
      } as FleetSettingsProposal);
      setNote("");
      setMessage({
        kind: "status",
        text: `Sent "${choice.label}" to machdoch.cloud for review.`,
      });
    } catch (error) {
      setMessage({ kind: "alert", text: errorText(error) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby={`${id}-heading`} className={cardClass}>
      <div className="grid gap-1">
        <h3 id={`${id}-heading`} className="text-sm font-medium text-slate-100">
          Propose to organization
        </h3>
        <p className="text-xs text-slate-500">
          Send one of your own settings to machdoch.cloud. An administrator
          reviews it before it reaches other devices. Secret values stay on this
          device.
        </p>
      </div>
      {candidates === null ? (
        <div>
          <Button
            ref={openButton}
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => void load()}
            className={buttonClass}
          >
            {busy ? "Loading…" : "Choose a setting to propose"}
          </Button>
        </div>
      ) : kinds.length === 0 ? (
        <div className="grid justify-items-start gap-2">
          <p className="text-xs text-slate-400">
            This device has no settings of its own to propose yet.
          </p>
          <Button
            ref={emptyDone}
            type="button"
            variant="outline"
            onClick={close}
            className={buttonClass}
          >
            Done
          </Button>
        </div>
      ) : (
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)]">
            <div className="grid min-w-0 gap-1">
              <label
                htmlFor={`${id}-kind`}
                className="text-xs font-medium text-slate-500"
              >
                Setting type
              </label>
              <select
                ref={typeSelect}
                id={`${id}-kind`}
                value={kind}
                disabled={busy}
                onChange={(event) => {
                  const next = event.target.value as ProposalKind;
                  setKind(next);
                  setSelected(candidates[next][0]?.key ?? "");
                }}
                className={selectClass}
              >
                {kinds.map((entry) => (
                  <option key={entry} value={entry}>
                    {kindLabels[entry]}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid min-w-0 gap-1">
              <label
                htmlFor={`${id}-item`}
                className="text-xs font-medium text-slate-500"
              >
                Setting
              </label>
              <select
                id={`${id}-item`}
                value={selected}
                disabled={busy}
                onChange={(event) => setSelected(event.target.value)}
                className={selectClass}
              >
                {options.map((candidate) => (
                  <option key={candidate.key} value={candidate.key}>
                    {candidate.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {choice ? (
            <figure className="grid min-w-0 gap-1">
              <figcaption className="text-xs font-medium text-slate-500">
                What will be sent
              </figcaption>
              <pre className="whitespace-pre-wrap break-words rounded-md border border-slate-800 bg-slate-950 p-2 font-mono text-xs text-slate-300">
                {previewText(choice.proposal)}
              </pre>
              {choice.proposal.kind === "mcpServer" ? (
                <p className="text-xs text-slate-500">
                  Secret values are replaced by {"{{secret:…}}"} placeholders.
                  An administrator adds the values in machdoch.cloud.
                </p>
              ) : null}
            </figure>
          ) : null}
          <div className="grid gap-1">
            <label
              htmlFor={`${id}-note`}
              className="text-xs font-medium text-slate-500"
            >
              Note (optional)
            </label>
            <Textarea
              id={`${id}-note`}
              value={note}
              maxLength={500}
              disabled={busy}
              onChange={(event) => setNote(event.currentTarget.value)}
              placeholder="Why is this useful for your team?"
              className="min-h-20 resize-y border-slate-700 bg-slate-950 text-sm text-slate-100 placeholder:text-slate-500"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="submit"
              disabled={busy || !choice}
              className="h-9 rounded-lg bg-sky-500 px-3 text-xs text-white hover:bg-sky-400"
            >
              {busy ? "Sending…" : "Send proposal"}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={close}
              className="h-9 rounded-lg border-slate-700 bg-slate-950 px-3 text-xs text-slate-200"
            >
              Done
            </Button>
          </div>
        </form>
      )}
      <MessageLine message={message} />
    </section>
  );
}
