"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Layers, RotateCcw, Eye } from "lucide-react";
import type {
  CloudIssue,
  CloudWorkspace,
  PokerCommand,
  PokerRound,
} from "@/lib/cloud-contract";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/field";
import { FormDialog } from "@/components/form-dialog";
import { PokerVotes } from "./poker-votes";
import {
  CloudRequestError,
  cloudRequest,
  createCommandSender,
  formText,
} from "./api-client";

export function PokerPanel({
  issue,
  workspace,
  dirty,
  onDecision,
}: {
  issue: CloudIssue;
  workspace: CloudWorkspace;
  dirty: boolean;
  onDecision: () => Promise<void>;
}) {
  const [round, setRound] = useState<PokerRound | null>(null);
  const [pending, setPending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [connectionError, setConnectionError] = useState("");
  const [takingOver, setTakingOver] = useState(false);
  const requestSequence = useRef(0);
  const sender = useRef(createCommandSender());
  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      const sequence = ++requestSequence.current;
      const result = await cloudRequest<{ rounds: { id: string }[] }>(
        `issues/${issue.id}/poker`,
        { signal },
      );
      const latest = result.rounds[0];
      const next = latest
        ? await cloudRequest<PokerRound>(`poker/${latest.id}`, { signal })
        : null;
      if (sequence === requestSequence.current) {
        setRound(next);
        setConnectionError("");
        setLoading(false);
      }
    },
    [issue.id],
  );
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        if (!document.hidden) await refresh(abort.signal);
      } catch (reason) {
        if (abort.signal.aborted) return;
        if (
          reason instanceof CloudRequestError &&
          [401, 403, 404].includes(reason.status)
        )
          setRound(null);
        setConnectionError((reason as Error).message);
        setLoading(false);
      }
      if (!abort.signal.aborted) timer = setTimeout(() => void poll(), 3000);
    }
    void poll();
    return () => {
      abort.abort();
      clearTimeout(timer);
      requestSequence.current++;
    };
  }, [refresh]);

  async function perform(action: () => Promise<unknown>) {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      await action();
      await refresh();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setPending(false);
    }
  }
  const writable = workspace.actor.role !== "viewer";
  const facilitator = round?.facilitatorId === workspace.actor.id;
  const active = round?.status === "voting" || round?.status === "revealed";
  const unavailable = pending || dirty || Boolean(connectionError);
  const ownVote = round?.votes.find(
    (vote) => vote.userId === workspace.actor.id,
  )?.card;
  function act(input: PokerCommand) {
    return sender.current(`poker/${round!.id}/commands`, input);
  }
  return (
    <section className="cloud-poker" aria-label="Planning poker">
      <header className="cloud-poker-heading">
        <h2>
          <Layers size={17} aria-hidden="true" />
          {active ? `Round ${round.generation}` : "Planning poker"}
        </h2>
        {active && (
          <span className="cloud-poker-phase" role="status">
            {round.status === "voting" ? "Voting open" : "Votes revealed"}
          </span>
        )}
        {!loading && !active && writable && !issue.archived && (
          <Button
            variant="outline"
            disabled={unavailable}
            title={dirty ? "Save changes before starting poker" : undefined}
            onClick={() =>
              void perform(() =>
                sender.current("poker", {
                  issueId: issue.id,
                  issueRevision: issue.revision,
                }),
              )
            }
          >
            Start poker
          </Button>
        )}
      </header>
      {loading && (
        <p role="status" className="mt-4 text-muted-foreground">
          Loading poker…
        </p>
      )}
      {round && (
        <>
          {round.stale && active && (
            <p role="status" className="cloud-error">
              The issue changed. Restart the round before recording an estimate.
            </p>
          )}
          <div className="cloud-poker-table">
            <div className="cloud-poker-play">
              {round.status === "voting" && (
                <>
                  <h3>Your estimate</h3>
                  <div
                    className="cloud-poker-cards"
                    role="group"
                    aria-label="Estimate cards"
                  >
                    {round.scale.map((card) => (
                      <Button
                        variant="outline"
                        key={card.label}
                        type="button"
                        aria-label={`Vote ${card.label}`}
                        aria-pressed={ownVote === card.label}
                        data-text-card={card.label.length > 3}
                        data-wide-card={card.label.length > 10}
                        disabled={unavailable || !writable || round.stale}
                        onClick={() =>
                          void perform(() =>
                            sender.current(`poker/${round.id}/votes`, {
                              revision: round.revision,
                              card: card.label,
                            }),
                          )
                        }
                      >
                        <span>{card.label}</span>
                        {ownVote === card.label && (
                          <Check size={14} aria-hidden="true" />
                        )}
                      </Button>
                    ))}
                  </div>
                </>
              )}
              {round.status === "decided" && (
                <p role="status" className="cloud-poker-decision">
                  Estimate: <strong>{round.decision}</strong>
                  {round.rationale && (
                    <span className="ml-3 text-muted-foreground">
                      {round.rationale}
                    </span>
                  )}
                </p>
              )}
              {round.status === "closed" && (
                <p className="text-muted-foreground">Round closed</p>
              )}
              {!facilitator &&
                active &&
                ["owner", "admin"].includes(workspace.actor.role) && (
                  <Button
                    variant="outline"
                    disabled={unavailable}
                    onClick={() => setTakingOver(true)}
                  >
                    Take over round
                  </Button>
                )}
              {facilitator && active && (
                <>
                  <div className="cloud-editor-actions">
                    {round.status === "voting" && (
                      <Button
                        variant="default"
                        disabled={unavailable || !round.votes.length}
                        onClick={() =>
                          void perform(() =>
                            act({ kind: "reveal", revision: round.revision }),
                          )
                        }
                      >
                        <Eye aria-hidden="true" />
                        Reveal votes
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      disabled={unavailable}
                      onClick={() =>
                        void perform(() =>
                          act({ kind: "restart", revision: round.revision }),
                        )
                      }
                    >
                      <RotateCcw aria-hidden="true" />
                      Restart round
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={pending}
                      onClick={() =>
                        void perform(() =>
                          act({ kind: "close", revision: round.revision }),
                        )
                      }
                    >
                      Close round
                    </Button>
                  </div>
                  {round.status === "revealed" && (
                    <form
                      className="cloud-poker-decision-form"
                      onSubmit={(event) => {
                        event.preventDefault();
                        const form = new FormData(event.currentTarget);
                        void perform(async () => {
                          await act({
                            kind: "decide",
                            revision: round.revision,
                            issueRevision: issue.revision,
                            card: formText(form, "card"),
                            rationale: formText(form, "rationale"),
                          });
                          await onDecision();
                        });
                      }}
                    >
                      <Field label="Agreed estimate" htmlFor="agreed-estimate">
                        <Select
                          id="agreed-estimate"
                          name="card"
                          required
                          disabled={unavailable || round.stale}
                          defaultValue=""
                        >
                          <option value="" disabled>
                            Select estimate
                          </option>
                          {round.scale
                            .filter((card) => card.points !== null)
                            .map((card) => (
                              <option key={card.label}>{card.label}</option>
                            ))}
                        </Select>
                      </Field>
                      <Field label="Rationale" htmlFor="rationale">
                        <Input
                          id="rationale"
                          name="rationale"
                          maxLength={4000}
                          disabled={unavailable || round.stale}
                        />
                      </Field>
                      <Button
                        type="submit"
                        disabled={unavailable || round.stale}
                      >
                        Record estimate
                      </Button>
                    </form>
                  )}
                </>
              )}
            </div>
            <aside className="cloud-poker-results">
              <PokerVotes round={round} />
            </aside>
          </div>
        </>
      )}
      {!loading && !round && !connectionError && (
        <div className="cloud-poker-empty">
          <Layers size={28} aria-hidden="true" />
          <p>No round started.</p>
        </div>
      )}
      {dirty && writable && (
        <p role="status" className="mt-4 text-muted-foreground">
          Save issue changes to continue planning poker.
        </p>
      )}
      {connectionError && (
        <p role="alert" className="cloud-error">
          {connectionError}
        </p>
      )}
      {error && (
        <p role="alert" className="cloud-error">
          {error}
        </p>
      )}
      <FormDialog
        open={takingOver}
        onOpenChange={setTakingOver}
        title="Take over round"
        submitLabel="Take over round"
        onSubmit={async () => {
          if (!round) return;
          await act({ kind: "takeover", revision: round.revision });
          await refresh();
        }}
      >
        <p>You will replace the current facilitator and control this round.</p>
      </FormDialog>
    </section>
  );
}
