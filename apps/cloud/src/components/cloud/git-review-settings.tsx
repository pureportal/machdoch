"use client";

import { useState } from "react";
import type { GitReviewSettings } from "@/lib/cloud-git-contract";
import { cloudRequest } from "./api-client";

const toggles: {
  key: keyof Omit<GitReviewSettings, "revision">;
  label: string;
}[] = [
  { key: "reviewGuides", label: "Generate review guides" },
  { key: "mergeIssues", label: "Link or create an issue on merge" },
  { key: "commitLinks", label: "Link commits with magic words" },
  {
    key: "backlinksPrivate",
    label: "Back-link comments on private repositories",
  },
  {
    key: "backlinksPublic",
    label: "Back-link comments on public repositories",
  },
  {
    key: "backlinkDescriptions",
    label: "Include issue descriptions in back-links",
  },
];

export function GitReviewSettingsSection({
  settings,
  onChanged,
}: {
  settings: GitReviewSettings;
  onChanged: () => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  return (
    <section
      className="cloud-settings-section"
      aria-labelledby="git-review-settings-heading"
    >
      <header>
        <h2 id="git-review-settings-heading">Reviews & commits</h2>
      </header>
      <ul className="cloud-git-review-settings">
        {toggles.map((toggle) => (
          <li key={toggle.key}>
            <span id={`git-review-${toggle.key}`}>{toggle.label}</span>
            <button
              type="button"
              role="switch"
              className="cloud-automation-switch"
              aria-checked={settings[toggle.key]}
              aria-labelledby={`git-review-${toggle.key}`}
              disabled={pending}
              onClick={() => {
                setPending(true);
                setError("");
                void cloudRequest("git/settings", {
                  method: "PUT",
                  body: { ...settings, [toggle.key]: !settings[toggle.key] },
                })
                  .then(onChanged)
                  .catch((reason: Error) => setError(reason.message))
                  .finally(() => setPending(false));
              }}
            />
          </li>
        ))}
      </ul>
      {error && (
        <p role="alert" className="cloud-error">
          {error}
        </p>
      )}
    </section>
  );
}
