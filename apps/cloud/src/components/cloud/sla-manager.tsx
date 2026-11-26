"use client";

import { LoadingState } from "@machdoch/product-ui";
import { Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CloudLabel } from "@/lib/cloud-label-contract";
import {
  slaDuration,
  slaPriorities,
  type CloudSlaPolicy,
} from "@/lib/issue-sla";
import { Field } from "@/components/field";
import { FormDialog } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  cloudRequest,
  createCommandSender,
  formReference,
  formText,
} from "./api-client";
import { priorityNames } from "./issue-properties";

function policyScope(policy: CloudSlaPolicy) {
  return (
    [policy.priority && priorityNames[policy.priority], policy.labelName]
      .filter(Boolean)
      .join(" · ") || "All issues"
  );
}

interface SlaTeam {
  id: string;
  name: string;
}

type Editing =
  | { team: SlaTeam; policy: CloudSlaPolicy; labels: null }
  | { team: SlaTeam; policy: null; labels: CloudLabel[] };

export function SlaSettings({
  teams,
  writable,
}: {
  teams: readonly SlaTeam[];
  writable: boolean;
}) {
  const [policies, setPolicies] = useState<CloudSlaPolicy[] | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [error, setError] = useState("");
  const sender = useRef(createCommandSender());
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const result = await cloudRequest<{ policies: CloudSlaPolicy[] }>("slas", {
      signal,
    });
    if (signal?.aborted) return;
    setPolicies(result.policies);
    setError("");
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal).catch((reason: Error) => {
      if (!controller.signal.aborted) setError(reason.message);
    });
    return () => controller.abort();
  }, [refresh]);
  async function remove(policy: CloudSlaPolicy) {
    try {
      await cloudRequest(`slas/${policy.id}`, { method: "DELETE" });
      await refresh();
    } catch (reason) {
      setError((reason as Error).message);
    }
  }
  async function create(team: SlaTeam) {
    try {
      const { labels } = await cloudRequest<{ labels: CloudLabel[] }>(
        `teams/${team.id}/labels`,
      );
      sender.current = createCommandSender();
      setEditing({
        team,
        policy: null,
        labels: labels.filter((label) => !label.archived),
      });
    } catch (reason) {
      setError((reason as Error).message);
    }
  }
  if (!policies && !error) return <LoadingState label="Loading SLAs…" />;
  return (
    <div className="cloud-settings">
      {error && (
        <p role="alert" className="cloud-error">
          {error}
        </p>
      )}
      {teams.map((team) => {
        const teamPolicies = (policies ?? []).filter(
          (policy) => policy.teamId === team.id,
        );
        return (
          <section
            key={team.id}
            className="cloud-settings-section"
            aria-label={team.name}
          >
            <header>
              <h2>{team.name}</h2>
              {writable && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void create(team)}
                >
                  <Plus />
                  Add
                </Button>
              )}
            </header>
            {teamPolicies.length === 0 ? (
              <p className="cloud-settings-empty">No SLAs</p>
            ) : (
              <ul className="cloud-sla-list">
                {teamPolicies.map((policy) => (
                  <li key={policy.id}>
                    {writable ? (
                      <button
                        type="button"
                        aria-label={`Edit SLA ${policyScope(policy)}`}
                        onClick={() => {
                          sender.current = createCommandSender();
                          setEditing({ team, policy, labels: null });
                        }}
                      >
                        <span>{policyScope(policy)}</span>
                        <strong>{slaDuration(policy.hours)}</strong>
                      </button>
                    ) : (
                      <span>
                        <span>{policyScope(policy)}</span>
                        <strong>{slaDuration(policy.hours)}</strong>
                      </span>
                    )}
                    {writable && (
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Delete SLA ${policyScope(policy)}`}
                        onClick={() => void remove(policy)}
                      >
                        <Trash2 />
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
      <FormDialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        title={
          editing?.policy
            ? `${editing.team.name} · ${policyScope(editing.policy)}`
            : `New SLA · ${editing?.team.name ?? ""}`
        }
        submitLabel={editing?.policy ? "Save" : "Create"}
        onSubmit={async (form) => {
          if (!editing) return;
          const hours = Number(formText(form, "hours"));
          if (editing.policy)
            await sender.current(
              `slas/${editing.policy.id}`,
              { hours },
              "PATCH",
            );
          else
            await sender.current("slas", {
              teamId: editing.team.id,
              priority: formReference(form, "priority"),
              labelId: formReference(form, "labelId"),
              hours,
            });
          await refresh();
        }}
      >
        <div className="cloud-form-grid cloud-form-grid-3">
          {editing?.labels && (
            <>
              <Field label="Priority" htmlFor="sla-priority">
                <Select name="priority" id="sla-priority">
                  <option value="">Any</option>
                  {slaPriorities.map((priority) => (
                    <option key={priority} value={priority}>
                      {priorityNames[priority]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Label" htmlFor="sla-label">
                <Select name="labelId" id="sla-label">
                  <option value="">Any</option>
                  {editing.labels.map((label) => (
                    <option key={label.id} value={label.id}>
                      {label.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </>
          )}
          <Field label="Hours" htmlFor="sla-hours">
            <Input
              name="hours"
              id="sla-hours"
              type="number"
              min={1}
              max={8760}
              required
              defaultValue={editing?.policy?.hours ?? 24}
            />
          </Field>
        </div>
      </FormDialog>
    </div>
  );
}
