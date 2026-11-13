"use client";

import { useState } from "react";
import type { GitTeamStatusRules } from "@/lib/cloud-git-contract";
import { gitStatusEvents, type GitStatusEvent } from "@/lib/git-automation";
import { Select } from "@/components/ui/select";
import { cloudRequest } from "./api-client";
import { useToast } from "./toast";

const eventLabels: Record<GitStatusEvent, string> = {
  draft: "Draft opened",
  open: "Opened",
  approved: "Approved",
  merged: "Merged into default branch",
};
const noChange = "";

export function GitStatusRules({
  automations,
  onChanged,
}: {
  automations: GitTeamStatusRules[];
  onChanged: () => Promise<void>;
}) {
  const toast = useToast();
  const [saving, setSaving] = useState<string | null>(null);
  if (!automations.length) return null;
  return (
    <section
      className="cloud-settings-section"
      aria-labelledby="git-status-rules-heading"
    >
      <header>
        <h2 id="git-status-rules-heading">Status automation</h2>
      </header>
      <div className="cloud-github-automations">
        {automations.map((automation) => (
          <fieldset key={automation.team.id}>
            <legend>{automation.team.name}</legend>
            {gitStatusEvents.map((event) => {
              const id = `git-${automation.team.id}-${event}`;
              return (
                <label key={event} htmlFor={id}>
                  <span>{eventLabels[event]}</span>
                  <Select
                    id={id}
                    value={automation.rules[event] ?? noChange}
                    disabled={saving === id}
                    aria-busy={saving === id}
                    onChange={(change) => {
                      setSaving(id);
                      void cloudRequest("git/status-rules", {
                        method: "PUT",
                        body: {
                          teamId: automation.team.id,
                          event,
                          statusId: change.target.value || null,
                        },
                      })
                        .then(onChanged)
                        .catch((reason: Error) =>
                          toast(reason.message, "error"),
                        )
                        .finally(() => setSaving(null));
                    }}
                  >
                    <option value={noChange}>No change</option>
                    {automation.statuses.map((status) => (
                      <option key={status.id} value={status.id}>
                        {status.name}
                      </option>
                    ))}
                  </Select>
                </label>
              );
            })}
          </fieldset>
        ))}
      </div>
    </section>
  );
}
