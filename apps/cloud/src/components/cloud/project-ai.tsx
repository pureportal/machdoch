"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { ExecutionProfile } from "@machdoch/fleet-protocol/cloud-execution";
import { cloudRequest } from "./api-client";

export function ProjectAi({
  projectId,
  administrator,
}: {
  projectId: string;
  administrator: boolean;
}) {
  const [profiles, setProfiles] = useState<ExecutionProfile[] | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    cloudRequest<{ profiles: ExecutionProfile[] }>(
      `execution-profiles?projectId=${projectId}`,
      { signal: abort.signal },
    )
      .then((result) =>
        setProfiles(result.profiles.filter((profile) => profile.enabled)),
      )
      .catch(() => {
        if (!abort.signal.aborted) setProfiles([]);
      });
    return () => abort.abort();
  }, [projectId]);
  if (!profiles || (!profiles.length && !administrator)) return null;
  const setup =
    profiles.find((profile) => profile.autopilot) ?? profiles[0] ?? null;
  return (
    <section className="cloud-card cloud-project-runs">
      <header className="cloud-project-section-header">
        <h2>AI</h2>
        {administrator && (
          <Link href={`/cloud/execution?project=${projectId}`} prefetch={false}>
            {setup ? "Edit" : "Set up"}
          </Link>
        )}
      </header>
      {setup && (
        <ul>
          <li>
            <span className="cloud-project-client">
              {new URL(setup.repository).pathname.slice(1)}
            </span>
            <span
              className="cloud-state"
              data-state={setup.autopilot ? "complete" : "backlog"}
            >
              {setup.autopilot ? "Autopilot" : "Manual merge"}
            </span>
          </li>
        </ul>
      )}
    </section>
  );
}
