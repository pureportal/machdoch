"use client";

import Link from "next/link";
import { pollWhileVisible } from "@machdoch/product-ui/view-visibility";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { CloudAutomationRun } from "@/lib/cloud-automation-contract";
import type { CloudLoopRunDetail } from "@/lib/cloud-loop-contract";
import { formatLoopCost } from "@/lib/loop-list";
import { cloudRequest, createCommandSender } from "./api-client";
import { AutomationRuns, runStateLabels } from "./automation-runs";
import { useToast } from "./toast";

const pollMs = 10_000;
const activePollMs = 2_000;

function RunDetailDialog({
  runId,
  owned,
  canAct,
  onClose,
  onChanged,
}: {
  runId: string;
  owned: boolean;
  canAct: boolean;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const toast = useToast();
  const sender = useRef(createCommandSender());
  const [run, setRun] = useState<CloudLoopRunDetail | null>(null);
  const [answer, setAnswer] = useState("");
  const [pending, setPending] = useState(false);

  const load = useCallback(
    () => cloudRequest<CloudLoopRunDetail>(`loops/runs/${runId}`).then(setRun),
    [runId],
  );
  useEffect(() => {
    void load().catch((reason: Error) => toast(reason.message, "error"));
  }, [load, toast]);
  const active = run?.state === "queued" || run?.state === "running";
  useEffect(() => {
    if (!active) return;
    return pollWhileVisible(
      () => Promise.all([load(), onChanged()]).catch(() => undefined),
      activePollMs,
      { immediate: false },
    );
  }, [active, load, onChanged]);

  async function perform(action: () => Promise<unknown>, success: string) {
    setPending(true);
    try {
      await action();
      await Promise.all([load(), onChanged()]);
      toast(success);
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "Try again.", "error");
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-3xl" aria-describedby={undefined}>
        <DialogTitle>Run</DialogTitle>
        {run && (
          <div className="cloud-loop-run">
            <dl className="cloud-automation-facts">
              <dt>Status</dt>
              <dd>{runStateLabels[run.state]}</dd>
              {run.loopRevision !== null && (
                <>
                  <dt>Revision</dt>
                  <dd>{run.loopRevision}</dd>
                </>
              )}
              <dt>Tokens</dt>
              <dd>{run.tokens.toLocaleString()}</dd>
              <dt>Cost</dt>
              <dd>{formatLoopCost(run.costCents)}</dd>
              {run.approvedByName && (
                <>
                  <dt>Approved by</dt>
                  <dd>{run.approvedByName}</dd>
                </>
              )}
            </dl>
            {run.error && <p role="alert">{run.error}</p>}
            {run.awaitingApproval && canAct && (
              <Button
                disabled={pending}
                onClick={() =>
                  void perform(
                    () =>
                      sender.current(`loops/runs/${run.id}/approval`, {
                        approved: true,
                      }),
                    "Approved",
                  )
                }
              >
                Approve
              </Button>
            )}
            {run.awaitingInput && canAct && (
              <form
                className="flex gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void perform(
                    () =>
                      sender.current(`loops/runs/${run.id}/input`, {
                        value: answer,
                      }),
                    "Answer sent",
                  );
                }}
              >
                <Input
                  value={answer}
                  required
                  aria-label={run.awaitingInput}
                  placeholder={run.awaitingInput}
                  onChange={(event) => setAnswer(event.target.value)}
                />
                <Button type="submit" disabled={pending}>
                  Send
                </Button>
              </form>
            )}
            {run.steps.length > 0 && (
              <>
                <h3>Outputs</h3>
                <ul className="cloud-automation-run-steps">
                  {run.steps.map((step, index) => (
                    <li key={index} data-state={step.state}>
                      <span>{step.detail}</span>
                      {step.link && <Link href={step.link}>Open</Link>}
                    </li>
                  ))}
                </ul>
              </>
            )}
            <h3>Payload</h3>
            <pre className="cloud-loop-code">
              {JSON.stringify(run.payload, null, 2)}
            </pre>
            {run.resolvedContext && run.resolvedContext.length > 0 && (
              <>
                <h3>Context</h3>
                {run.resolvedContext.map((entry, index) => (
                  <section key={index}>
                    <h4>{entry.title}</h4>
                    <ul>
                      {entry.items.map((item, itemIndex) => (
                        <li key={itemIndex}>{item}</li>
                      ))}
                    </ul>
                  </section>
                ))}
              </>
            )}
            {run.transcript.length > 0 && (
              <>
                <h3>Transcript</h3>
                <ol className="cloud-loop-transcript">
                  {run.transcript.map((turn, index) => (
                    <li key={index}>
                      <pre className="cloud-loop-code">{turn.prompt}</pre>
                      {turn.steps.length > 0 && (
                        <ul className="cloud-automation-run-steps">
                          {turn.steps.map((step) => (
                            <li
                              key={step.id}
                              data-state={step.failed ? "failed" : "succeeded"}
                            >
                              <span>{step.tool}</span>
                              <span className="cloud-automation-muted">
                                {step.label}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                      <p>{turn.answer}</p>
                    </li>
                  ))}
                </ol>
              </>
            )}
            {owned && (
              <div className="cloud-release-actions">
                <Button
                  variant="outline"
                  disabled={pending}
                  onClick={() =>
                    void perform(
                      () => sender.current(`loops/runs/${run.id}/replay`, {}),
                      "Replay started",
                    )
                  }
                >
                  Replay
                </Button>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function LoopRuns({
  loopId,
  owned,
  canAct,
}: {
  loopId: string;
  owned: boolean;
  canAct: boolean;
}) {
  const toast = useToast();
  const sender = useRef(createCommandSender());
  const [runs, setRuns] = useState<CloudAutomationRun[]>([]);
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const load = useCallback(async () => {
    setRuns(
      await cloudRequest<CloudAutomationRun[]>(
        `automations/runs?automationId=${loopId}`,
      ),
    );
  }, [loopId]);
  useEffect(() => {
    void load().catch((reason: Error) => toast(reason.message, "error"));
    return pollWhileVisible(() => load().catch(() => undefined), pollMs, {
      immediate: false,
    });
  }, [load, toast]);

  async function dryRun() {
    setStarting(true);
    try {
      const { runId } = await sender.current<{ runId: string }>(
        `loops/${loopId}/dry-run`,
        { runId: null },
      );
      sender.current = createCommandSender();
      await load();
      setOpenRunId(runId);
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "Try again.", "error");
    } finally {
      setStarting(false);
    }
  }

  return (
    <section className="cloud-loop-section" aria-labelledby="loop-runs">
      <header>
        <h2 id="loop-runs">Runs</h2>
        {owned && (
          <Button
            variant="outline"
            size="sm"
            disabled={starting}
            onClick={() => void dryRun()}
          >
            Dry run
          </Button>
        )}
      </header>
      <AutomationRuns runs={runs} onOpen={(run) => setOpenRunId(run.id)} />
      {openRunId && (
        <RunDetailDialog
          runId={openRunId}
          owned={owned}
          canAct={canAct}
          onClose={() => setOpenRunId(null)}
          onChanged={load}
        />
      )}
    </section>
  );
}
