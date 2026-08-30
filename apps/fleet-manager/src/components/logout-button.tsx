"use client";

import { LogOut } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/api";
import { Button } from "./ui/button";

export function LogoutButton(): React.ReactElement {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  return (
    <div className="relative">
      <Button
        variant="ghost"
        size="icon"
        aria-label="Sign out"
        disabled={pending}
        onClick={() => {
          setPending(true);
          setError("");
          void api<{ ok: true }>("/api/auth/logout", { method: "POST" })
            .then(() => {
              router.replace("/login");
              router.refresh();
            })
            .catch((reason: unknown) => {
              setError(
                reason instanceof Error ? reason.message : "Sign out failed.",
              );
              setPending(false);
            });
        }}
      >
        <LogOut />
      </Button>
      {error ? (
        <p
          role="alert"
          className="absolute right-0 top-full z-10 mt-1 whitespace-nowrap rounded-md border border-border bg-background px-2 py-1 text-xs text-destructive shadow"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
