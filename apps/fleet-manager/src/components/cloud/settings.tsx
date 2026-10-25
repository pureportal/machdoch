"use client";

import Link from "next/link";
import { EmailSettings } from "./email-settings";
import { SsoSettings } from "./sso-settings";
import { InvitationEditor } from "./invitation-editor";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  brandAccents,
  type CloudAdministration,
  type ManagedMember,
} from "@/lib/cloud-administration-contract";
import { cloudRoles, type CloudMember } from "@/lib/cloud-contract";
import { Field } from "@/components/field";
import { FormDialog } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { createCommandSender, formText } from "./api-client";

export function CloudSettings({
  data,
  actor,
}: {
  data: CloudAdministration;
  actor: CloudMember;
}) {
  const router = useRouter();
  const sender = useRef(createCommandSender());
  const [editingBrand, setEditingBrand] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [member, setMember] = useState<ManagedMember | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [invitationUrl, setInvitationUrl] = useState("");
  const editable = (person: ManagedMember) =>
    actor.role === "owner" || !["owner", "admin"].includes(person.role);
  function resetSender() {
    sender.current = createCommandSender();
  }
  return (
    <>
      <header className="cloud-page-header">
        <h1>Settings</h1>
        <div className="cloud-editor-actions">
          <Button asChild variant="outline">
            <Link href="/cloud/providers">AI providers</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/cloud/execution">AI execution</Link>
          </Button>
        </div>
      </header>
      <div className="cloud-settings">
        <EmailSettings owner={actor.role === "owner"} />
        <SsoSettings members={data.members} owner={actor.role === "owner"} />
        <section
          className="cloud-settings-section"
          aria-labelledby="organization-heading"
        >
          <header>
            <h2 id="organization-heading">Organization</h2>
            <Button
              variant="outline"
              onClick={() => {
                resetSender();
                setEditingBrand(true);
              }}
            >
              Edit organization
            </Button>
          </header>
          <dl className="cloud-properties">
            <div>
              <dt>Name</dt>
              <dd>{data.organization.name}</dd>
            </div>
            <div>
              <dt>Accent</dt>
              <dd className="capitalize">{data.organization.accent}</dd>
            </div>
          </dl>
        </section>
        <section
          className="cloud-settings-section"
          aria-labelledby="members-heading"
        >
          <header>
            <h2 id="members-heading">Members</h2>
            <Button
              onClick={() => {
                setInvitationUrl("");
                setInviting(true);
              }}
            >
              Invite member
            </Button>
          </header>
          <ul className="cloud-member-list">
            {data.members.map((person) => (
              <li key={person.id}>
                <div>
                  <strong>{person.name}</strong>
                  <span>{person.email}</span>
                </div>
                <span className="capitalize">
                  {person.active ? person.role : "Suspended"}
                </span>
                {editable(person) && (
                  <Button
                    variant="outline"
                    aria-label={`Edit access for ${person.name}`}
                    onClick={() => {
                      resetSender();
                      setMember(person);
                    }}
                  >
                    Edit access
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </section>
        {invitationUrl && (
          <section className="cloud-settings-section">
            <Field label="Invitation link" htmlFor="invitation-link">
              <Input
                id="invitation-link"
                readOnly
                value={invitationUrl}
                onFocus={(event) => event.currentTarget.select()}
              />
            </Field>
          </section>
        )}
        {!!data.invitations.length && (
          <section
            className="cloud-settings-section"
            aria-labelledby="invitations-heading"
          >
            <header>
              <h2 id="invitations-heading">Pending invitations</h2>
            </header>
            <ul className="cloud-member-list">
              {data.invitations.map((invitation) => (
                <li key={invitation.id}>
                  <div>
                    <strong>{invitation.email}</strong>
                    <span>
                      Expires{" "}
                      {new Date(invitation.expiresAt)
                        .toISOString()
                        .slice(0, 10)}
                    </span>
                  </div>
                  <span className="capitalize">{invitation.role}</span>
                  {(actor.role === "owner" || invitation.role !== "admin") && (
                    <Button
                      variant="outline"
                      aria-label={`Revoke invitation for ${invitation.email}`}
                      onClick={() => {
                        resetSender();
                        setRevoking(invitation.id);
                      }}
                    >
                      Revoke
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
      <FormDialog
        open={editingBrand}
        onOpenChange={setEditingBrand}
        title="Organization"
        submitLabel="Save organization"
        onSubmit={async (form) => {
          await sender.current(
            "organization",
            {
              revision: data.organization.revision,
              name: formText(form, "name"),
              accent: formText(form, "accent"),
            },
            "PATCH",
          );
          router.refresh();
        }}
      >
        <Field label="Name" htmlFor="organization-name">
          <Input
            id="organization-name"
            name="name"
            required
            maxLength={120}
            defaultValue={data.organization.name}
          />
        </Field>
        <Field label="Accent" htmlFor="organization-accent">
          <Select
            id="organization-accent"
            name="accent"
            defaultValue={data.organization.accent}
          >
            {brandAccents.map((accent) => (
              <option key={accent} value={accent}>
                {accent[0]!.toUpperCase() + accent.slice(1)}
              </option>
            ))}
          </Select>
        </Field>
      </FormDialog>
      {inviting && (
        <InvitationEditor
          organizationId={data.organization.id}
          owner={actor.role === "owner"}
          onClose={() => setInviting(false)}
          onCreated={(url) => {
            setInvitationUrl(url);
            router.refresh();
          }}
        />
      )}
      <FormDialog
        open={member !== null}
        onOpenChange={(open) => {
          if (!open) setMember(null);
        }}
        title={member ? `Access for ${member.name}` : "Member access"}
        submitLabel="Save access"
        onSubmit={async (form) => {
          if (!member) return;
          await sender.current(
            `members/${member.id}`,
            {
              revision: member.revision,
              role: formText(form, "role"),
              active: formText(form, "access") === "active",
            },
            "PATCH",
          );
          if (member.id === actor.id) location.assign("/cloud/login");
          else router.refresh();
        }}
      >
        <Field label="Role" htmlFor="member-role">
          <Select id="member-role" name="role" defaultValue={member?.role}>
            {cloudRoles
              .filter(
                (role) =>
                  actor.role === "owner" || !["owner", "admin"].includes(role),
              )
              .map((role) => (
                <option key={role} value={role}>
                  {role[0]!.toUpperCase() + role.slice(1)}
                </option>
              ))}
          </Select>
        </Field>
        <Field label="Access" htmlFor="member-access">
          <Select
            id="member-access"
            name="access"
            defaultValue={member?.active ? "active" : "suspended"}
          >
            <option value="active">Active</option>
            <option value="suspended">Suspended</option>
          </Select>
        </Field>
        <p>
          Saving ends this member’s current sessions. Suspended members cannot
          sign in.
        </p>
      </FormDialog>
      <FormDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) setRevoking(null);
        }}
        title="Revoke invitation"
        submitLabel="Revoke invitation"
        onSubmit={async () => {
          await sender.current(`invitations/${revoking}/revoke`, {});
          setInvitationUrl("");
          router.refresh();
        }}
      >
        <p>The invitation link will stop working.</p>
      </FormDialog>
    </>
  );
}
