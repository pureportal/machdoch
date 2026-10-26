"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/field";
import { FormDialog } from "@/components/form-dialog";
import type { CredentialStatus } from "@/lib/cloud-credentials-contract";
import type { SessionAccount } from "@/lib/cloud-session-contract";
import { cloudRequest, CloudRequestError, formText } from "./api-client";

export function AccountCredentials({
  account,
  credentials,
}: {
  account: SessionAccount;
  credentials: CredentialStatus;
}) {
  const [open, setOpen] = useState(false);
  if (!credentials.passwordEnabled) return null;
  return (
    <section
      className="cloud-settings-section"
      aria-labelledby="credentials-heading"
    >
      <header>
        <h2 id="credentials-heading">Sign-in</h2>
        <Button type="button" variant="outline" onClick={() => setOpen(true)}>
          Edit sign-in
        </Button>
      </header>
      <FormDialog
        open={open}
        onOpenChange={setOpen}
        title="Sign-in details"
        submitLabel="Save sign-in details"
        onSubmit={async (form) => {
          try {
            await cloudRequest("account/credentials", {
              method: "PUT",
              body: {
                account,
                currentPassword: formText(form, "currentPassword"),
                newPassword: formText(form, "newPassword"),
                ...(credentials.username === null
                  ? {}
                  : { username: formText(form, "username") }),
              },
            });
            location.assign("/cloud/login");
          } catch (error) {
            if (error instanceof CloudRequestError && error.status === 401)
              location.assign("/cloud/login");
            else throw error;
          }
        }}
      >
        {credentials.username !== null && (
          <Field label="Username" htmlFor="account-username">
            <Input
              id="account-username"
              name="username"
              autoComplete="username"
              maxLength={128}
              defaultValue={credentials.username}
              required
            />
          </Field>
        )}
        <Field label="Current password" htmlFor="current-password">
          <Input
            id="current-password"
            name="currentPassword"
            type="password"
            autoComplete="current-password"
            maxLength={1024}
            required
          />
        </Field>
        <Field label="New password" htmlFor="new-password">
          <Input
            id="new-password"
            name="newPassword"
            type="password"
            autoComplete="new-password"
            minLength={12}
            maxLength={1024}
            required
          />
        </Field>
        <p>Saving signs you out of all browsers and connected apps.</p>
      </FormDialog>
    </section>
  );
}
