"use client";
import { Button } from "@/components/ui/button";
export default function CloudWorkspaceError({ reset }: { reset: () => void }) {
  return (
    <div className="cloud-empty">
      <p role="alert">This page could not be loaded.</p>
      <Button onClick={reset}>Try again</Button>
      <a className="ml-5 underline" href="/cloud/login">
        Sign in
      </a>
    </div>
  );
}
