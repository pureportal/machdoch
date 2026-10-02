"use client";

import { Pencil } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, jsonBody } from "@machdoch/product-ui/fleet-api";
import { Field } from "@/components/field";
import { FormDialog } from "@/components/form-dialog";
import { PasswordInput } from "@/components/password-input";
import { ShowMore } from "@/components/show-more";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { formatTime } from "@/lib/format";

export interface OwnerAccount {
  username: string;
  createdAt: number;
  updatedAt: number;
}

export function OwnerAccountCard({
  account,
  loading,
}: {
  account: OwnerAccount;
  loading: boolean;
}): React.ReactElement {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-3">
        <CardTitle>Account</CardTitle>
        <Button
          variant="outline"
          disabled={loading}
          onClick={() => setEditing(true)}
        >
          <Pencil />
          Edit account
        </Button>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="flex min-w-0 items-center gap-4">
          <span
            className="grid size-14 shrink-0 place-items-center rounded-2xl bg-secondary text-xl font-semibold text-primary"
            aria-hidden="true"
          >
            {account.username.slice(0, 1).toUpperCase()}
          </span>
          <p className="min-w-0 break-words text-lg font-semibold">
            {account.username}
          </p>
        </div>
        <ShowMore>
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <div className="grid gap-1">
              <dt className="text-muted-foreground">Created</dt>
              <dd>{formatTime(account.createdAt)}</dd>
            </div>
            <div className="grid gap-1">
              <dt className="text-muted-foreground">Updated</dt>
              <dd>{formatTime(account.updatedAt)}</dd>
            </div>
          </dl>
        </ShowMore>
      </CardContent>
      <FormDialog
        open={editing}
        onOpenChange={setEditing}
        title="Edit account"
        submitLabel="Save account"
        onSubmit={async (form) => {
          await api("/api/auth/account", {
            method: "PUT",
            body: jsonBody({
              username: form.get("username"),
              currentPassword: form.get("currentPassword"),
              newPassword: form.get("newPassword"),
            }),
          });
          router.replace("/login");
          router.refresh();
        }}
      >
        <Field label="Username" htmlFor="owner-username">
          <Input
            id="owner-username"
            name="username"
            defaultValue={account.username}
            maxLength={64}
            autoComplete="username"
            required
          />
        </Field>
        <Field label="Current password" htmlFor="current-password">
          <PasswordInput
            id="current-password"
            name="currentPassword"
            autoComplete="current-password"
            maxLength={1024}
            required
          />
        </Field>
        <Field
          label="New password"
          htmlFor="new-password"
          hint="Use at least 12 characters."
        >
          <PasswordInput
            id="new-password"
            name="newPassword"
            autoComplete="new-password"
            minLength={12}
            maxLength={1024}
            required
          />
        </Field>
        <p className="text-sm text-muted-foreground">
          Saving signs out all browsers.
        </p>
      </FormDialog>
    </Card>
  );
}
