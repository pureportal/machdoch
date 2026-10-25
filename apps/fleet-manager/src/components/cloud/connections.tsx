"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/field";
import {
  cloudOAuthScopeLabels,
  type CloudConnectedApp,
} from "@/lib/cloud-oauth-contract";
import { cloudRequest } from "./api-client";

export function CloudConnections({
  connections,
  origin,
}: {
  connections: CloudConnectedApp[];
  origin: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");
  return (
    <>
      <header className="cloud-page-header">
        <h1>Connected apps</h1>
      </header>
      <section className="cloud-connection-setup">
        <Field label="MCP URL" htmlFor="mcp-url">
          <Input
            id="mcp-url"
            readOnly
            value={`${origin}/api/v1/mcp`}
            onFocus={(event) => event.target.select()}
          />
        </Field>
        <Field label="Machdoch client ID" htmlFor="mcp-client">
          <Input id="mcp-client" readOnly value="machdoch-client" />
        </Field>
      </section>
      {error && (
        <p role="alert" className="cloud-error">
          {error}
        </p>
      )}
      {!connections.length && <p className="cloud-empty">No connected apps.</p>}
      <div className="cloud-connections">
        {connections.map((connection) => (
          <article key={connection.id}>
            <div>
              <h2>{connection.clientName}</h2>
              <ul>
                {connection.scopes.map((scope) => (
                  <li key={scope}>{cloudOAuthScopeLabels[scope]}</li>
                ))}
              </ul>
              <p>
                Connected{" "}
                <time dateTime={connection.createdAt}>
                  {new Date(connection.createdAt).toLocaleString()}
                </time>
              </p>
            </div>
            <Button
              variant="outline"
              disabled={pending !== null}
              onClick={() => {
                setPending(connection.id);
                setError("");
                void cloudRequest(`connections/${connection.id}/revoke`, {
                  method: "POST",
                })
                  .then(() => router.refresh())
                  .catch((reason: Error) => setError(reason.message))
                  .finally(() => setPending(null));
              }}
            >
              {pending === connection.id ? "Disconnecting…" : "Disconnect"}
            </Button>
          </article>
        ))}
      </div>
    </>
  );
}
