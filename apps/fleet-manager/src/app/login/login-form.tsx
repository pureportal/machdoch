"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Field } from "@/components/field";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api, jsonBody } from "@/lib/api";

export function LoginForm(): React.ReactElement {
  const router = useRouter();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Sign in</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          className="grid gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            setError("");
            setPending(true);
            const form = new FormData(event.currentTarget);
            api<{ ok: true }>("/api/auth/login", {
              method: "POST",
              body: jsonBody({
                username: form.get("username"),
                password: form.get("password"),
              }),
            })
              .then(() => {
                router.replace("/instances");
                router.refresh();
              })
              .catch((reason: unknown) => {
                setError(
                  reason instanceof Error ? reason.message : "Sign in failed.",
                );
                setPending(false);
              });
          }}
        >
          <Field label="Username" htmlFor="username">
            <Input
              id="username"
              name="username"
              autoComplete="username"
              maxLength={64}
              required
              autoFocus
            />
          </Field>
          <Field label="Password" htmlFor="password">
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              maxLength={1024}
              required
            />
          </Field>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <Button type="submit" disabled={pending}>
            {pending ? "Signing in…" : "Sign in"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
