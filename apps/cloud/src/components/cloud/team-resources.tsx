"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Link2, Plus, X } from "lucide-react";
import type { TeamResource } from "@/lib/cloud-team-contract";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cloudRequest, createCommandSender } from "./api-client";
import { useToast } from "./toast";

function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./u, "");
  } catch {
    return url;
  }
}

export function TeamResources({
  teamId,
  resources,
  writable,
}: {
  teamId: string;
  resources: TeamResource[];
  writable: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const sender = useRef(createCommandSender());
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [pending, setPending] = useState(false);
  return (
    <section
      className="cloud-card cloud-team-section"
      aria-labelledby="team-resources"
    >
      <header>
        <h2 id="team-resources">Resources</h2>
        {writable && !adding && (
          <Button
            variant="ghost"
            size="icon"
            aria-label="Add resource"
            onClick={() => setAdding(true)}
          >
            <Plus />
          </Button>
        )}
      </header>
      {resources.length > 0 && (
        <ul className="cloud-team-resources">
          {resources.map((resource) => (
            <li key={resource.id}>
              <Link2 size={14} aria-hidden="true" />
              <a href={resource.url} target="_blank" rel="noreferrer">
                <span>{resource.title}</span>
                <small>{host(resource.url)}</small>
              </a>
              {writable && (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove ${resource.title}`}
                  onClick={() =>
                    void cloudRequest(
                      `teams/${teamId}/resources/${resource.id}/remove`,
                      {
                        method: "POST",
                        key: crypto.randomUUID(),
                        body: {},
                      },
                    )
                      .then(() => router.refresh())
                      .catch((reason: Error) => toast(reason.message, "error"))
                  }
                >
                  <X />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {!resources.length && !adding && (
        <p className="cloud-empty-inline">No resources yet.</p>
      )}
      {adding && (
        <form
          className="cloud-team-resource-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (pending) return;
            setPending(true);
            void sender
              .current(`teams/${teamId}/resources`, {
                title: title.trim(),
                url: url.trim(),
              })
              .then(() => {
                sender.current = createCommandSender();
                setTitle("");
                setUrl("");
                setAdding(false);
                router.refresh();
              })
              .catch((reason: Error) => toast(reason.message, "error"))
              .finally(() => setPending(false));
          }}
        >
          <Input
            aria-label="Title"
            placeholder="Title"
            required
            maxLength={120}
            autoFocus
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
          <Input
            aria-label="Link"
            type="url"
            placeholder="https://"
            required
            maxLength={2000}
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />
          <div className="cloud-editor-actions">
            <Button type="submit" size="sm" disabled={pending}>
              Add
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setAdding(false)}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
