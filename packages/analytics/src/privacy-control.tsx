"use client";

import { useId, useState, useSyncExternalStore } from "react";
import { PRIVACY_URL } from "@machdoch/analytics/catalog";
import {
  getConsentSnapshot,
  getServerConsentSnapshot,
  setAnalyticsConsent,
  subscribeConsent,
} from "@machdoch/analytics/browser";

export function AnalyticsPrivacyControl({
  className = "",
  openPrivacy,
}: {
  className?: string;
  openPrivacy?: () => Promise<void>;
}): React.ReactElement {
  const id = useId();
  const [linkError, setLinkError] = useState(false);
  const state = useSyncExternalStore(
    subscribeConsent,
    getConsentSnapshot,
    getServerConsentSnapshot,
  );
  return (
    <div className={`grid gap-2 text-sm ${className}`}>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={state.enabled}
          disabled={state.blocked}
          aria-describedby={id}
          onChange={(event) => setAnalyticsConsent(event.target.checked)}
        />
        Share usage and diagnostics
      </label>
      <p id={id} className="text-muted-foreground">
        {state.blocked
          ? "Your browser privacy preference disables analytics."
          : "Allow PurePortal to measure feature use, performance, and errors with Swetrix. You can turn this off here at any time."}{" "}
        <a
          href={PRIVACY_URL}
          target="_blank"
          rel="noreferrer"
          className="underline"
          onClick={
            openPrivacy
              ? (event) => {
                  event.preventDefault();
                  setLinkError(false);
                  void openPrivacy().catch(() => setLinkError(true));
                }
              : undefined
          }
        >
          Privacy policy
        </a>
      </p>
      {state.error ? <p role="alert">{state.error}</p> : null}
      {linkError ? (
        <p role="alert">
          The privacy policy could not be opened. Open pureportal.io/privacy in
          your browser.
        </p>
      ) : null}
    </div>
  );
}
