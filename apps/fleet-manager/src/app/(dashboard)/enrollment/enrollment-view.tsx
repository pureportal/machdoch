"use client";

import { Check, Copy, KeyRound } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { formatTime } from "@/lib/format";

interface EnrollmentGrant {
  enrollmentKey: string;
  managerUrl: string;
  managerId: string;
  expiresAt: number;
}

export function EnrollmentView(): React.ReactElement {
  const [grant, setGrant] = useState<EnrollmentGrant | null>(null);
  const [pending, setPending] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  return (
    <section className="grid max-w-3xl gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">Enrollment</h1>
      <Card>
        <CardHeader>
          <CardTitle>Enrollment key</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-5">
          {grant ? (
            <>
              <div className="grid gap-2">
                <label htmlFor="manager-url" className="text-sm font-medium">
                  Fleet Manager URL
                </label>
                <Input id="manager-url" value={grant.managerUrl} readOnly />
              </div>
              <div className="grid gap-2">
                <label htmlFor="enrollment-key" className="text-sm font-medium">
                  Enrollment key
                </label>
                <div className="flex gap-2">
                  <Input
                    id="enrollment-key"
                    value={grant.enrollmentKey}
                    readOnly
                    className="font-mono"
                  />
                  <Button
                    variant="outline"
                    size="icon"
                    aria-label="Copy enrollment key"
                    onClick={() => {
                      setError("");
                      void Promise.resolve()
                        .then(() =>
                          navigator.clipboard.writeText(grant.enrollmentKey),
                        )
                        .then(() => {
                          setCopied(true);
                          window.setTimeout(() => setCopied(false), 1500);
                        })
                        .catch(() =>
                          setError("Enrollment key could not be copied."),
                        );
                    }}
                  >
                    {copied ? <Check /> : <Copy />}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Expires {formatTime(grant.expiresAt)}.
                </p>
              </div>
            </>
          ) : (
            <div className="grid min-h-36 place-items-center text-center">
              <span className="grid size-11 place-items-center rounded-xl bg-muted text-muted-foreground">
                <KeyRound />
              </span>
            </div>
          )}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <Button
            className="w-fit"
            disabled={pending}
            onClick={() => {
              setPending(true);
              setError("");
              void api<EnrollmentGrant>("/api/enrollment-keys", {
                method: "POST",
              })
                .then(setGrant)
                .catch((reason: unknown) =>
                  setError(
                    reason instanceof Error
                      ? reason.message
                      : "Key creation failed.",
                  ),
                )
                .finally(() => setPending(false));
            }}
          >
            {pending
              ? "Creating…"
              : grant
                ? "Create another key"
                : "Create enrollment key"}
          </Button>
        </CardContent>
      </Card>
    </section>
  );
}
