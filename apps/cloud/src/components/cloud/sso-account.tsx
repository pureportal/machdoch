"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cloudRequest } from "./api-client";

export function SsoAccount({
  identities,
}: {
  identities: {
    id: string;
    name: string;
    issuer: string;
    enabled: boolean;
    subject: string | null;
  }[];
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  if (!identities.length) return null;
  return (
    <>
      <section className="cloud-settings-section">
        <h2>Sign-in identities</h2>
        <ul className="cloud-member-list">
          {identities.map((identity) => (
            <li key={identity.id}>
              <div>
                <strong>{identity.name}</strong>
                <span className="break-all">{identity.issuer}</span>
                {identity.subject && (
                  <span className="break-all">{identity.subject}</span>
                )}
              </div>
              {!identity.enabled ? (
                <span>Disabled</span>
              ) : identity.subject ? (
                <span>Linked</span>
              ) : (
                <Button
                  variant="outline"
                  aria-disabled={pending}
                  onClick={() => {
                    if (pending) return;
                    setPending(true);
                    setError("");
                    void cloudRequest<{ url: string }>("sso-link", {
                      method: "POST",
                      body: { providerId: identity.id },
                    })
                      .then((result) => location.assign(result.url))
                      .catch((reason: Error) => {
                        setError(reason.message);
                        setPending(false);
                      });
                  }}
                >
                  Link {identity.name}
                </Button>
              )}
            </li>
          ))}
        </ul>
        {error && (
          <p role="alert" className="cloud-error">
            {error}
          </p>
        )}
      </section>
    </>
  );
}
