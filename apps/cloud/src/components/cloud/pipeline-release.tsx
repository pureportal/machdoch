"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ExternalLink, Megaphone, Plus, X } from "lucide-react";
import { useRef, useState } from "react";
import { Field } from "@/components/field";
import { FormDialog } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { CloudIssue, CloudWorkspace } from "@/lib/cloud-contract";
import { holderCan } from "@/lib/cloud-permissions";
import type { PipelineReleaseDetail } from "@/lib/cloud-release-pipeline-contract";
import type { CloudProduct } from "@/lib/cloud-release-contract";
import { cloudRequest, createCommandSender, formText } from "./api-client";
import { RelationPicker } from "./relation-picker";
import { RelativeTime } from "./relative-time";
import { useToast } from "./toast";

function AddIssueDialog({
  releaseId,
  onClose,
  onAdded,
}: {
  releaseId: string;
  onClose: () => void;
  onAdded: () => void;
}) {
  const [issue, setIssue] = useState<CloudIssue | null>(null);
  return (
    <FormDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title="Add issue"
      submitLabel="Add"
      submitDisabled={!issue}
      onSubmit={async () => {
        if (!issue) return;
        await cloudRequest(`pipeline-releases/${releaseId}/issues`, {
          method: "POST",
          body: { issueId: issue.id },
        });
        onAdded();
      }}
    >
      <RelationPicker issueId="" selected={issue} onSelect={setIssue} />
    </FormDialog>
  );
}

function LaunchDialog({
  releaseId,
  products,
  onClose,
}: {
  releaseId: string;
  products: CloudProduct[];
  onClose: () => void;
}) {
  const router = useRouter();
  const sender = useRef(createCommandSender());
  return (
    <FormDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title="Create launch post"
      submitLabel="Open in Release Studio"
      onSubmit={async (form) => {
        const { id } = await sender.current<{ id: string }>(
          `pipeline-releases/${releaseId}/launch`,
          { productId: formText(form, "productId") },
        );
        router.push(`/cloud/releases/${id}`);
      }}
    >
      <Field label="Product" htmlFor="launch-product">
        <Select
          id="launch-product"
          name="productId"
          required
          defaultValue={products[0]?.id}
        >
          {products.map((product) => (
            <option key={product.id} value={product.id}>
              {product.name}
            </option>
          ))}
        </Select>
      </Field>
    </FormDialog>
  );
}

function NotesField({
  id,
  label,
  value,
}: {
  id: string;
  label: string;
  value: string;
}) {
  const toast = useToast();
  return (
    <Field label={label} htmlFor={id}>
      <Textarea id={id} readOnly rows={8} value={value} />
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() =>
          void navigator.clipboard
            .writeText(value)
            .then(() => toast("Copied"))
            .catch((reason: Error) => toast(reason.message, "error"))
        }
      >
        Copy
      </Button>
    </Field>
  );
}

export function PipelineRelease({
  workspace,
  release,
  products,
}: {
  workspace: CloudWorkspace;
  release: PipelineReleaseDetail;
  products: CloudProduct[];
}) {
  const router = useRouter();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const canWrite = holderCan(workspace.actor, "releases.edit");
  async function remove(issueId: string) {
    setRemoving(issueId);
    try {
      await cloudRequest(`pipeline-releases/${release.id}/issues/${issueId}`, {
        method: "DELETE",
      });
      router.refresh();
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "Try again.", "error");
    } finally {
      setRemoving(null);
    }
  }
  return (
    <>
      <header className="cloud-page-header">
        <h1>
          <Link href={`/cloud/releases/pipelines/${release.pipelineId}`}>
            {release.pipelineName}
          </Link>{" "}
          › {release.version}
        </h1>
        {canWrite && (
          <div className="cloud-release-actions">
            <Button variant="outline" onClick={() => setAdding(true)}>
              <Plus />
              Add issue
            </Button>
            {products.length > 0 && (
              <Button onClick={() => setLaunching(true)}>
                <Megaphone />
                Create launch post
              </Button>
            )}
          </div>
        )}
      </header>
      <dl className="cloud-pipeline-fields">
        <dt>Environment</dt>
        <dd>{release.environment}</dd>
        <dt>Deployed</dt>
        <dd>
          <RelativeTime value={release.deployedAt} />
        </dd>
        {(release.fromSha || release.toSha) && (
          <>
            <dt>Commits</dt>
            <dd>
              <code>
                {release.fromSha ? release.fromSha.slice(0, 7) : "…"}…
                {release.toSha ? release.toSha.slice(0, 7) : ""}
              </code>
            </dd>
          </>
        )}
        {release.evidenceUrl && (
          <>
            <dt>Deployment</dt>
            <dd>
              <a href={release.evidenceUrl} target="_blank" rel="noreferrer">
                <ExternalLink size={13} aria-hidden="true" />
                {new URL(release.evidenceUrl).host}
              </a>
            </dd>
          </>
        )}
      </dl>
      <section className="cloud-pipeline-section" aria-labelledby="issues">
        <h2 id="issues">Issues</h2>
        {!release.issues.length ? (
          <div className="cloud-empty">
            <p>No issues in this release.</p>
          </div>
        ) : (
          <ul className="cloud-release-list" aria-labelledby="issues">
            {release.issues.map((issue) => (
              <li key={issue.issueId} className="cloud-pipeline-issue">
                <Link href={`/cloud/issues/${issue.issueId}`}>
                  <span className="cloud-release-title">
                    <strong>
                      {issue.identifier} {issue.title}
                    </strong>
                    <span>
                      {issue.state}
                      {issue.source === "manual" ? " · Added manually" : ""}
                      {issue.pullRequests.map((pull) => ` · #${pull.number}`)}
                    </span>
                  </span>
                </Link>
                {canWrite && (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove ${issue.identifier}`}
                    disabled={removing === issue.issueId}
                    onClick={() => void remove(issue.issueId)}
                  >
                    <X />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="cloud-pipeline-notes" aria-label="Notes">
        <NotesField
          id="internal-notes"
          label="Internal notes"
          value={release.notes.internal}
        />
        <NotesField
          id="external-notes"
          label="External notes"
          value={release.notes.external}
        />
      </section>
      {adding && (
        <AddIssueDialog
          releaseId={release.id}
          onClose={() => setAdding(false)}
          onAdded={() => router.refresh()}
        />
      )}
      {launching && (
        <LaunchDialog
          releaseId={release.id}
          products={products}
          onClose={() => setLaunching(false)}
        />
      )}
    </>
  );
}
