"use client";

import { useEffect, useRef, useState } from "react";
import type { InvitationOptions } from "@/lib/cloud-invitation-contract";
import type { CloudRoleRecord } from "@/lib/cloud-administration-contract";
import { Field } from "@/components/field";
import { FormDialog } from "@/components/form-dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import {
  CloudRequestError,
  cloudRequest,
  createCommandSender,
  formText,
} from "./api-client";

export function InvitationEditor({
  organizationId,
  roles,
  teams,
  onClose,
  onCreated,
}: {
  organizationId: string;
  roles: CloudRoleRecord[];
  teams: { id: string; name: string }[];
  onClose: () => void;
  onCreated: (url: string) => void;
}) {
  const invitable = roles.filter((role) => role.key !== "owner");
  const [options, setOptions] = useState<InvitationOptions | null>(null);
  const [method, setMethod] = useState("password");
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const sender = useRef(createCommandSender());
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    setOptions(null);
    void cloudRequest<InvitationOptions>("invitations/options", {
      signal: controller.signal,
    })
      .then((value) => {
        if (!controller.signal.aborted) {
          setOptions(value);
          setMethod((selected) =>
            (selected === "password" && !value.requiredSso) ||
            value.providers.some((provider) => provider.id === selected)
              ? selected
              : "",
          );
        }
      })
      .catch((reason: Error) => {
        if (!controller.signal.aborted) setError(reason.message);
      });
    return () => controller.abort();
  }, [reload]);
  return (
    <FormDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Invite member"
      submitLabel="Create invitation"
      submitDisabled={
        !options?.credentialStorageAvailable ||
        (options.requiredSso && !options.providers.length)
      }
      onSubmit={async (form) => {
        if (!options?.credentialStorageAvailable)
          throw new Error(
            "Configure credential storage before creating invitations.",
          );
        if (!method) throw new Error("Choose a sign-in provider.");
        let result: { url: string };
        try {
          result = await sender.current<{ url: string }>("invitations", {
            organizationId,
            email: formText(form, "email"),
            role: formText(form, "role"),
            teamIds: form.getAll("teamIds").map(String),
            authentication:
              method === "password"
                ? { kind: "password" }
                : {
                    kind: "oidc",
                    providerId: method,
                    subject: formText(form, "subject"),
                  },
          });
        } catch (reason) {
          if (
            reason instanceof CloudRequestError &&
            ["sso_required", "sso_test_required"].includes(reason.code)
          )
            setReload((value) => value + 1);
          throw reason;
        }
        onCreated(result.url);
      }}
    >
      <Field label="Email" htmlFor="invite-email">
        <Input
          id="invite-email"
          name="email"
          type="email"
          required
          maxLength={254}
        />
      </Field>
      <Field label="Role" htmlFor="invite-role">
        <Select
          id="invite-role"
          name="role"
          defaultValue={
            invitable.some((role) => role.key === "member")
              ? "member"
              : undefined
          }
        >
          {invitable.map((role) => (
            <option key={role.key} value={role.key}>
              {role.name}
            </option>
          ))}
        </Select>
      </Field>
      {teams.length > 0 && (
        <fieldset className="cloud-check-grid">
          <legend>Teams</legend>
          {teams.map((team) => (
            <label key={team.id}>
              <input type="checkbox" name="teamIds" value={team.id} />
              {team.name}
            </label>
          ))}
        </fieldset>
      )}
      {options ? (
        <Field label="Sign-in method" htmlFor="invite-method">
          <Select
            id="invite-method"
            value={method}
            required
            onChange={(event) => setMethod(event.target.value)}
          >
            <option value="">Select sign-in method</option>
            {!options.requiredSso && <option value="password">Password</option>}
            {options.providers.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.name}
              </option>
            ))}
          </Select>
        </Field>
      ) : (
        !error && <p role="status">Loading sign-in methods…</p>
      )}
      {method && method !== "password" && (
        <Field
          key={method}
          label="Subject"
          htmlFor="invite-subject"
          hint="Enter this provider's exact subject identifier for the invited person."
        >
          <Input id="invite-subject" name="subject" required maxLength={255} />
        </Field>
      )}
      {options && !options.credentialStorageAvailable && (
        <p>Configure credential storage before creating invitations.</p>
      )}
      {options?.requiredSso && !options.providers.length && (
        <p>Enable and test an SSO provider before inviting a member.</p>
      )}
      {error && (
        <>
          <p role="alert" className="cloud-error">
            {error}
          </p>
          <Button
            type="button"
            variant="outline"
            onClick={() => setReload((value) => value + 1)}
          >
            Load sign-in methods
          </Button>
        </>
      )}
    </FormDialog>
  );
}
