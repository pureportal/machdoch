"use client";

import { useState } from "react";
import type { GitReviewSettings } from "@/lib/cloud-git-contract";
import { cloudRequest } from "./api-client";

type ReviewToggleKey = keyof Omit<GitReviewSettings, "revision">;

const toggleGroups: {
  label: string;
  toggles: { key: ReviewToggleKey; label: string }[];
}[] = [
  {
    label: "Pull requests",
    toggles: [
      { key: "reviewGuides", label: "Generate review walkthroughs" },
      { key: "mergeIssues", label: "Link or create an issue on merge" },
      { key: "commitLinks", label: "Link commits by issue key" },
    ],
  },
  {
    label: "Back-link comments",
    toggles: [
      { key: "backlinksPrivate", label: "Private repositories" },
      { key: "backlinksPublic", label: "Public repositories" },
      { key: "backlinkDescriptions", label: "Include issue descriptions" },
    ],
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
        <h2 id="git-review-settings-heading">Code review</h2>
      </header>
      {toggleGroups.map((group) => (
        <fieldset key={group.label} className="cloud-git-review-group">
          <legend>{group.label}</legend>
          <ul className="cloud-git-review-settings">
            {group.toggles.map((toggle) => (
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
                      body: {
                        ...settings,
                        [toggle.key]: !settings[toggle.key],
                      },
                    })
                      .then(onChanged)
                      .catch((reason: Error) => setError(reason.message))
                      .finally(() => setPending(false));
                  }}
                />
              </li>
            ))}
          </ul>
        </fieldset>
      ))}
      {error && (
        <p role="alert" className="cloud-error">
          {error}
        </p>
      )}
    </section>
  );
}
