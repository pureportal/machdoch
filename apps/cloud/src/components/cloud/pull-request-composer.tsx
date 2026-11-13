"use client";

import { useState } from "react";
import type { GitReviewInput } from "@/lib/cloud-git-contract";
import { Button } from "@/components/ui/button";
import { cloudRequest } from "./api-client";
import { MarkdownTextarea } from "./markdown-textarea";
import { useToast } from "./toast";

export function PullRequestComposer({
  pullRequestId,
  actingAs,
  onPosted,
}: {
  pullRequestId: string;
  actingAs: string;
  onPosted: () => void;
}) {
  const toast = useToast();
  const [body, setBody] = useState("");
  const [pending, setPending] = useState<GitReviewInput | null>(null);
  const send = (decision: GitReviewInput) => {
    const text = body.trim();
    setPending(decision);
    const request =
      decision === "comment"
        ? cloudRequest(`pull-requests/${pullRequestId}/comments`, {
            method: "POST",
            body: { body: text },
          })
        : cloudRequest(`pull-requests/${pullRequestId}/reviews`, {
            method: "POST",
            body: { decision, body: text },
          });
    void request
      .then(() => {
        setBody("");
        toast(
          decision === "approve"
            ? "Approved"
            : decision === "request_changes"
              ? "Changes requested"
              : "Comment posted",
        );
        onPosted();
      })
      .catch((reason: Error) => toast(reason.message, "error"))
      .finally(() => setPending(null));
  };
  return (
    <form
      className="cloud-pull-request-composer"
      onSubmit={(event) => {
        event.preventDefault();
        if (body.trim()) send("comment");
      }}
    >
      <MarkdownTextarea
        aria-label="Comment"
        placeholder={`Comment as ${actingAs}`}
        value={body}
        maxLength={20000}
        rows={3}
        onChange={(event) => setBody(event.target.value)}
      />
      <div className="cloud-editor-actions">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending !== null}
          onClick={() => send("request_changes")}
        >
          Request changes
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending !== null}
          onClick={() => send("approve")}
        >
          Approve
        </Button>
        <Button
          type="submit"
          size="sm"
          disabled={pending !== null || !body.trim()}
        >
          Comment
        </Button>
      </div>
    </form>
  );
}
