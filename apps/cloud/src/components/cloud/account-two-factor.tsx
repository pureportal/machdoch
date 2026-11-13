"use client";

import { LoadingState } from "@machdoch/product-ui";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { FormDialog } from "@/components/form-dialog";
import type {
  AuthenticatorSetup,
  RecoveryCodes,
  TwoFactorStatus,
} from "@/lib/cloud-two-factor-contract";
import { cloudRequest, formText } from "./api-client";
import { AuthenticatorQr } from "./authenticator-qr";
import { RecoveryCodeList } from "./recovery-code-list";
import { TwoFactorCodeField } from "./two-factor-code-field";
import { useToast } from "./toast";

const addedDate = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

export function AccountTwoFactor({ status }: { status: TwoFactorStatus }) {
  const router = useRouter();
  const toast = useToast();
  const [replacing, setReplacing] = useState(false);
  const [setup, setSetup] = useState<AuthenticatorSetup | null>(null);
  const [setupError, setSetupError] = useState("");
  const [renewing, setRenewing] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const setupRequest = useRef<AbortController | null>(null);
  useEffect(() => () => setupRequest.current?.abort(), []);
  return (
    <section
      className="cloud-settings-section"
      aria-labelledby="two-factor-heading"
    >
      <header>
        <h2 id="two-factor-heading">Two-factor authentication</h2>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={() => {
              setupRequest.current?.abort();
              const request = new AbortController();
              setupRequest.current = request;
              setReplacing(true);
              setSetup(null);
              setSetupError("");
              void cloudRequest<AuthenticatorSetup>(
                "account/two-factor/setup",
                { method: "POST", signal: request.signal },
              )
                .then((result) => {
                  if (!request.signal.aborted) setSetup(result);
                })
                .catch((reason: Error) => {
                  if (!request.signal.aborted) setSetupError(reason.message);
                });
            }}
          >
            Replace authenticator
          </Button>
          <Button variant="outline" onClick={() => setRenewing(true)}>
            New recovery codes
          </Button>
        </div>
      </header>
      <dl className="cloud-properties">
        <div>
          <dt>Authenticator app</dt>
          <dd>
            Added{" "}
            <time dateTime={status.createdAt}>
              {addedDate.format(new Date(status.createdAt))}
            </time>
          </dd>
        </div>
        <div>
          <dt>Recovery codes</dt>
          <dd className={status.recoveryCodes <= 2 ? "text-destructive" : ""}>
            {status.recoveryCodes} left
          </dd>
        </div>
      </dl>
      {codes && (
        <div className="grid gap-3">
          <p role="status">New recovery codes. They are shown only now.</p>
          <RecoveryCodeList codes={codes} />
          <Button
            variant="outline"
            className="justify-self-start"
            onClick={() => setCodes(null)}
          >
            Done
          </Button>
        </div>
      )}
      <FormDialog
        open={replacing}
        onOpenChange={(open) => {
          if (!open) setupRequest.current?.abort();
          setReplacing(open);
        }}
        title="Replace authenticator"
        submitLabel="Replace authenticator"
        submitDisabled={!setup}
        onSubmit={async (form) => {
          await cloudRequest("account/two-factor/replace", {
            method: "POST",
            body: {
              code: formText(form, "newCode"),
              currentCode: formText(form, "currentCode"),
            },
          });
          toast("Authenticator replaced.");
          router.refresh();
        }}
      >
        {setup ? (
          <AuthenticatorQr setup={setup} />
        ) : setupError ? (
          <p role="alert" className="text-sm text-destructive">
            {setupError}
          </p>
        ) : (
          <LoadingState label="Loading…" compact />
        )}
        <TwoFactorCodeField id="newCode" label="Code from new app" />
        <TwoFactorCodeField
          id="currentCode"
          label="Current code or recovery code"
          recovery
        />
        <p>Your other sessions will be signed out.</p>
      </FormDialog>
      <FormDialog
        open={renewing}
        onOpenChange={setRenewing}
        title="New recovery codes"
        submitLabel="Create codes"
        onSubmit={async (form) => {
          const result = await cloudRequest<RecoveryCodes>(
            "account/two-factor/recovery-codes",
            { method: "POST", body: { code: formText(form, "renewCode") } },
          );
          setCodes(result.recoveryCodes);
          router.refresh();
        }}
      >
        <TwoFactorCodeField
          id="renewCode"
          label="Authentication or recovery code"
          recovery
        />
        <p>Your current recovery codes will stop working.</p>
      </FormDialog>
    </section>
  );
}
