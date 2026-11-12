"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  CalendarRange,
  Check,
  ChevronRight,
  CircleDot,
  Copy,
  FileText,
  FolderKanban,
  LoaderCircle,
  Users,
  X,
} from "lucide-react";
import { CloudMarkdown } from "../cloud-markdown";
import {
  chatErrorMessages,
  type AgentAction,
  type ChatContextEntity,
  type ChatContextKind,
  type CloudChatTurn,
} from "@/lib/cloud-chat-contract";
import { Button } from "@/components/ui/button";

export const contextIcons: Record<ChatContextKind, typeof CircleDot> = {
  issue: CircleDot,
  project: FolderKanban,
  cycle: CalendarRange,
  team: Users,
};

const entityRoutes: [RegExp, ChatContextKind][] = [
  [/^\/cloud\/issues\/[0-9a-f-]{36}$/i, "issue"],
  [/^\/cloud\/issues\/[A-Z][A-Z0-9]{1,9}-\d+$/, "issue"],
  [/^\/cloud\/projects\/[0-9a-f-]{36}$/i, "project"],
  [/^\/cloud\/cycles\/[0-9a-f-]{36}$/i, "cycle"],
  [/^\/cloud\/initiatives\/[0-9a-f-]{36}$/i, "project"],
];

const answerComponents = {
  img: ({ src, alt }: { src?: string | Blob; alt?: string }) =>
    typeof src === "string" && src.startsWith("/api/v1/attachments/") ? (
      <a href={src} target="_blank" rel="noopener">
        <img
          className="app-markdown-image"
          src={src}
          alt={alt ?? ""}
          loading="lazy"
        />
      </a>
    ) : (
      <span>{alt}</span>
    ),
  a: ({ href, children }: { href?: string; children?: React.ReactNode }) => {
    const kind = href
      ? entityRoutes.find(([pattern]) => pattern.test(href))?.[1]
      : undefined;
    if (href && kind) {
      const Icon = contextIcons[kind];
      return (
        <Link className="cloud-entity-chip" data-kind={kind} href={href}>
          <Icon size={12} aria-hidden="true" />
          <span>{children}</span>
        </Link>
      );
    }
    return href?.startsWith("/cloud/") ? (
      <Link className="app-markdown-link" href={href}>
        {children}
      </Link>
    ) : (
      <a
        className="app-markdown-link"
        href={href}
        target="_blank"
        rel="noopener noreferrer"
      >
        {children}
      </a>
    );
  },
};

function seconds(from: string, to: number): number {
  return Math.max(0, Math.round((to - Date.parse(from)) / 1000));
}

function duration(total: number): string {
  if (total < 60) return `${total} second${total === 1 ? "" : "s"}`;
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes} minute${minutes === 1 ? "" : "s"}${rest ? ` ${rest} second${rest === 1 ? "" : "s"}` : ""}`;
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

function AgentProgress({
  turn,
  active,
}: {
  turn: CloudChatTurn;
  active: boolean;
}) {
  const now = useNow(active);
  if (!turn.startedAt && active)
    return (
      <p className="cloud-agent-progress" role="status">
        <LoaderCircle size={13} className="animate-spin" aria-hidden="true" />
        {turn.state === "queued" ? "Queued" : "Starting"}
      </p>
    );
  if (!turn.startedAt) return null;
  const elapsed = seconds(
    turn.startedAt,
    turn.finishedAt ? Date.parse(turn.finishedAt) : now,
  );
  const label = active
    ? turn.state === "cancel_requested"
      ? "Stopping…"
      : `Working · ${duration(elapsed)}`
    : `Worked for ${duration(elapsed)}`;
  if (!turn.steps.length)
    return (
      <p className="cloud-agent-progress" role={active ? "status" : undefined}>
        {active && (
          <LoaderCircle size={13} className="animate-spin" aria-hidden="true" />
        )}
        {label}
      </p>
    );
  return (
    <details className="cloud-agent-steps" open={active}>
      <summary className="cloud-agent-progress">
        {active && (
          <LoaderCircle size={13} className="animate-spin" aria-hidden="true" />
        )}
        {label}
        <ChevronRight size={12} aria-hidden="true" />
      </summary>
      <ol>
        {turn.steps.map((step) => (
          <li key={step.id} data-failed={step.failed || undefined}>
            {step.failed ? (
              <X size={12} aria-hidden="true" />
            ) : (
              <Check size={12} aria-hidden="true" />
            )}
            <span>{step.label}</span>
          </li>
        ))}
      </ol>
    </details>
  );
}

function actionVerb(action: AgentAction): string {
  if (action.kind === "create_issue") return "Create issue";
  if (action.kind === "comment") return "Post comment";
  if (action.kind === "project_update") return "Post update";
  if (action.kind === "triage") return "Apply decision";
  if (action.kind === "release_notes") return "Use notes";
  if (action.kind === "release_post") return "Use post";
  if (action.kind === "release_visual") return "Create visual";
  if (action.kind === "automation")
    return action.automationId ? "Save automation" : "Create automation";
  if (action.kind === "client_session") return "Start session";
  if (action.kind === "link")
    return action.relationId ? "Remove link" : "Add link";
  if (action.kind === "update_issues" && action.changes.archived === true)
    return "Archive";
  if (action.kind === "update_issues" && action.changes.archived === false)
    return "Restore";
  return "Apply changes";
}

function appliedLabel(action: AgentAction): string {
  if (action.kind === "create_issue") return "Created";
  if (action.kind === "comment") return "Commented on";
  if (action.kind === "project_update") return "Posted to";
  if (action.kind === "triage") return "Triaged";
  if (action.kind === "release_visual") return "Added a visual to";
  if (action.kind === "automation")
    return action.automationId ? "Saved" : "Created";
  if (action.kind === "client_session") return "Started on";
  if (action.kind === "release_notes" || action.kind === "release_post")
    return "Drafted";
  if (action.kind === "link") return action.relationId ? "Unlinked" : "Linked";
  if (action.kind === "update_issues" && action.changes.archived === true)
    return "Archived";
  if (action.kind === "update_issues" && action.changes.archived === false)
    return "Restored";
  return "Updated";
}

function ActionResult({ action }: { action: AgentAction }) {
  const result = action.result!;
  const content = (
    <>
      <Check size={12} aria-hidden="true" />
      <span>
        {appliedLabel(action)} {result.label}
      </span>
    </>
  );
  if (result.kind === "issues")
    return (
      <span className="cloud-entity-chip" data-kind="issue">
        {content}
      </span>
    );
  return (
    <Link
      className="cloud-entity-chip"
      data-kind={result.kind}
      href={
        result.href ??
        (result.kind === "automation"
          ? `/cloud/automations?automation=${result.id}`
          : `/cloud/${result.kind === "issue" ? "issues" : result.kind === "release" ? "releases" : "projects"}/${result.id}`)
      }
    >
      {content}
    </Link>
  );
}

function CopyAnswer({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="cloud-agent-copy"
      aria-label={copied ? "Copied" : "Copy answer"}
      onClick={() =>
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        })
      }
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
    </button>
  );
}

function ActionCard({
  action,
  writable,
  disabled,
  onDecide,
}: {
  action: AgentAction;
  writable: boolean;
  disabled: boolean;
  onDecide: (decision: "apply" | "dismiss") => void;
}) {
  const verb = actionVerb(action);
  return (
    <section className="cloud-agent-action" data-state={action.state}>
      <h3>{action.title}</h3>
      {action.fields.length > 0 && (
        <dl>
          {action.fields.map((field) => (
            <div
              key={`${field.label}:${field.value}`}
              data-markdown={field.markdown || undefined}
            >
              <dt>{field.label}</dt>
              <dd>
                {field.markdown ? (
                  <CloudMarkdown content={field.value} />
                ) : (
                  field.value
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {action.error && (
        <p className="cloud-error" role="alert">
          {action.error}
        </p>
      )}
      <footer>
        {action.state === "applied" && action.result ? (
          <ActionResult action={action} />
        ) : action.state === "dismissed" ? (
          <span className="cloud-agent-action-state">Dismissed</span>
        ) : (
          writable && (
            <>
              <Button
                size="sm"
                disabled={disabled}
                onClick={() => onDecide("apply")}
              >
                {verb}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={disabled}
                onClick={() => onDecide("dismiss")}
              >
                Dismiss
              </Button>
            </>
          )
        )}
      </footer>
    </section>
  );
}

export function AgentTurn({
  turn,
  context,
  latest,
  answeredWith,
  writable,
  pending,
  onAnswer,
  onCancel,
  onRetry,
  onAction,
}: {
  turn: CloudChatTurn;
  context: ChatContextEntity[];
  latest: boolean;
  answeredWith: string | null;
  writable: boolean;
  pending: boolean;
  onAnswer: (option: string) => void;
  onCancel: () => void;
  onRetry: () => void;
  onAction: (action: AgentAction, decision: "apply" | "dismiss") => void;
}) {
  const active = ["queued", "running", "cancel_requested"].includes(turn.state);
  const added = context.filter((entry) => entry.turnSequence === turn.sequence);
  return (
    <li className="cloud-agent-turn">
      <div className="cloud-agent-prompt">
        <p>{turn.prompt}</p>
        {turn.attachments.length > 0 && (
          <ul className="cloud-agent-attachments" aria-label="Attached files">
            {turn.attachments.map((attachment) => (
              <li key={attachment.id}>
                <a
                  className="cloud-agent-attachment"
                  href={attachment.url}
                  target="_blank"
                  rel="noopener"
                  title={attachment.name}
                >
                  {attachment.kind === "image" ? (
                    <img src={attachment.url} alt="" loading="lazy" />
                  ) : (
                    <FileText size={18} aria-hidden="true" />
                  )}
                  <span>{attachment.name}</span>
                </a>
              </li>
            ))}
          </ul>
        )}
        {added.length > 0 && (
          <ul className="cloud-agent-added" aria-label="Added to context">
            {added.map((entry) => {
              const Icon = contextIcons[entry.kind];
              return (
                <li key={`${entry.kind}:${entry.id}`}>
                  <Icon size={12} aria-hidden="true" />
                  <span>{entry.label}</span> added to context
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <article className="cloud-agent-answer" aria-busy={active}>
        <AgentProgress turn={turn} active={active} />
        {turn.answer && (
          <CloudMarkdown content={turn.answer} components={answerComponents} />
        )}
        {turn.answer && turn.state === "complete" && (
          <CopyAnswer text={turn.answer} />
        )}
        {turn.question && (
          <section className="cloud-agent-question">
            <p>{turn.question.text}</p>
            <div>
              {turn.question.options.map((option) => (
                <button
                  key={option}
                  type="button"
                  aria-pressed={answeredWith === option}
                  disabled={!writable || !latest || pending || active}
                  onClick={() => onAnswer(option)}
                >
                  {option}
                  {answeredWith === option && (
                    <Check size={13} aria-hidden="true" />
                  )}
                </button>
              ))}
            </div>
          </section>
        )}
        {turn.actions.map((action) => (
          <ActionCard
            key={action.id}
            action={action}
            writable={writable}
            disabled={pending || active}
            onDecide={(decision) => onAction(action, decision)}
          />
        ))}
        {turn.errorCode && (
          <p className="cloud-error" role="status">
            {chatErrorMessages[turn.errorCode] ??
              "The response could not be completed."}
          </p>
        )}
        {turn.state === "canceled" && !turn.errorCode && (
          <p className="cloud-agent-muted">Stopped</p>
        )}
        {writable &&
          (["queued", "running"].includes(turn.state) ||
            (latest &&
              ["failed", "canceled", "unknown"].includes(turn.state))) && (
            <div className="cloud-agent-turn-actions">
              {["queued", "running"].includes(turn.state) ? (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={pending}
                  onClick={onCancel}
                >
                  Stop
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pending}
                  onClick={onRetry}
                >
                  Retry
                </Button>
              )}
            </div>
          )}
      </article>
    </li>
  );
}
