"use client";

import { Plus, RefreshCw, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { CopyField } from "@/components/copy-field";
import { Field } from "@/components/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import type { CloudWorkspace } from "@/lib/cloud-contract";
import {
  requestChannelLabels,
  type CloudCustomer,
  type RequestChannelSecret,
  type RequestIntakeSettings,
} from "@/lib/cloud-customer-request-contract";
import { cloudRequest } from "./api-client";
import { useToast } from "./toast";

function useAction() {
  const router = useRouter();
  const toast = useToast();
  const [pending, setPending] = useState("");
  async function run(key: string, action: () => Promise<unknown>) {
    setPending(key);
    try {
      await action();
      router.refresh();
      return true;
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "Try again.", "error");
      return false;
    } finally {
      setPending("");
    }
  }
  return { pending, run };
}

export function CustomerRequestSettings({
  workspace,
  settings,
  customers,
  writable,
}: {
  workspace: CloudWorkspace;
  settings: RequestIntakeSettings | null;
  customers: CloudCustomer[];
  writable: boolean;
}) {
  return (
    <div className="cloud-settings">
      {settings && <IntakeSettings workspace={workspace} settings={settings} />}
      <CustomerList customers={customers} writable={writable} />
    </div>
  );
}

function IntakeSettings({
  workspace,
  settings,
}: {
  workspace: CloudWorkspace;
  settings: RequestIntakeSettings;
}) {
  const { pending, run } = useAction();
  const [secret, setSecret] = useState<RequestChannelSecret | null>(null);
  return (
    <section
      className="cloud-settings-section"
      aria-labelledby="customer-request-intake"
    >
      <header>
        <h2 id="customer-request-intake">Intake</h2>
      </header>
      <Field label="Triage team" htmlFor="customer-request-team">
        <Select
          id="customer-request-team"
          value={settings.teamId ?? ""}
          disabled={pending === "team"}
          onChange={(event) => {
            const teamId = event.target.value;
            void run("team", () =>
              cloudRequest("customer-requests/settings", {
                method: "PUT",
                body: { teamId },
              }),
            );
          }}
        >
          <option value="" disabled>
            Choose team
          </option>
          {workspace.teams.map((team) => (
            <option key={team.id} value={team.id}>
              {team.name}
            </option>
          ))}
        </Select>
      </Field>
      <ul className="cloud-member-list">
        {settings.channels.map((state) => (
          <li key={state.channel}>
            <div>
              <strong>{requestChannelLabels[state.channel]}</strong>
            </div>
            <Button
              variant="ghost"
              size="sm"
              disabled={pending === state.channel}
              onClick={() =>
                void run(state.channel, async () =>
                  setSecret(
                    await cloudRequest<RequestChannelSecret>(
                      `customer-requests/channels/${state.channel}/secret`,
                      { method: "POST" },
                    ),
                  ),
                )
              }
            >
              <RefreshCw />
              {state.configured ? "Rotate secret" : "Create secret"}
            </Button>
            <Label className="cloud-automation-check">
              <input
                type="checkbox"
                checked={state.enabled}
                disabled={pending === state.channel}
                onChange={(event) => {
                  const enabled = event.target.checked;
                  void run(state.channel, () =>
                    cloudRequest(
                      `customer-requests/channels/${state.channel}`,
                      {
                        method: "PATCH",
                        body: { enabled },
                      },
                    ),
                  );
                }}
              />
              On
            </Label>
          </li>
        ))}
      </ul>
      {secret && (
        <div className="grid gap-3" role="status">
          <CopyField label="URL" value={secret.url} monospace />
          <CopyField label="Secret" value={secret.secret} monospace />
          <div className="cloud-release-actions">
            <Button variant="ghost" onClick={() => setSecret(null)}>
              Done
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

function CustomerList({
  customers,
  writable,
}: {
  customers: CloudCustomer[];
  writable: boolean;
}) {
  const { pending, run } = useAction();
  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const domain = String(data.get("domain") ?? "").trim();
    if (
      await run("add", () =>
        cloudRequest("customers", {
          method: "POST",
          body: {
            name: String(data.get("name") ?? ""),
            domain: domain || null,
          },
        }),
      )
    )
      form.reset();
  }
  return (
    <section className="cloud-settings-section" aria-labelledby="customer-list">
      <header>
        <h2 id="customer-list">Customers</h2>
      </header>
      {customers.length > 0 && (
        <ul className="cloud-member-list">
          {customers.map((customer) => (
            <li key={customer.id}>
              <div>
                <strong>{customer.name}</strong>
                {customer.domain && <span>{customer.domain}</span>}
              </div>
              <span>
                {customer.requestCount === 1
                  ? "1 request"
                  : `${customer.requestCount} requests`}
              </span>
              {writable && (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Delete ${customer.name}`}
                  disabled={pending === customer.id}
                  onClick={() =>
                    void run(customer.id, () =>
                      cloudRequest(`customers/${customer.id}`, {
                        method: "DELETE",
                      }),
                    )
                  }
                >
                  <Trash2 />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {writable && (
        <form
          className="cloud-customer-form"
          onSubmit={(event) => void add(event)}
        >
          <Field label="Name" htmlFor="customer-name">
            <Input id="customer-name" name="name" required maxLength={120} />
          </Field>
          <Field label="Domain" htmlFor="customer-domain">
            <Input
              id="customer-domain"
              name="domain"
              placeholder="example.com"
              maxLength={253}
            />
          </Field>
          <Button type="submit" variant="outline" disabled={pending === "add"}>
            <Plus />
            Add customer
          </Button>
        </form>
      )}
    </section>
  );
}
