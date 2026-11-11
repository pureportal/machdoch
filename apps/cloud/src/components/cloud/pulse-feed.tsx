"use client";

import Link from "next/link";
import { Activity } from "lucide-react";
import { MarkdownContent } from "@machdoch/client-ui/conversation/markdown-content";
import {
  projectHealthLabels,
  type CloudProjectUpdateEntry,
} from "@/lib/cloud-project-update-contract";
import { PersonAvatar } from "./person-avatar";
import { RelativeTime } from "./relative-time";

const dayFormat = new Intl.DateTimeFormat("en", {
  weekday: "long",
  month: "long",
  day: "numeric",
  timeZone: "UTC",
});

function groupByDay(updates: CloudProjectUpdateEntry[]) {
  const groups: { day: string; updates: CloudProjectUpdateEntry[] }[] = [];
  for (const update of updates) {
    const day = update.createdAt.slice(0, 10);
    const group = groups.at(-1);
    if (group?.day === day) group.updates.push(update);
    else groups.push({ day, updates: [update] });
  }
  return groups;
}

export function PulseFeed({ updates }: { updates: CloudProjectUpdateEntry[] }) {
  return (
    <>
      <header className="cloud-page-header">
        <h1>Pulse</h1>
      </header>
      {!updates.length ? (
        <div className="cloud-empty">
          <Activity aria-hidden="true" />
          <p>No project updates yet.</p>
        </div>
      ) : (
        <div className="cloud-pulse">
          {groupByDay(updates).map((group) => (
            <section key={group.day} aria-label={group.day}>
              <h2>{dayFormat.format(new Date(`${group.day}T12:00:00Z`))}</h2>
              <ol>
                {group.updates.map((update) => (
                  <li key={update.id} className="cloud-pulse-entry">
                    <header>
                      <span
                        className="cloud-project-health"
                        data-health={update.health}
                      >
                        <span aria-hidden="true" />
                        {projectHealthLabels[update.health]}
                      </span>
                      <Link href={`/cloud/projects/${update.projectId}`}>
                        {update.projectName}
                      </Link>
                      <span className="cloud-pulse-author">
                        <PersonAvatar
                          name={update.author}
                          className="cloud-avatar-tiny"
                        />
                        {update.author}
                      </span>
                      <RelativeTime value={update.createdAt} />
                    </header>
                    {update.body && <MarkdownContent content={update.body} />}
                  </li>
                ))}
              </ol>
            </section>
          ))}
        </div>
      )}
    </>
  );
}
