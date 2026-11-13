"use client";

import { useState } from "react";
import { Folder } from "lucide-react";
import { FormDialog } from "@/components/form-dialog";
import type { FleetDeviceStatus } from "@/lib/fleet-status";
import type { FleetSessionTarget } from "@/lib/fleet-session-routing";
import { displayPath, workspaceName } from "./workspace-overview";

const maximumTargets = 16;

const targetKey = (target: FleetSessionTarget): string =>
  `${target.instanceId}\n${target.workspace}`;

export function NewSessionDialog({
  open,
  onOpenChange,
  devices,
  onStart,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  devices: FleetDeviceStatus[];
  onStart: (targets: FleetSessionTarget[]) => Promise<void>;
}): React.ReactElement {
  const [targets, setTargets] = useState<FleetSessionTarget[]>([]);
  const selected = new Set(targets.map(targetKey));

  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setTargets([]);
        onOpenChange(next);
      }}
      title="New session"
      submitLabel={
        targets.length > 1 ? "Start on least-busy device" : "Start session"
      }
      submitDisabled={!targets.length}
      pendingLabel="Starting…"
      onSubmit={() => onStart(targets)}
    >
      <div className="grid max-h-[min(60dvh,520px)] gap-4 overflow-y-auto">
        {devices.map((device) => (
          <fieldset key={device.instanceId} className="grid gap-1">
            <legend className="mb-1 text-xs font-medium text-muted-foreground">
              {device.displayName}
            </legend>
            {[...device.workspaces]
              .sort((left, right) =>
                workspaceName(left).localeCompare(workspaceName(right)),
              )
              .map((workspace) => {
                const target = {
                  instanceId: device.instanceId,
                  workspace: workspace.root,
                };
                const checked = selected.has(targetKey(target));
                return (
                  <label
                    key={workspace.root}
                    className="flex min-w-0 cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-muted/50 has-[:checked]:bg-primary/5"
                  >
                    <input
                      type="checkbox"
                      className="accent-[var(--primary)]"
                      checked={checked}
                      disabled={!checked && targets.length >= maximumTargets}
                      onChange={(event) =>
                        setTargets((current) =>
                          event.target.checked
                            ? [...current, target]
                            : current.filter(
                                (entry) =>
                                  targetKey(entry) !== targetKey(target),
                              ),
                        )
                      }
                    />
                    <Folder
                      className="size-4 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <span className="grid min-w-0">
                      <span className="truncate text-sm font-medium">
                        {workspaceName(workspace)}
                      </span>
                      <span className="truncate font-mono text-[11px] text-muted-foreground">
                        {displayPath(workspace.root)}
                      </span>
                    </span>
                  </label>
                );
              })}
          </fieldset>
        ))}
      </div>
    </FormDialog>
  );
}
