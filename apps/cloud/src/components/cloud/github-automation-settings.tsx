"use client";

import { useState } from "react";
import type { GitHubTeamAutomation } from "@/lib/cloud-github-contract";
import {
  githubAutomationEvents,
  type GitHubAutomationEvent,
} from "@/lib/github-automation";
import { Select } from "@/components/ui/select";
import { cloudRequest } from "./api-client";
import { useToast } from "./toast";

const eventLabels: Record<GitHubAutomationEvent, string> = {
  draft: "Draft opened",
  open: "Opened",
  approved: "Approved",
  merged: "Merged",
};
const noChange = "";

export function GitHubAutomationSettings({
  automations,
  onChanged,
}: {
  automations: GitHubTeamAutomation[];
  onChanged: () => Promise<void>;
}) {
  const toast = useToast();
  const [saving, setSaving] = useState<string | null>(null);
  if (!automations.length) return null;
  return (
    <section aria-labelledby="github-automations-heading">
      <h3 id="github-automations-heading" className="text-sm font-medium">
        Status automation
      </h3>
      <div className="cloud-github-automations">
        {automations.map((automation) => (
          <fieldset key={automation.team.id}>
            <legend>{automation.team.name}</legend>
            {githubAutomationEvents.map((event) => {
              const id = `github-${automation.team.id}-${event}`;
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
                      void cloudRequest("github/automations", {
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
