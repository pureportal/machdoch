"use client";

import { useEffect, useRef, useState } from "react";
import type {
  ExecutionProfile,
  ExecutionWorker,
  HostedRunnerStatus,
} from "@machdoch/fleet-protocol/cloud-execution";
import { Field } from "@/components/field";
import { FormDialog } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cloudRequest, createCommandSender, formText } from "./api-client";
import { Timestamp } from "./timestamp";

const hostedStateLabels: Record<HostedRunnerStatus["state"], string> = {
  running: "Running",
  stopped: "Stopped",
  failed: "Stopped",
};

function HostedState({ status }: { status: HostedRunnerStatus }) {
  return (
    <span>
      This server · {hostedStateLabels[status.state]}
      {status.error && <span className="cloud-error"> · {status.error}</span>}
    </span>
  );
}

export function ExecutionRunners({ profile }: { profile: ExecutionProfile }) {
  const sender = useRef(createCommandSender());
  const [workers, setWorkers] = useState<ExecutionWorker[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [enrolling, setEnrolling] = useState(false);
  const [revoking, setRevoking] = useState<ExecutionWorker | null>(null);
  const [rotating, setRotating] = useState<ExecutionWorker | null>(null);
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const request = useRef(0);

  async function load({ quiet = false }: { quiet?: boolean } = {}) {
    const current = ++request.current;
    if (!quiet) setLoading(true);
    try {
      const result = await cloudRequest<{ workers: ExecutionWorker[] }>(
        `execution-workers?profileId=${profile.id}`,
      );
      if (current !== request.current) return;
      setWorkers(result.workers);
      setError("");
    } catch (reason) {
      if (current === request.current) setError((reason as Error).message);
    } finally {
      if (current === request.current) setLoading(false);
    }
  }
  useEffect(() => {
    setToken("");
    void load();
  }, [profile.id]);
  const watching = workers?.some((worker) => worker.hosted && worker.enabled);
  useEffect(() => {
    if (!watching) return;
    const timer = setInterval(() => {
      if (!document.hidden) void load({ quiet: true });
    }, 5000);
    return () => clearInterval(timer);
  }, [watching, profile.id]);

  return (
    <section className="cloud-settings-section mt-8">
      <header>
        <h2>Runners for {profile.name}</h2>
        <Button
          variant="outline"
          disabled={loading}
          onClick={() => void load()}
        >
          Refresh
        </Button>
        <Button
          disabled={!profile.enabled}
          onClick={() => {
            setToken("");
            setEnrolling(true);
          }}
        >
          Add runner
        </Button>
      </header>
      {error && (
        <p role="alert" className="cloud-error">
          {error}
        </p>
      )}
      {workers && !workers.length && <p>No runners yet.</p>}
      {workers && workers.length > 0 && (
        <ul className="cloud-member-list">
          {workers.map((worker) => (
            <li key={worker.id}>
              <div>
                <strong>{worker.name}</strong>
                {worker.workspaceBinding && (
                  <span>Workspace: {worker.workspaceBinding.name}</span>
                )}
                {worker.hosted && worker.enabled && (
                  <HostedState status={worker.hosted} />
                )}
                <span>
                  {worker.enabled ? (
                    worker.lastSeenAt ? (
                      <>
                        Last seen <Timestamp value={worker.lastSeenAt} />
                      </>
                    ) : (
                      "Not connected"
                    )
                  ) : (
                    "Revoked"
                  )}
                </span>
              </div>
              {!worker.hosted && (
                <Button
                  variant="outline"
                  disabled={!profile.enabled}
                  aria-label={`Rotate token for ${worker.name}`}
                  onClick={() => {
                    setToken("");
                    setRotating(worker);
                  }}
                >
                  Rotate token
                </Button>
              )}
              {worker.enabled && !worker.hosted && (
                <Button
                  variant="outline"
                  onClick={() => {
                    sender.current = createCommandSender();
                    setRevoking(worker);
                  }}
                >
                  Revoke runner
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {token && (
        <section className="cloud-card mt-6 max-w-xl">
          <Field label="Runner token" htmlFor="runner-token">
            <Input
              id="runner-token"
              type="password"
              readOnly
              value={token}
              autoComplete="off"
            />
          </Field>
          <p>Save this token now. It is shown only once.</p>
          <div className="cloud-editor-actions">
            <Button
              variant="outline"
              onClick={() =>
                void navigator.clipboard
                  .writeText(token)
                  .catch(() =>
                    setError(
                      "Could not copy the token. Select and copy it from the field.",
                    ),
                  )
              }
            >
              Copy token
            </Button>
            <Button variant="ghost" onClick={() => setToken("")}>
              Dismiss
            </Button>
          </div>
        </section>
      )}
      <FormDialog
        open={enrolling}
        onOpenChange={setEnrolling}
        title="Add runner"
        submitLabel="Add runner"
        onSubmit={async (form) => {
          const result = await cloudRequest<{ token: string }>(
            "execution-workers",
            {
              method: "POST",
              body: {
                profileId: profile.id,
                name: formText(form, "name"),
              },
            },
          );
          setToken(result.token);
          await load();
        }}
      >
        <Field label="Name" htmlFor="runner-name">
          <Input id="runner-name" name="name" required maxLength={120} />
        </Field>
      </FormDialog>
      <FormDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) setRevoking(null);
        }}
        title="Revoke runner"
        submitLabel="Revoke runner"
        onSubmit={async () => {
          if (!revoking) return;
          await sender.current(`execution-workers/${revoking.id}/revoke`, {});
          setToken("");
          await load();
        }}
      >
        <p>
          This runner will lose permission to claim or continue tasks. Active
          tasks will wait for confirmation that it stopped.
        </p>
      </FormDialog>
      <FormDialog
        open={rotating !== null}
        onOpenChange={(open) => {
          if (!open) setRotating(null);
        }}
        title="Rotate runner token"
        submitLabel="Rotate token"
        onSubmit={async () => {
          if (!rotating) return;
          const result = await cloudRequest<{ token: string }>(
            `execution-workers/${rotating.id}/rotate`,
            { method: "POST", body: {} },
          );
          setToken(result.token);
          await load();
        }}
      >
        <p>
          The old token will stop working and active tasks will be asked to
          stop.
        </p>
      </FormDialog>
    </section>
  );
}
