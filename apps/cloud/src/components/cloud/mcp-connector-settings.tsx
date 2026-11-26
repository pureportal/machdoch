"use client";

import { useRef, useState, type FormEvent } from "react";
import { X } from "lucide-react";
import type { AgentMcpConnector } from "@/lib/agent-personalization";
import { Field } from "@/components/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createCommandSender, formText } from "./api-client";
import { useToast } from "./toast";

export function McpConnectorSettings({
  initial,
}: {
  initial: AgentMcpConnector[];
}) {
  const [connectors, setConnectors] = useState(initial);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const sender = useRef(createCommandSender());
  const toast = useToast();
  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setPending(true);
    setError("");
    try {
      const created = await sender.current<AgentMcpConnector>(
        "agent-personalization/connectors",
        {
          name: formText(data, "name"),
          url: formText(data, "url"),
          token: formText(data, "token") || null,
        },
      );
      setConnectors((current) =>
        [...current, created].sort((left, right) =>
          left.name.localeCompare(right.name),
        ),
      );
      form.reset();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setPending(false);
    }
  }
  async function remove(connector: AgentMcpConnector) {
    try {
      await sender.current(
        `agent-personalization/connectors/${connector.id}/remove`,
        {},
      );
      setConnectors((current) =>
        current.filter((entry) => entry.id !== connector.id),
      );
    } catch (reason) {
      toast((reason as Error).message, "error");
    }
  }
  return (
    <section className="cloud-settings-section">
      <header>
        <h2>MCP connectors</h2>
      </header>
      {connectors.length > 0 && (
        <ul className="cloud-member-list">
          {connectors.map((connector) => (
            <li key={connector.id}>
              <div>
                <strong>{connector.name}</strong>
                <span className="cloud-agent-muted">{connector.url}</span>
              </div>
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Remove ${connector.name}`}
                onClick={() => void remove(connector)}
              >
                <X size={14} aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form className="cloud-setting-form grid gap-4" onSubmit={add}>
        <Field label="Name" htmlFor="agent-connector-name">
          <Input
            id="agent-connector-name"
            name="name"
            required
            maxLength={24}
            pattern="[a-z0-9][a-z0-9\-]*"
            title="Lowercase letters, digits and hyphens"
          />
        </Field>
        <Field label="URL" htmlFor="agent-connector-url">
          <Input
            id="agent-connector-url"
            name="url"
            type="url"
            required
            maxLength={500}
          />
        </Field>
        <Field label="Token" htmlFor="agent-connector-token">
          <Input
            id="agent-connector-token"
            name="token"
            type="password"
            autoComplete="off"
            maxLength={4000}
          />
        </Field>
        {error && (
          <p role="alert" className="cloud-error">
            {error}
          </p>
        )}
        <Button type="submit" disabled={pending}>
          {pending ? "Connecting…" : "Add connector"}
        </Button>
      </form>
    </section>
  );
}
