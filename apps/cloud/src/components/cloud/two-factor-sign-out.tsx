"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cloudRequest } from "./api-client";

export function TwoFactorSignOut({ disabled }: { disabled: boolean }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        disabled={disabled || pending}
        onClick={() => {
          setPending(true);
          setError("");
          void cloudRequest("auth/logout", { method: "POST" })
            .then(() => location.assign("/cloud/login"))
            .catch((reason: Error) => {
              setError(reason.message);
              setPending(false);
            });
        }}
      >
        Sign out
      </Button>
      {error && (
        <p role="alert" className="cloud-error">
          {error}
        </p>
      )}
    </>
  );
}
