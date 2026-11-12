"use client";

import { Select } from "@/components/ui/select";
import type { AutomationAction } from "@/lib/cloud-automation-contract";
import type { ClientTarget } from "./use-automation-options";

type ClientAction = Extract<AutomationAction, { kind: "start_client_session" }>;

const separator = "\u0000";

function targetKey(target: { instanceId: string; workspace: string }) {
  return `${target.instanceId}${separator}${target.workspace}`;
}

export function ClientTargetSelect({
  action,
  clients,
  loaded,
  onChange,
}: {
  action: ClientAction;
  clients: ClientTarget[];
  loaded: boolean;
  onChange: (action: ClientAction) => void;
}) {
  const current = action.instanceId ? targetKey(action) : "";
  const missing =
    current && !clients.some((client) => targetKey(client) === current);
  return (
    <Select
      aria-label="Client"
      value={current}
      disabled={!loaded}
      onChange={(event) => {
        const [instanceId = "", workspace = ""] =
          event.target.value.split(separator);
        onChange({ ...action, instanceId, workspace });
      }}
    >
      <option value="" disabled>
        {!loaded
          ? "Loading…"
          : clients.length
            ? "Choose a client"
            : "No client is online"}
      </option>
      {missing && <option value={current}>Offline client</option>}
      {clients.map((client) => (
        <option key={targetKey(client)} value={targetKey(client)}>
          {client.label}
        </option>
      ))}
    </Select>
  );
}
