"use client";

import { useEffect, useRef, useState } from "react";
import type {
  CloudEmailAdministration,
  CloudEmailSettings,
  MailFailureCode,
} from "@/lib/cloud-email-contract";
import { Field } from "@/components/field";
import { FormDialog } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  CloudRequestError,
  cloudRequest,
  createCommandSender,
  formText,
} from "./api-client";

const failures: Record<MailFailureCode, string> = {
  authentication:
    "The server rejected the credentials. Check the username and password.",
  connection:
    "The server could not be reached securely. Check the host, port and TLS settings.",
  timeout: "Delivery timed out. Check the email server.",
  recipient:
    "The server rejected a recipient. Check the email addresses and server policy.",
  failed: "Delivery failed. Check the email settings.",
};
export function EmailSettings({ owner }: { owner: boolean }) {
  const [data, setData] = useState<CloudEmailAdministration | null>(null);
  const [editing, setEditing] = useState<CloudEmailSettings | null | undefined>(
    undefined,
  );
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const [verified, setVerified] = useState(false);
  const [reload, setReload] = useState(0);
  const sender = useRef(createCommandSender());
  const check = useRef<AbortController | null>(null);
  useEffect(() => () => check.current?.abort(), []);
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    setVerified(false);
    void cloudRequest<CloudEmailAdministration>("email-settings", {
      signal: controller.signal,
    })
      .then((value) => {
        if (!controller.signal.aborted) setData(value);
      })
      .catch((reason: Error) => {
        if (!controller.signal.aborted) setError(reason.message);
      });
    return () => {
      controller.abort();
    };
  }, [reload]);
  const settings = data?.settings;
  if (!owner && !settings && !error) return null;
  return (
    <section
      className="cloud-settings-section"
      aria-labelledby="email-settings-heading"
    >
      <header>
        <h2 id="email-settings-heading">Email sign-in</h2>
        {owner && (
          <Button
            variant="outline"
            disabled={!data?.credentialStorageAvailable || checking}
            aria-busy={!data && !error}
            onClick={() => {
              sender.current = createCommandSender();
              setEditing(data?.settings ?? null);
            }}
          >
            {!data && !error
              ? "Loading…"
              : settings
                ? "Edit email settings"
                : "Configure email"}
          </Button>
        )}
      </header>
      {owner && data && !data.credentialStorageAvailable && (
        <p>Configure credential storage before adding an email server.</p>
      )}
      {settings && (
        <>
          <dl className="cloud-properties">
            <div>
              <dt>Sender</dt>
              <dd>{settings.from}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>{settings.enabled ? "Enabled" : "Disabled"}</dd>
            </div>
          </dl>
          <Button
            variant="outline"
            aria-disabled={checking}
            aria-busy={checking}
            onClick={() => {
              if (check.current) return;
              const controller = new AbortController();
              check.current = controller;
              setChecking(true);
              setError("");
              setVerified(false);
              void cloudRequest("email-settings/verify", {
                method: "POST",
                body: { revision: settings.revision },
                signal: controller.signal,
              })
                .then(() => {
                  if (!controller.signal.aborted) setVerified(true);
                })
                .catch((reason: Error) => {
                  if (!controller.signal.aborted) setError(reason.message);
                })
                .finally(() => {
                  if (!controller.signal.aborted) {
                    setChecking(false);
                    check.current = null;
                  }
                });
            }}
          >
            {checking ? "Checking…" : "Check connection"}
          </Button>
        </>
      )}
      {verified && <p role="status">Connection verified</p>}
      {data?.failedDeliveries ? (
        <p role="alert" className="cloud-error">
          {data.failedDeliveries} failed deliveries.{" "}
          {data.lastError
            ? failures[data.lastError]
            : "Check the email settings."}
        </p>
      ) : null}
      {error && (
        <p role="alert" className="cloud-error">
          {error}
        </p>
      )}
      {error && (
        <Button
          variant="outline"
          onClick={() => setReload((value) => value + 1)}
        >
          Reload email settings
        </Button>
      )}
      <FormDialog
        title="Email sign-in"
        submitLabel="Save email settings"
        open={owner && editing !== undefined}
        onOpenChange={(open) => {
          if (!open) {
            setEditing(undefined);
            sender.current = createCommandSender();
          }
        }}
        onSubmit={async (form) => {
          if (editing === undefined) return;
          const password = formText(form, "password");
          try {
            await sender.current(
              "email-settings",
              {
                revision: editing?.revision ?? 0,
                host: formText(form, "host"),
                port: Number(formText(form, "port")),
                security: formText(form, "security"),
                tlsName: formText(form, "tlsName") || null,
                username: formText(form, "username") || null,
                ...(password ? { password } : {}),
                from: formText(form, "from"),
                enabled: form.get("enabled") === "on",
              },
              "PATCH",
            );
          } catch (reason) {
            if (
              reason instanceof CloudRequestError &&
              reason.code === "revision_conflict"
            ) {
              setData(
                await cloudRequest<CloudEmailAdministration>("email-settings"),
              );
              throw new Error(
                "Email settings changed. Close and reopen them to review the latest version.",
              );
            }
            throw reason;
          }
          setData(
            await cloudRequest<CloudEmailAdministration>("email-settings"),
          );
          setVerified(false);
          setError("");
        }}
      >
        <Field label="Host" htmlFor="email-host">
          <Input
            id="email-host"
            name="host"
            required
            maxLength={253}
            defaultValue={editing?.host ?? ""}
          />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Port" htmlFor="email-port">
            <Input
              id="email-port"
              name="port"
              type="number"
              required
              min={1}
              max={65535}
              defaultValue={editing?.port ?? 587}
            />
          </Field>
          <Field label="Encryption" htmlFor="email-security">
            <Select
              id="email-security"
              name="security"
              defaultValue={editing?.security ?? "starttls"}
            >
              <option value="starttls">STARTTLS</option>
              <option value="tls">TLS</option>
            </Select>
          </Field>
        </div>
        <Field label="Username" htmlFor="email-username">
          <Input
            id="email-username"
            name="username"
            maxLength={254}
            autoComplete="off"
            defaultValue={editing?.username ?? ""}
          />
        </Field>
        <Field
          label="Password"
          htmlFor="email-password"
          hint={
            editing?.hasPassword
              ? "Leave blank to keep the current password."
              : undefined
          }
        >
          <Input
            id="email-password"
            name="password"
            type="password"
            maxLength={4096}
            autoComplete="new-password"
          />
        </Field>
        <Field label="Sender address" htmlFor="email-from">
          <Input
            id="email-from"
            name="from"
            type="email"
            required
            maxLength={254}
            defaultValue={editing?.from ?? ""}
          />
        </Field>
        <details open={!!editing?.tlsName}>
          <summary>TLS name</summary>
          <Field label="Certificate hostname" htmlFor="email-tls-name">
            <Input
              id="email-tls-name"
              name="tlsName"
              maxLength={253}
              defaultValue={editing?.tlsName ?? ""}
            />
          </Field>
        </details>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            name="enabled"
            defaultChecked={editing?.enabled ?? true}
          />
          Enable email sign-in
        </label>
      </FormDialog>
    </section>
  );
}
