"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { CloudRoleRecord } from "@/lib/cloud-administration-contract";
import type { CloudActorMember } from "@/lib/cloud-contract";
import {
  canEditRole,
  canGrantPermissions,
  cloudPermissions,
  holderCan,
  isCloudPermission,
  permissionCatalog,
  type RoleScope,
} from "@/lib/cloud-permissions";
import { Field } from "@/components/field";
import { FormDialog } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { createCommandSender, formText } from "./api-client";

export const roleScopeLabels: Record<RoleScope, string> = {
  organization: "All teams",
  assigned: "Assigned teams only",
};

const permissionGroups = [
  ...new Set(cloudPermissions.map((key) => permissionCatalog[key].group)),
].map((group) => ({
  group,
  permissions: cloudPermissions.filter(
    (key) => permissionCatalog[key].group === group,
  ),
}));

export function RoleSettings({
  roles,
  actor,
}: {
  roles: CloudRoleRecord[];
  actor: CloudActorMember;
}) {
  const router = useRouter();
  const sender = useRef(createCommandSender());
  const [editing, setEditing] = useState<CloudRoleRecord | "new" | null>(null);
  const [removing, setRemoving] = useState<CloudRoleRecord | null>(null);
  const manage = holderCan(actor, "roles.manage");
  function open(next: CloudRoleRecord | "new") {
    sender.current = createCommandSender();
    setEditing(next);
  }
  const role = editing === "new" ? null : editing;
  return (
    <>
      <section
        className="cloud-settings-section"
        aria-labelledby="roles-heading"
      >
        <header>
          <h2 id="roles-heading">Roles</h2>
          {manage && <Button onClick={() => open("new")}>Create role</Button>}
        </header>
        <ul className="cloud-member-list">
          {roles.map((entry) => (
            <li key={entry.key}>
              <div>
                <strong>{entry.name}</strong>
                {entry.description && <span>{entry.description}</span>}
              </div>
              <span>{roleScopeLabels[entry.scope]}</span>
              <span>
                {entry.memberCount === 1
                  ? "1 member"
                  : `${entry.memberCount} members`}
              </span>
              {canEditRole(actor, entry) && (
                <Button
                  variant="outline"
                  aria-label={`Edit role ${entry.name}`}
                  onClick={() => open(entry)}
                >
                  Edit
                </Button>
              )}
              {!entry.builtin && canEditRole(actor, entry) && (
                <Button
                  variant="outline"
                  aria-label={`Delete role ${entry.name}`}
                  onClick={() => {
                    sender.current = createCommandSender();
                    setRemoving(entry);
                  }}
                >
                  Delete
                </Button>
              )}
            </li>
          ))}
        </ul>
      </section>
      <FormDialog
        open={editing !== null}
        onOpenChange={(next) => {
          if (!next) setEditing(null);
        }}
        title={role ? `Edit ${role.name}` : "Create role"}
        submitLabel={role ? "Save role" : "Create role"}
        onSubmit={async (form) => {
          const input = {
            name: formText(form, "name"),
            description: formText(form, "description"),
            scope: formText(form, "scope"),
            permissions: form
              .getAll("permissions")
              .map(String)
              .filter(isCloudPermission),
          };
          if (role)
            await sender.current(
              `roles/${role.key}`,
              { ...input, revision: role.revision },
              "PATCH",
            );
          else await sender.current("roles", input);
          setEditing(null);
          router.refresh();
        }}
      >
        <Field label="Name" htmlFor="role-name">
          <Input
            id="role-name"
            name="name"
            required
            maxLength={60}
            defaultValue={role?.name}
          />
        </Field>
        <Field label="Description" htmlFor="role-description">
          <Textarea
            id="role-description"
            name="description"
            maxLength={300}
            rows={2}
            className="min-h-16"
            defaultValue={role?.description}
          />
        </Field>
        <Field label="Team access" htmlFor="role-scope">
          <Select
            id="role-scope"
            name="scope"
            defaultValue={role?.scope ?? "organization"}
          >
            {Object.entries(roleScopeLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </Field>
        {permissionGroups.map(({ group, permissions }) => (
          <fieldset key={group} className="cloud-check-grid">
            <legend>{group}</legend>
            {permissions.map((permission) => (
              <label key={permission}>
                <input
                  type="checkbox"
                  name="permissions"
                  value={permission}
                  disabled={!canGrantPermissions(actor, [permission])}
                  defaultChecked={role?.permissions.includes(permission)}
                />
                {permissionCatalog[permission].label}
              </label>
            ))}
          </fieldset>
        ))}
      </FormDialog>
      <FormDialog
        open={removing !== null}
        onOpenChange={(next) => {
          if (!next) setRemoving(null);
        }}
        title={removing ? `Delete ${removing.name}` : "Delete role"}
        submitLabel="Delete role"
        onSubmit={async () => {
          if (!removing) return;
          await sender.current(
            `roles/${removing.key}`,
            { revision: removing.revision },
            "DELETE",
          );
          setRemoving(null);
          router.refresh();
        }}
      >
        <p>This role will no longer be available.</p>
      </FormDialog>
    </>
  );
}
