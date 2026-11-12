"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import {
  mimoriiLogsUrl,
  type MimoriiAdministration,
  type MimoriiSettings as MimoriiConnection,
} from "@/lib/cloud-activity-contract";
import { ConfirmButton } from "@/components/confirm-button";
import { Field } from "@/components/field";
import { FormDialog } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  CloudRequestError,
  cloudRequest,
  createCommandSender,
  formText,
} from "./api-client";
import { RelativeTime } from "./relative-time";

const numberFormat = new Intl.NumberFormat("en");

export function MimoriiSettings() {
  const [data, setData] = useState<MimoriiAdministration | null>(null);
  const [editing, setEditing] = useState<MimoriiConnection | null | undefined>(
    undefined,
  );
  const [testing, setTesting] = useState(false);
  const [tested, setTested] = useState(false);
  const [error, setError] = useState("");
  const sender = useRef(createCommandSender());
  async function load() {
    setData(await cloudRequest<MimoriiAdministration>("mimorii"));
  }
  useEffect(() => {
    const controller = new AbortController();
    const refresh = () =>
      cloudRequest<MimoriiAdministration>("mimorii", {
        signal: controller.signal,
      })
        .then((value) => {
          if (!controller.signal.aborted) setData(value);
        })
        .catch((reason: Error) => {
          if (!controller.signal.aborted) setError(reason.message);
        });
    void refresh();
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 15_000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, []);
  const settings = data?.settings;
  return (
    <section
      className="cloud-settings-section"
      aria-labelledby="mimorii-heading"
    >
      <header>
        <h2 id="mimorii-heading">Mimorii</h2>
        <Button
          variant="outline"
          disabled={!data?.credentialStorageAvailable}
          aria-busy={!data && !error}
          onClick={() => {
            sender.current = createCommandSender();
            setEditing(settings ?? null);
          }}
        >
          {!data && !error
            ? "Loading…"
            : settings
              ? "Edit connection"
              : "Connect Mimorii"}
        </Button>
      </header>
      {data && !data.credentialStorageAvailable && (
        <p>Configure credential storage before connecting Mimorii.</p>
      )}
      {settings && (
        <>
          <dl className="cloud-mimorii-status">
            <div>
              <dt>Address</dt>
              <dd>{settings.url}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>{settings.enabled ? "Sending AI activity" : "Paused"}</dd>
            </div>
            <div>
              <dt>Last delivery</dt>
              <dd>
                {settings.deliveredAt ? (
                  <RelativeTime value={settings.deliveredAt} />
                ) : (
                  "Not yet"
                )}
              </dd>
            </div>
            <div>
              <dt>Delivered</dt>
              <dd>{numberFormat.format(settings.deliveredEntries)}</dd>
            </div>
            <div>
              <dt>Waiting</dt>
              <dd>{numberFormat.format(settings.pending)}</dd>
            </div>
            {settings.rejectedEntries > 0 && (
              <div>
                <dt>Rejected</dt>
                <dd>{numberFormat.format(settings.rejectedEntries)}</dd>
              </div>
            )}
          </dl>
          {settings.lastError && (
            <p role="alert" className="cloud-error">
              {settings.lastError}
              {settings.retryAt && " Retrying automatically."}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              aria-disabled={testing}
              aria-busy={testing}
              onClick={() => {
                if (testing) return;
                setTesting(true);
                setTested(false);
                setError("");
                void cloudRequest("mimorii/test", { method: "POST", body: {} })
                  .then(() => setTested(true))
                  .catch((reason: Error) => setError(reason.message))
                  .finally(() => setTesting(false));
              }}
            >
              {testing ? "Sending…" : "Send test entry"}
            </Button>
            <Button variant="outline" asChild>
              <a
                href={mimoriiLogsUrl(settings.url)}
                target="_blank"
                rel="noreferrer"
              >
                Open logs in Mimorii
                <ArrowUpRight />
              </a>
            </Button>
            <ConfirmButton
              trigger={<Button variant="ghost">Disconnect</Button>}
              title="Disconnect Mimorii"
              description="AI activity stops being sent to Mimorii. Entries Mimorii already received stay there."
              actionLabel="Disconnect"
              onConfirm={async () => {
                await cloudRequest("mimorii", {
                  method: "DELETE",
                  body: { revision: settings.revision },
                });
                setTested(false);
                await load();
              }}
            />
          </div>
        </>
      )}
      {tested && <p role="status">Mimorii received the test entry.</p>}
      {error && (
        <p role="alert" className="cloud-error">
          {error}
        </p>
      )}
      <FormDialog
        title={settings ? "Edit Mimorii connection" : "Connect Mimorii"}
        submitLabel="Save connection"
        open={editing !== undefined}
        onOpenChange={(open) => {
          if (!open) {
            setEditing(undefined);
            sender.current = createCommandSender();
          }
        }}
        onSubmit={async (form) => {
          if (editing === undefined) return;
          const token = formText(form, "token");
          try {
            await sender.current(
              "mimorii",
              {
                revision: editing?.revision ?? 0,
                url: formText(form, "url"),
                ...(token ? { token } : {}),
                enabled: form.get("enabled") === "on",
              },
              "PUT",
            );
          } catch (reason) {
            if (
              reason instanceof CloudRequestError &&
              reason.code === "revision_conflict"
            ) {
              await load();
              throw new Error(
                "The connection changed. Close and reopen it to review the latest version.",
              );
            }
            throw reason;
          }
          setTested(false);
          setError("");
          await load();
        }}
      >
        <Field label="Mimorii address" htmlFor="mimorii-url">
          <Input
            id="mimorii-url"
            name="url"
            type="url"
            required
            maxLength={300}
            defaultValue={editing?.url ?? "https://mimorii.app"}
          />
        </Field>
        <Field
          label="Log source token"
          htmlFor="mimorii-token"
          hint={
            editing
              ? `Leave blank to keep ${editing.tokenPrefix}… for this address.`
              : "Create a log source in Mimorii and paste its token."
          }
        >
          <Input
            id="mimorii-token"
            name="token"
            type="password"
            required={!editing}
            maxLength={260}
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            name="enabled"
            defaultChecked={editing?.enabled ?? true}
          />
          Send AI activity
        </label>
      </FormDialog>
    </section>
  );
}
