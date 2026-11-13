"use client";

import { EmailSettings } from "./email-settings";
import { GitSettings } from "./git-settings";
import { MimoriiSettings } from "./mimorii-settings";
import { SsoSettings } from "./sso-settings";
import { InvitationEditor } from "./invitation-editor";
import { OrganizationBranding } from "./organization-branding";
import { RoleSettings } from "./role-settings";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  type CloudAdministration,
  type ManagedMember,
  type SettingsTab,
} from "@/lib/cloud-administration-contract";
import type { CloudActorMember } from "@/lib/cloud-contract";
import {
  canGrantRole,
  holderCan,
  type CloudPermission,
} from "@/lib/cloud-permissions";
import { Field } from "@/components/field";
import { FormDialog } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { PersonAvatar } from "./person-avatar";
import { createCommandSender, formText } from "./api-client";
import { useToast } from "./toast";

export function CloudSettings({
  data,
  actor,
  tab,
}: {
  data: CloudAdministration;
  actor: CloudActorMember;
  tab: SettingsTab;
}) {
  const can = (...permissions: CloudPermission[]) =>
    permissions.some((permission) => holderCan(actor, permission));
  const tabs = (
    [
      ["organization", "Organization", can("settings.manage")],
      ["members", "Members", can("members.manage")],
      ["roles", "Roles", can("roles.manage", "members.manage")],
      ["authentication", "Authentication", can("settings.manage")],
      ["email", "Email", can("settings.manage")],
      ["git", "Git", can("git.manage")],
      ["mimorii", "Mimorii", can("settings.manage")],
    ] satisfies [SettingsTab, string, boolean][]
  ).filter(([, , visible]) => visible);
  const grantableRoles = data.roles.filter((role) => canGrantRole(actor, role));
  const router = useRouter();
  const toast = useToast();
  const sender = useRef(createCommandSender());
  const [inviting, setInviting] = useState(false);
  const [member, setMember] = useState<ManagedMember | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [resetting, setResetting] = useState<ManagedMember | null>(null);
  const [invitationUrl, setInvitationUrl] = useState("");
  const editable = (person: ManagedMember) =>
    grantableRoles.some((role) => role.key === person.role);
  function resetSender() {
    sender.current = createCommandSender();
  }
  return (
    <>
      <header className="cloud-page-header">
        <h1>Settings</h1>
      </header>
      <Tabs
        defaultValue={
          tabs.some(([value]) => value === tab) ? tab : tabs[0]?.[0]
        }
      >
        <TabsList aria-label="Organization settings">
          {tabs.map(([value, label]) => (
            <TabsTrigger key={value} value={value}>
              {label}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="organization" className="cloud-settings">
          <OrganizationBranding organization={data.organization} />
        </TabsContent>
        <TabsContent value="members" className="cloud-settings">
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
                  <PersonAvatar name={person.name} />
                  <div>
                    <strong>{person.name}</strong>
                    <span>{person.email}</span>
                  </div>
                  <span>{person.active ? person.roleName : "Suspended"}</span>
                  {editable(person) &&
                    person.twoFactor &&
                    person.id !== actor.id && (
                      <Button
                        variant="outline"
                        aria-label={`Reset two-factor for ${person.name}`}
                        onClick={() => {
                          resetSender();
                          setResetting(person);
                        }}
                      >
                        Reset two-factor
                      </Button>
                    )}
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
                    <span>{invitation.roleName}</span>
                    {grantableRoles.some(
                      (role) => role.key === invitation.role,
                    ) && (
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
        </TabsContent>
        <TabsContent value="roles" className="cloud-settings">
          <RoleSettings roles={data.roles} actor={actor} />
        </TabsContent>
        <TabsContent value="authentication" className="cloud-settings">
          <SsoSettings
            members={data.members}
            owner={actor.owner}
            grantableRoles={grantableRoles}
          />
        </TabsContent>
        <TabsContent value="email" className="cloud-settings">
          <EmailSettings owner={actor.owner} />
        </TabsContent>
        <TabsContent value="git" className="cloud-settings">
          <GitSettings />
        </TabsContent>
        <TabsContent value="mimorii" className="cloud-settings">
          <MimoriiSettings />
        </TabsContent>
      </Tabs>
      {inviting && (
        <InvitationEditor
          organizationId={data.organization.id}
          roles={grantableRoles}
          teams={data.teams}
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
              teamIds: form.getAll("teamIds").map(String),
            },
            "PATCH",
          );
          if (member.id === actor.id) location.assign("/cloud/login");
          else router.refresh();
        }}
      >
        <Field label="Role" htmlFor="member-role">
          <Select id="member-role" name="role" defaultValue={member?.role}>
            {grantableRoles.map((role) => (
              <option key={role.key} value={role.key}>
                {role.name}
              </option>
            ))}
          </Select>
        </Field>
        {data.teams.length > 0 && (
          <fieldset className="cloud-check-grid">
            <legend>Teams</legend>
            {data.teams.map((team) => (
              <label key={team.id}>
                <input
                  type="checkbox"
                  name="teamIds"
                  value={team.id}
                  defaultChecked={member?.teamIds.includes(team.id)}
                />
                {team.name}
              </label>
            ))}
          </fieldset>
        )}
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
        open={resetting !== null}
        onOpenChange={(open) => {
          if (!open) setResetting(null);
        }}
        title={
          resetting
            ? `Reset two-factor for ${resetting.name}`
            : "Reset two-factor"
        }
        submitLabel="Reset two-factor"
        onSubmit={async () => {
          if (!resetting) return;
          await sender.current(`members/${resetting.id}/two-factor/reset`, {});
          toast(`Two-factor reset for ${resetting.name}.`);
          router.refresh();
        }}
      >
        <p>
          {resetting?.name} sets up two-factor authentication again at the next
          sign-in. Their sessions and connected apps end now.
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
