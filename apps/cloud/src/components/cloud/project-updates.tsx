"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { CloudMarkdown } from "./cloud-markdown";
import { MarkdownTextarea } from "./markdown-textarea";
import {
  projectHealthLabels,
  projectHealths,
  type CloudProjectUpdate,
  type ProjectHealth,
} from "@/lib/cloud-project-update-contract";
import { Button } from "@/components/ui/button";
import { createCommandSender } from "./api-client";
import { PersonAvatar } from "./person-avatar";
import { RelativeTime } from "./relative-time";
import { useToast } from "./toast";

export function ProjectUpdates({
  projectId,
  updates,
  writable,
}: {
  projectId: string;
  updates: CloudProjectUpdate[];
  writable: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [writing, setWriting] = useState(false);
  const [health, setHealth] = useState<ProjectHealth>(
    updates[0]?.health ?? "on_track",
  );
  const [body, setBody] = useState("");
  const [pending, setPending] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const sender = useRef(createCommandSender());
  const shown = updates.slice(0, expanded ? 10 : 1);
  const earlier = Math.min(updates.length, 10) - shown.length;
  return (
    <section
      className="cloud-project-updates"
      aria-labelledby="updates-heading"
    >
      <header>
        <h2 id="updates-heading">Updates</h2>
        {writable && !writing && (
          <Button variant="ghost" size="sm" onClick={() => setWriting(true)}>
            Write update
          </Button>
        )}
      </header>
      {writing && (
        <form
          className="cloud-project-update-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (pending) return;
            setPending(true);
            void sender
              .current(`projects/${projectId}/updates`, {
                health,
                body: body.trim(),
              })
              .then(() => {
                sender.current = createCommandSender();
                setBody("");
                setWriting(false);
                router.refresh();
              })
              .catch((reason: Error) => toast(reason.message, "error"))
              .finally(() => setPending(false));
          }}
        >
          <div
            className="cloud-health-picker"
            role="radiogroup"
            aria-label="Health"
          >
            {projectHealths.map((entry) => (
              <button
                key={entry}
                type="button"
                role="radio"
                aria-checked={health === entry}
                data-health={entry}
                onClick={() => setHealth(entry)}
              >
                <span aria-hidden="true" />
                {projectHealthLabels[entry]}
              </button>
            ))}
          </div>
          <MarkdownTextarea
            aria-label="Update"
            placeholder="What changed since the last update?"
            value={body}
            maxLength={20000}
            rows={4}
            autoFocus
            onChange={(event) => setBody(event.target.value)}
          />
          <div className="cloud-editor-actions">
            <Button type="submit" size="sm" disabled={pending}>
              Post update
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setWriting(false)}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
      {updates.length > 0 && (
        <ol>
          {shown.map((update) => (
            <li key={update.id}>
              <div className="cloud-project-update-heading">
                <span
                  className="cloud-project-health"
                  data-health={update.health}
                >
                  <span aria-hidden="true" />
                  {projectHealthLabels[update.health]}
                </span>
                <PersonAvatar
                  name={update.author}
                  className="cloud-avatar-tiny"
                />
                <strong>{update.author}</strong>
                <RelativeTime value={update.createdAt} />
              </div>
              {update.body && <CloudMarkdown content={update.body} />}
            </li>
          ))}
        </ol>
      )}
      {earlier > 0 && (
        <Button
          variant="ghost"
          size="sm"
          className="cloud-project-updates-more"
          onClick={() => setExpanded(true)}
        >
          Earlier updates ({earlier})
        </Button>
      )}
    </section>
  );
}
