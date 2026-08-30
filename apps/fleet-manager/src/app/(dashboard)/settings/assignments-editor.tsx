"use client";

import { Badge } from "@/components/ui/badge";
import { Select } from "@/components/ui/select";
import { api, jsonBody } from "@/lib/api";
import { formatTime } from "@/lib/format";
import type { SettingsAssignment, SettingsProfileSummary } from "./types";

export function AssignmentsEditor({
  profiles,
  assignments,
  onRefresh,
  onError,
}: {
  profiles: SettingsProfileSummary[];
  assignments: SettingsAssignment[];
  onRefresh: () => Promise<void>;
  onError: (message: string) => void;
}): React.ReactElement {
  return (
    <div className="grid gap-4">
      <h3 className="font-medium">Instances</h3>
      {assignments.length ? (
        assignments.map((assignment) => (
          <div
            key={assignment.instanceId}
            className="grid gap-3 rounded-lg border border-border p-4 md:grid-cols-[1fr_220px] md:items-center"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <p className="truncate text-sm font-medium">
                  {assignment.displayName}
                </p>
                <Badge variant={assignment.instanceStatus}>
                  {assignment.instanceStatus}
                </Badge>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {assignment.lastFetchedAt
                  ? `Fetched revision ${assignment.lastFetchedRevision} · ${formatTime(assignment.lastFetchedAt)}`
                  : "Not fetched"}
              </p>
            </div>
            <Select
              value={assignment.profileId ?? ""}
              disabled={assignment.instanceStatus === "revoked"}
              aria-label={`Profile for ${assignment.displayName}`}
              onChange={(event) => {
                const profileId = event.target.value || null;
                void api(
                  `/api/settings/instances/${encodeURIComponent(assignment.instanceId)}/assignment`,
                  { method: "PUT", body: jsonBody({ profileId }) },
                )
                  .then(onRefresh)
                  .catch((reason: unknown) =>
                    onError(
                      reason instanceof Error
                        ? reason.message
                        : "Assignment failed.",
                    ),
                  );
              }}
            >
              <option value="">Not assigned</option>
              {profiles.map((profile) => (
                <option key={profile.profileId} value={profile.profileId}>
                  {profile.name}
                </option>
              ))}
            </Select>
          </div>
        ))
      ) : (
        <p className="py-10 text-center text-sm text-muted-foreground">
          No instances.
        </p>
      )}
    </div>
  );
}
