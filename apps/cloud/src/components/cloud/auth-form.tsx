"use client";
import { AuthFrame } from "./auth-frame";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/field";
import { cloudRequest, formText } from "./api-client";

export function CloudAuthForm({
  authorizationId,
}: {
  authorizationId?: string;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [emailAvailable, setEmailAvailable] = useState(false);
  const [passwordAvailable, setPasswordAvailable] = useState(true);
  const [method, setMethod] = useState<"password" | "email">("password");
  const [sent, setSent] = useState(false);
  const [sso, setSso] = useState<
    { id: string; name: string; organization: string }[]
  >([]);
  useEffect(() => {
    const controller = new AbortController();
    void cloudRequest<{
      magicLink: boolean;
      password: boolean;
      sso: { id: string; name: string; organization: string }[];
    }>("auth/methods", { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) {
          setEmailAvailable(result.magicLink);
          setPasswordAvailable(result.password);
          if (!result.password && result.magicLink) setMethod("email");
          setSso(result.sso);
        }
      })
      .catch((reason: Error) => {
        if (!controller.signal.aborted) setError(reason.message);
      });
    return () => controller.abort();
  }, []);
  return (
    <AuthFrame>
      <h1>Sign in</h1>
      {sso.map((provider) => (
        <Button
          key={provider.id}
          type="button"
          variant="outline"
          disabled={pending}
          onClick={() => {
            setPending(true);
            setError("");
            void cloudRequest<{ url: string }>("auth/sso/start", {
              method: "POST",
              body: { providerId: provider.id, authorizationId },
            })
              .then((result) => location.assign(result.url))
              .catch((reason: Error) => {
                setError(reason.message);
                setPending(false);
              });
          }}
        >
          Continue with {provider.name}
          {new Set(sso.map((item) => item.organization)).size > 1
            ? " ? " + provider.organization
            : ""}
        </Button>
      ))}
      {(passwordAvailable || emailAvailable) && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (pending) return;
            const form = new FormData(event.currentTarget);
            setPending(true);
            setError("");
            setSent(false);
            if (method === "email") {
              void cloudRequest("auth/magic/request", {
                method: "POST",
                body: {
                  email: formText(form, "email"),
                  ...(authorizationId ? { authorizationId } : {}),
                },
              })
                .then(() => setSent(true))
                .catch((reason: Error) => setError(reason.message))
                .finally(() => setPending(false));
            } else {
              void cloudRequest("auth/login", {
                method: "POST",
                body: {
                  email: formText(form, "email"),
                  password: formText(form, "password"),
                },
              })
                .then(() =>
                  location.assign(
                    authorizationId
                      ? "/cloud/authorize?requestId=" + authorizationId
                      : "/cloud/issues",
                  ),
                )
                .catch((reason: Error) => {
                  setError(reason.message);
                  setPending(false);
                });
            }
          }}
        >
          {emailAvailable && passwordAvailable && (
            <div
              role="group"
              aria-label="Sign-in method"
              className="flex gap-2"
            >
              <Button
                type="button"
                variant={method === "password" ? "default" : "outline"}
                disabled={pending}
                aria-pressed={method === "password"}
                onClick={() => {
                  setMethod("password");
                  setError("");
                  setSent(false);
                }}
              >
                Password
              </Button>
              <Button
                type="button"
                variant={method === "email" ? "default" : "outline"}
                disabled={pending}
                aria-pressed={method === "email"}
                onClick={() => {
                  setMethod("email");
                  setError("");
                }}
              >
                Email link
              </Button>
            </div>
          )}
          <Field
            label={method === "email" ? "Email" : "Username or email"}
            htmlFor="email"
          >
            <Input
              id="email"
              name="email"
              type={method === "email" ? "email" : "text"}
              autoComplete="username"
              required
              disabled={pending}
            />
          </Field>
          {method === "password" && (
            <Field label="Password" htmlFor="password">
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                maxLength={1024}
                disabled={pending}
              />
            </Field>
          )}
          {sent && (
            <p role="status">
              If this account can sign in by email, a link will arrive shortly.
              {authorizationId &&
                " Open it on this device to finish the connection."}
            </p>
          )}
          <Button type="submit" aria-disabled={pending} aria-busy={pending}>
            {pending
              ? method === "email"
                ? "Sending…"
                : "Signing in…"
              : method === "email"
                ? "Send sign-in link"
                : "Sign in"}
          </Button>
        </form>
      )}
      {error && (
        <p role="alert" className="cloud-error">
          {error}
        </p>
      )}
    </AuthFrame>
  );
}
