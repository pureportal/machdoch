"use client";

import { ArrowLeft, KeyRound } from "lucide-react";
import Link from "next/link";
import { EnrollmentKeyForm } from "@/components/enrollment/enrollment-key-form";
import { useEnrollmentKeys } from "@/components/enrollment/use-enrollment-keys";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatTime } from "@/lib/format";

export function EnrollmentView(): React.ReactElement {
  const enrollment = useEnrollmentKeys();
  const { grants, loading, loadError, revoking, pending, reload, revoke } =
    enrollment;
  return (
    <section className="grid max-w-3xl gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-3xl font-semibold tracking-tight">Enrollment</h1>
        <Button asChild variant="ghost">
          <Link href="/instances">
            <ArrowLeft />
            Overview
          </Link>
        </Button>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Enrollment key</CardTitle>
        </CardHeader>
        <CardContent>
          <EnrollmentKeyForm enrollment={enrollment} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
          <CardTitle>Unused keys</CardTitle>
          <Button
            variant="outline"
            disabled={loading || pending || revoking !== null}
            onClick={() => void reload()}
          >
            {loadError ? "Retry" : "Refresh"}
          </Button>
        </CardHeader>
        <CardContent className="grid gap-4">
          {loadError ? (
            <p role="alert" className="text-sm text-destructive">
              {loadError}
            </p>
          ) : null}
          {grants.length === 0 ? (
            !loadError ? (
              <div
                role="status"
                className="flex items-center gap-3 rounded-lg bg-muted/40 p-4 text-sm text-muted-foreground"
              >
                <KeyRound className="size-4" aria-hidden="true" />
                {loading ? "Loading keys…" : "No unused keys."}
              </div>
            ) : null
          ) : (
            grants.map((item) => (
              <div
                key={item.grantId}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4"
              >
                <div className="min-w-0 text-sm">
                  <p className="font-medium">
                    Expires {formatTime(item.expiresAt)}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Created {formatTime(item.createdAt)}
                  </p>
                  <p className="mt-2 break-all font-mono text-xs text-muted-foreground">
                    {item.grantId}
                  </p>
                </div>
                <Button
                  variant="outline"
                  disabled={revoking !== null || pending}
                  aria-label={`Revoke key ${item.grantId}`}
                  onClick={() => void revoke(item.grantId)}
                >
                  {revoking === item.grantId ? "Revoking…" : "Revoke"}
                </Button>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </section>
  );
}
