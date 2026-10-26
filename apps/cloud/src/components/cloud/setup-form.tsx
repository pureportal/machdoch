"use client";
import { AuthFrame } from "./auth-frame";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/field";
import { cloudRequest, formText } from "./api-client";

export function CloudSetupForm() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  return (
    <AuthFrame>
      <h1>Create organization</h1>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (pending) return;
          const form = new FormData(event.currentTarget);
          setPending(true);
          setError("");
          void cloudRequest("auth/setup", {
            method: "POST",
            body: {
              organization: formText(form, "organization"),
              name: formText(form, "name"),
              email: formText(form, "email"),
              password: formText(form, "password"),
            },
          })
            .then(() => location.assign("/cloud/issues"))
            .catch((reason: Error) => {
              setError(reason.message);
              setPending(false);
            });
        }}
      >
        <Field label="Organization" htmlFor="organization">
          <Input
            id="organization"
            name="organization"
            autoComplete="organization"
            maxLength={120}
            required
            disabled={pending}
          />
        </Field>
        <Field label="Name" htmlFor="name">
          <Input
            id="name"
            name="name"
            autoComplete="name"
            maxLength={120}
            required
            disabled={pending}
          />
        </Field>
        <Field label="Email" htmlFor="email">
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="username"
            maxLength={254}
            required
            disabled={pending}
          />
        </Field>
        <Field label="Password" htmlFor="password">
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={12}
            maxLength={1024}
            required
            disabled={pending}
          />
        </Field>
        {error && <p role="alert">{error}</p>}
        <Button type="submit" disabled={pending}>
          {pending ? "Creating…" : "Create organization"}
        </Button>
      </form>
    </AuthFrame>
  );
}
