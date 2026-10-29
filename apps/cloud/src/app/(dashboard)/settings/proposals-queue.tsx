"use client";

import { Inbox } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { managedMcpServerSecretReferences } from "@machdoch/fleet-protocol/managed-settings";
import { api, ApiError, jsonBody } from "@machdoch/product-ui/fleet-api";
import { ConfirmButton } from "@/components/confirm-button";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { formatTime } from "@/lib/format";
import { itemDifferences } from "@/lib/merge-settings";
import {
  renamedSettingsItem,
  sameSettingsItemContent,
  settingsItemKey,
  settingsItemLabels,
  settingsItemName,
  settingsItems,
  type SettingsItem,
} from "@/lib/settings-items";
import type { FleetManagedSettingsDocument } from "@machdoch/fleet-protocol";
import type {
  SettingsProfile,
  SettingsProfileSummary,
  SettingsProposal,
} from "./types";
import { settingsError } from "./use-settings-profiles";
import {
  fieldLabel,
  labelledFields,
  SettingsChanges,
  SettingsValuePreview,
  UnchangedFields,
} from "./settings-value-preview";

/** Lowercases a kind label for running text, keeping "MCP" intact. */
const inText = (label: string) =>
  label.replace(/^[A-Z][a-z]/u, (start) => start.toLocaleLowerCase());

export function ProposalsQueue({
  profiles,
  disabled,
  onProfile,
}: {
  profiles: SettingsProfileSummary[];
  disabled: boolean;
  onProfile: (profile: SettingsProfile) => void;
}): React.ReactElement | null {
  const [proposals, setProposals] = useState<SettingsProposal[]>([]);
  const [error, setError] = useState("");
  const requestId = useRef(0);
  const load = useCallback(async () => {
    const request = ++requestId.current;
    try {
      const payload = await api<{ proposals: SettingsProposal[] }>(
        "/api/settings/proposals",
      );
      if (request !== requestId.current) return;
      setProposals(payload.proposals);
      setError("");
    } catch (reason) {
      if (request === requestId.current) setError(settingsError(reason));
    }
  }, []);
  useEffect(() => {
    let stopped = false;
    let timer: number;
    const refresh = async (): Promise<void> => {
      await load();
      if (!stopped) timer = window.setTimeout(() => void refresh(), 30_000);
    };
    void refresh();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      requestId.current++;
    };
  }, [load]);
  if (!proposals.length && !error) return null;
  return (
    <Card className="grid min-w-0 gap-4 p-4 sm:p-5">
      <div className="grid gap-1">
        <div className="flex items-center gap-2">
          <Inbox className="size-4 shrink-0 text-muted-foreground" />
          <h2 className="font-semibold">
            Proposals from devices ({proposals.length})
          </h2>
        </div>
        <p className="text-sm text-muted-foreground">
          Users proposed their own items for the organization. Accepting adds
          the item to the profile you choose; the device keeps its copy either
          way.
        </p>
      </div>
      {error ? (
        <div className="flex flex-wrap items-center gap-3">
          <p role="alert" className="break-words text-sm text-destructive">
            {error}
          </p>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            Retry
          </Button>
        </div>
      ) : null}
      {proposals.map((proposal) => (
        <ProposalRow
          key={proposal.proposalId}
          proposal={proposal}
          profiles={profiles}
          disabled={disabled}
          onResolved={(profile) => {
            setProposals((current) =>
              current.filter((item) => item.proposalId !== proposal.proposalId),
            );
            if (profile) onProfile(profile);
            void load();
          }}
        />
      ))}
    </Card>
  );
}

function ProposalRow({
  proposal,
  profiles,
  disabled,
  onResolved,
}: {
  proposal: SettingsProposal;
  profiles: SettingsProfileSummary[];
  disabled: boolean;
  onResolved: (profile: SettingsProfile | null) => void;
}): React.ReactElement {
  const [chosenProfileId, setProfileId] = useState("");
  // Profiles may load after the queue, or the chosen one may be deleted.
  const profileId = profiles.some(
    (profile) => profile.profileId === chosenProfileId,
  )
    ? chosenProfileId
    : (profiles[0]?.profileId ?? "");
  const [loaded, setLoaded] = useState<SettingsProfile | null>(null);
  const [loadError, setLoadError] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [resolution, setResolution] = useState<"replace" | "keep-both">(
    "replace",
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const item = proposal.item as SettingsItem;
  const name = settingsItemName(proposal.kind, item);
  const kind = settingsItemLabels[proposal.kind];
  const summary = profiles.find((profile) => profile.profileId === profileId);
  const revision = summary?.revision;
  // Only a loaded profile matching the current choice and revision counts;
  // accepting another proposal into it advances the revision.
  const target =
    loaded?.profileId === profileId && loaded.revision >= (revision ?? 0)
      ? loaded
      : null;
  useEffect(() => {
    if (!profileId) return;
    const controller = new AbortController();
    setLoadError("");
    void api<{ profile: SettingsProfile }>(
      `/api/settings/profiles/${encodeURIComponent(profileId)}`,
      { signal: controller.signal },
    )
      .then(({ profile }) => {
        if (!controller.signal.aborted) setLoaded(profile);
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setLoadError(settingsError(reason));
      });
    return () => controller.abort();
  }, [profileId, revision, loadAttempt]);
  const items = target
    ? settingsItems(
        target.document as unknown as FleetManagedSettingsDocument,
        proposal.kind,
      )
    : [];
  const existing =
    items.find(
      (entry) =>
        settingsItemKey(proposal.kind, entry) ===
        settingsItemKey(proposal.kind, item),
    ) ?? null;
  const identical =
    existing !== null && sameSettingsItemContent(proposal.kind, existing, item);
  const differences = existing ? itemDifferences(existing, item) : [];
  const missingSecrets =
    proposal.kind === "mcpServer" && target
      ? managedMcpServerSecretReferences(
          item as SettingsItem<"mcpServer">,
        ).filter(
          (secretId) =>
            !target.secrets.some((secret) => secret.secretId === secretId),
        )
      : [];
  const busy = disabled || pending;
  const accept = async () => {
    setPending(true);
    setError("");
    try {
      const { profile } = await api<{ profile: SettingsProfile }>(
        `/api/settings/proposals/${encodeURIComponent(proposal.proposalId)}/accept`,
        {
          method: "POST",
          body: jsonBody({
            profileId: target!.profileId,
            expectedRevision: target!.revision,
            resolution: existing ? resolution : "add",
          }),
        },
      );
      onResolved(profile);
    } catch (reason) {
      setError(settingsError(reason));
      // The profile changed elsewhere; compare against its latest revision.
      if (reason instanceof ApiError && reason.status === 409) {
        setLoaded(null);
        setLoadAttempt((value) => value + 1);
      }
    } finally {
      setPending(false);
    }
  };
  return (
    <article
      aria-label={`${kind} ${name}`}
      className="grid min-w-0 gap-3 rounded-lg border border-border p-3"
    >
      <div className="min-w-0">
        <p className="break-words text-sm font-medium [overflow-wrap:anywhere]">
          {kind}: {name}
        </p>
        <p className="break-words text-xs text-muted-foreground [overflow-wrap:anywhere]">
          From {proposal.displayName} · {formatTime(proposal.createdAt)}
        </p>
        {proposal.note ? (
          <p className="mt-1 whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere]">
            “{proposal.note}”
          </p>
        ) : null}
      </div>
      <details className="min-w-0 rounded border border-border p-3">
        <summary className="cursor-pointer text-sm">Preview</summary>
        <div className="mt-2 max-h-72 overflow-auto text-sm">
          <SettingsValuePreview value={item} />
        </div>
      </details>
      <div className="grid min-w-0 gap-3 sm:grid-cols-[minmax(0,240px)_minmax(0,1fr)] sm:items-start">
        <div className="grid min-w-0 gap-1">
          <Select
            aria-label={`Profile for ${kind} ${name}`}
            value={profileId}
            disabled={busy || !profiles.length}
            onChange={(event) => {
              setProfileId(event.target.value);
              setError("");
            }}
          >
            {!profiles.length ? <option value="">No profiles</option> : null}
            {profiles.map((profile) => (
              <option key={profile.profileId} value={profile.profileId}>
                {profile.name}
              </option>
            ))}
          </Select>
          {!profiles.length ? (
            <p className="text-xs text-muted-foreground">
              Create a profile to accept proposals.
            </p>
          ) : null}
        </div>
        {loadError ? (
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <p role="alert" className="break-words text-sm text-destructive">
              {loadError}
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setLoadAttempt((value) => value + 1)}
            >
              Retry
            </Button>
          </div>
        ) : profileId && !target ? (
          <p role="status" className="text-sm text-muted-foreground">
            Checking {summary?.name}…
          </p>
        ) : target && existing ? (
          <fieldset
            disabled={busy}
            className="grid min-w-0 gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm"
          >
            <legend className="sr-only">
              How to add {inText(kind)} {name}
            </legend>
            <p className="break-words [overflow-wrap:anywhere]">
              {target.name} already has the {inText(kind)}{" "}
              <span className="font-medium">
                {settingsItemName(proposal.kind, existing)}
              </span>
              .
              {identical
                ? " It has the same content, so accepting changes nothing."
                : null}
            </p>
            {identical ? null : (
              <>
                <p className="text-xs text-muted-foreground">
                  Differs in: {differences.map(fieldLabel).join(", ")}
                </p>
                <UnchangedFields
                  value={existing}
                  fields={labelledFields(existing).filter(
                    (field) => !differences.includes(field),
                  )}
                />
                <div className="grid max-h-72 min-w-0 gap-1 overflow-auto">
                  <p className="text-xs text-muted-foreground">
                    Proposed changes compared with {target.name}
                  </p>
                  <SettingsChanges value={item} base={existing} />
                </div>
              </>
            )}
            {(
              [
                [
                  "replace",
                  "Replace existing",
                  "Overwrites the profile version.",
                ],
                [
                  "keep-both",
                  "Keep both",
                  `Adds the proposal as ${settingsItemName(
                    proposal.kind,
                    renamedSettingsItem(proposal.kind, item, items),
                  )}.`,
                ],
              ] as const
            ).map(([value, label, hint]) => (
              <div key={value} className="grid min-w-0 gap-0.5">
                <label className="flex w-fit items-center gap-2">
                  <input
                    type="radio"
                    name={`proposal-${proposal.proposalId}`}
                    className="size-4 accent-primary"
                    checked={resolution === value}
                    onChange={() => setResolution(value)}
                  />
                  {label}
                </label>
                <p className="ml-6 break-words text-xs text-muted-foreground [overflow-wrap:anywhere]">
                  {hint}
                </p>
              </div>
            ))}
          </fieldset>
        ) : null}
      </div>
      {missingSecrets.length && target ? (
        <p className="break-words text-xs text-muted-foreground [overflow-wrap:anywhere]">
          Uses secret{missingSecrets.length > 1 ? "s" : ""}{" "}
          {missingSecrets.join(", ")}, which {target.name} does not have yet.
          Add {missingSecrets.length > 1 ? "them" : "it"} under Secrets after
          accepting.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="break-words text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={busy || !target}
          aria-label={`Accept ${kind} ${name}`}
          onClick={() => void accept()}
        >
          {pending ? "Accepting…" : "Accept"}
        </Button>
        <ConfirmButton
          trigger={
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              aria-label={`Reject ${kind} ${name}`}
            >
              Reject
            </Button>
          }
          title={`Reject ${inText(kind)} ${name}?`}
          description={`The proposal from ${proposal.displayName} is discarded. The device keeps its own copy and can propose it again.`}
          actionLabel="Reject proposal"
          onConfirm={async () => {
            await api(
              `/api/settings/proposals/${encodeURIComponent(proposal.proposalId)}/reject`,
              { method: "POST", body: jsonBody({}) },
            );
            onResolved(null);
          }}
        />
      </div>
    </article>
  );
}
