"use client";

import { useState } from "react";
import type { ProviderBudget } from "@/lib/cloud-chat-contract";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { cloudRequest } from "./api-client";

export function ProviderUsage({ providerId }: { providerId: string }) {
  const [usage, setUsage] = useState<ProviderBudget | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  return (
    <>
      <Button
        variant="ghost"
        disabled={pending}
        onClick={() => {
          setPending(true);
          setError("");
          void cloudRequest<ProviderBudget>(`inference-budgets/${providerId}`)
            .then(setUsage)
            .catch((reason: Error) => setError(reason.message))
            .finally(() => setPending(false));
        }}
      >
        Token usage
      </Button>
      {error && (
        <p role="alert" className="cloud-error">
          {error}
        </p>
      )}
      <Dialog
        open={usage !== null}
        onOpenChange={(open) => {
          if (!open) setUsage(null);
        }}
      >
        <DialogContent aria-describedby={undefined}>
          <DialogTitle>Token usage</DialogTitle>
          {usage && (
            <dl className="cloud-properties">
              <div>
                <dt>Day (UTC)</dt>
                <dd>{usage.budgetDay}</dd>
              </div>
              <div>
                <dt>Used</dt>
                <dd>{usage.usedTokens.toLocaleString()}</dd>
              </div>
              <div>
                <dt>Reserved</dt>
                <dd>{usage.reservedTokens.toLocaleString()}</dd>
              </div>
              <div>
                <dt>Daily budget</dt>
                <dd>{usage.dailyTokenBudget.toLocaleString()}</dd>
              </div>
              <div>
                <dt>Request slots</dt>
                <dd>
                  {usage.activeRequests} / {usage.maxConcurrentRequests}
                </dd>
              </div>
            </dl>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
