"use client";

import { useId, useState } from "react";
import { api, jsonBody } from "@machdoch/product-ui/fleet-api";
import { Select } from "@/components/ui/select";
import {
  agentAccessModes,
  type AgentAccess,
  type AgentAccessInput,
} from "@/lib/client-access";
import { agentAccessLabels, type FleetInstance } from "./fleet-overview";

export interface ClientMember {
  id: string;
  name: string;
}

export function AgentAccessField({
  device,
  members,
  onSaved,
}: {
  device: FleetInstance;
  members: ClientMember[];
  onSaved: () => Promise<void>;
}): React.ReactElement {
  const id = useId();
  const [value, setValue] = useState<AgentAccessInput>({
    agentAccess: device.agentAccess,
    agentUsers: device.agentUsers,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  async function save(next: AgentAccessInput) {
    const previous = value;
    setValue(next);
    setSaving(true);
    setError("");
    try {
      await api(
        `/api/instances/${encodeURIComponent(device.instanceId)}/agent-access`,
        { method: "PUT", body: jsonBody(next) },
      );
      await onSaved();
    } catch (reason) {
      setValue(previous);
      setError(
        reason instanceof Error ? reason.message : "Access was not saved.",
      );
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="grid gap-3">
      <label htmlFor={id} className="text-sm font-medium">
        Who can assign agent tasks
      </label>
      <Select
        id={id}
        value={value.agentAccess}
        disabled={saving}
        onChange={(event) =>
          void save({
            agentAccess: event.target.value as AgentAccess,
            agentUsers: value.agentUsers,
          })
        }
      >
        {agentAccessModes.map((mode) => (
          <option key={mode} value={mode}>
            {agentAccessLabels[mode]}
          </option>
        ))}
      </Select>
      {value.agentAccess === "people" ? (
        <fieldset
          disabled={saving}
          className="grid max-h-48 gap-2 overflow-y-auto rounded-lg border p-3 text-sm"
        >
          <legend className="sr-only">People</legend>
          {members.map((member) => (
            <label key={member.id} className="flex items-center gap-2">
              <input
                type="checkbox"
                className="size-4"
                checked={value.agentUsers.includes(member.id)}
                onChange={(event) =>
                  void save({
                    agentAccess: "people",
                    agentUsers: event.target.checked
                      ? [...value.agentUsers, member.id]
                      : value.agentUsers.filter((user) => user !== member.id),
                  })
                }
              />
              {member.name}
            </label>
          ))}
        </fieldset>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
