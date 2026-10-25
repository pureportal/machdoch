"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { OidcProvider, SsoAdministration } from "@/lib/cloud-sso-contract";
import type { ManagedMember } from "@/lib/cloud-administration-contract";
import { SsoProviderEditor } from "./sso-provider-editor";
import { Field } from "@/components/field";
import { FormDialog } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { cloudRequest, createCommandSender, formText } from "./api-client";

export function SsoSettings({
  members,
  owner,
}: {
  members: ManagedMember[];
  owner: boolean;
}) {
  const [data, setData] = useState<SsoAdministration | null>(null);
  const [policy, setPolicy] = useState<{
    required: boolean;
    revision: number;
  } | null>(null);
  const [editing, setEditing] = useState<OidcProvider | null | undefined>();
  const [mapping, setMapping] = useState<OidcProvider | null>(null);
  const [identities, setIdentities] = useState<
    { userId: string; subject: string; email: string }[]
  >([]);
  const [changingPolicy, setChangingPolicy] = useState(false);
  const [newMember, setNewMember] = useState(false);
  const router = useRouter();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [reload, setReload] = useState(0);
  const sender = useRef(createCommandSender());
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      cloudRequest<SsoAdministration>("sso-providers", {
        signal: controller.signal,
      }),
      cloudRequest<{ required: boolean; revision: number }>("sso-policy", {
        signal: controller.signal,
      }),
    ])
      .then(([providers, value]) => {
        if (!controller.signal.aborted) {
          setData(providers);
          setPolicy(value);
          setError("");
        }
      })
      .catch((reason: Error) => {
        if (!controller.signal.aborted) setError(reason.message);
      });
    return () => controller.abort();
  }, [reload]);
  async function begin(providerId: string, link: boolean) {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      const result = await cloudRequest<{ url: string }>(
        link ? "sso-link" : "auth/sso/start",
        { method: "POST", body: { providerId } },
      );
      location.assign(result.url);
    } catch (reason) {
      setError((reason as Error).message);
      setPending(false);
    }
  }
  return (
    <section className="cloud-settings-section" aria-labelledby="sso-heading">
      <header>
        <h2 id="sso-heading">Single sign-on</h2>
        {owner && (
          <Button
            variant="outline"
            disabled={!data?.credentialStorageAvailable}
            onClick={() => setEditing(null)}
          >
            Add provider
          </Button>
        )}
      </header>
      {owner && data && !data.credentialStorageAvailable && (
        <p>Configure credential storage before adding a sign-in provider.</p>
      )}
      {owner && data && (
        <dl className="cloud-properties">
          <div>
            <dt>Redirect URI</dt>
            <dd className="break-all select-all">{data.redirectUri}</dd>
          </div>
        </dl>
      )}
      <ul className="cloud-member-list">
        {data?.providers.map((provider) => (
          <li key={provider.id}>
            <div>
              <strong>{provider.name}</strong>
              <span className="break-all">{provider.metadata.issuer}</span>
              <span>
                {provider.enabled
                  ? provider.verified
                    ? "Enabled"
                    : "Sign-in not tested"
                  : "Disabled"}
              </span>
            </div>
            <div className="cloud-editor-actions flex-wrap">
              {owner && (
                <Button
                  variant="outline"
                  onClick={() => setEditing(provider)}
                  aria-label={`Edit ${provider.name}`}
                >
                  Edit
                </Button>
              )}
              <Button
                variant="outline"
                disabled={pending}
                onClick={() => {
                  setPending(true);
                  setError("");
                  sender.current = createCommandSender();
                  setNewMember(false);
                  void cloudRequest<typeof identities>(
                    `sso-providers/${provider.id}/mappings`,
                  )
                    .then((rows) => {
                      setIdentities(rows);
                      setMapping(provider);
                    })
                    .catch((reason: Error) => setError(reason.message))
                    .finally(() => setPending(false));
                }}
                aria-label={`Identities for ${provider.name}`}
              >
                Identities
              </Button>
              {provider.enabled && (
                <>
                  {!data?.linkedProviderIds.includes(provider.id) && (
                    <Button
                      variant="outline"
                      disabled={pending}
                      onClick={() => void begin(provider.id, true)}
                    >
                      Link my identity
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    disabled={pending}
                    onClick={() => void begin(provider.id, false)}
                  >
                    Sign in
                  </Button>
                </>
              )}
            </div>
          </li>
        ))}
      </ul>
      {policy && owner && (
        <Button
          variant="outline"
          onClick={() => {
            sender.current = createCommandSender();
            setChangingPolicy(true);
          }}
        >
          {policy.required ? "Turn off required SSO" : "Require SSO"}
        </Button>
      )}
      {error && (
        <p role="alert" className="cloud-error">
          {error}
        </p>
      )}
      {owner && editing !== undefined && (
        <SsoProviderEditor
          key={`${editing?.id ?? "new"}:${editing?.revision ?? 0}`}
          provider={editing}
          onClose={() => {
            setEditing(undefined);
            setReload((value) => value + 1);
          }}
          onReload={setEditing}
          onSaved={() => {
            setEditing(undefined);
            setReload((value) => value + 1);
          }}
        />
      )}
      <FormDialog
        open={!!mapping}
        onOpenChange={(open) => {
          if (!open) setMapping(null);
        }}
        title={`Identities · ${mapping?.name ?? ""}`}
        submitLabel={newMember ? "Add member" : "Map identity"}
        onSubmit={async (form) => {
          await sender.current(
            `sso-providers/${mapping!.id}/${newMember ? "members" : "mappings"}`,
            newMember
              ? {
                  name: formText(form, "name"),
                  email: formText(form, "email"),
                  role: formText(form, "role"),
                  subject: formText(form, "subject"),
                }
              : {
                  userId: formText(form, "userId"),
                  subject: formText(form, "subject"),
                },
          );
          setMapping(null);
          router.refresh();
        }}
      >
        {identities.map((identity) => (
          <div key={identity.userId} className="grid gap-2">
            <strong className="break-all">{identity.email}</strong>
            <span className="break-all">{identity.subject}</span>
            {(owner ||
              members.some(
                (member) =>
                  member.id === identity.userId &&
                  !["owner", "admin"].includes(member.role),
              )) && (
              <Button
                type="button"
                variant="outline"
                onClick={async () => {
                  setError("");
                  try {
                    await sender.current(
                      `sso-providers/${mapping!.id}/mappings`,
                      { userId: identity.userId, subject: identity.subject },
                      "DELETE",
                    );
                    setMapping(null);
                    setReload((value) => value + 1);
                  } catch (reason) {
                    setError((reason as Error).message);
                    setMapping(null);
                  }
                }}
              >
                Remove identity for {identity.email}
              </Button>
            )}
          </div>
        ))}
        <Field label="Account" htmlFor="sso-account">
          <Select
            id="sso-account"
            value={newMember ? "new" : "existing"}
            onChange={(event) => setNewMember(event.target.value === "new")}
          >
            <option value="existing">Existing member</option>
            <option value="new">New member</option>
          </Select>
        </Field>
        {newMember ? (
          <>
            <Field label="Name" htmlFor="sso-member-name">
              <Input
                id="sso-member-name"
                name="name"
                required
                maxLength={120}
                autoComplete="off"
              />
            </Field>
            <Field label="Email" htmlFor="sso-member-email">
              <Input
                id="sso-member-email"
                name="email"
                type="email"
                required
                maxLength={254}
                autoComplete="off"
              />
            </Field>
            <Field label="Role" htmlFor="sso-member-role">
              <Select id="sso-member-role" name="role" defaultValue="member">
                <option value="member">Member</option>
                <option value="viewer">Viewer</option>
                {owner && <option value="admin">Administrator</option>}
              </Select>
            </Field>
          </>
        ) : (
          <Field label="Member" htmlFor="sso-member">
            <Select id="sso-member" name="userId" required>
              <option value="">Select member</option>
              {members
                .filter(
                  (member) =>
                    member.active &&
                    (owner || !["admin", "owner"].includes(member.role)),
                )
                .map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.email}
                  </option>
                ))}
            </Select>
          </Field>
        )}
        <Field
          label="Subject"
          htmlFor="sso-subject"
          hint="Enter the exact subject identifier supplied by this provider."
        >
          <Input id="sso-subject" name="subject" required maxLength={255} />
        </Field>
        <p>
          Mapping grants this identity access to the selected account. Adding or
          removing a mapping ends that member's organization sessions and app
          connections.
        </p>
      </FormDialog>
      <FormDialog
        open={changingPolicy}
        onOpenChange={setChangingPolicy}
        title={policy?.required ? "Turn off required SSO" : "Require SSO"}
        submitLabel="Change sign-in policy"
        onSubmit={async () => {
          await sender.current(
            "sso-policy",
            { required: !policy!.required, revision: policy!.revision },
            "PATCH",
          );
          location.assign("/cloud/login");
        }}
      >
        <p>
          {policy?.required
            ? "Members can sign in with passwords or enabled email links again."
            : "Members must sign in through a linked SSO identity. Passwords and email links will no longer sign them in."}{" "}
          All organization sessions and app connections will end.
        </p>
        <p>Recovery requires the server operator's sign-in recovery command.</p>
      </FormDialog>
    </section>
  );
}
