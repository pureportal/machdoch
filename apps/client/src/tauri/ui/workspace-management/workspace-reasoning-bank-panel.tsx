import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import type { ReasoningLesson } from "../../../core/reasoning-bank.js";
import { loadWorkspaceReasoningBankLessons } from "../runtime";

const Timestamp = ({ value }: { value: number }): JSX.Element => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? (
    <>Unknown</>
  ) : (
    <time dateTime={date.toISOString()}>{date.toLocaleString()}</time>
  );
};

export const WorkspaceReasoningBankPanel = ({
  workspaceRoot,
}: {
  workspaceRoot: string;
}): JSX.Element => {
  const [lessons, setLessons] = useState<ReasoningLesson[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const refresh = useCallback(async (): Promise<void> => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const loaded = await loadWorkspaceReasoningBankLessons(workspaceRoot);
      if (requestId === requestIdRef.current) {
        setLessons(loaded.sort((a, b) => b.updatedAt - a.updatedAt));
      }
    } catch (cause) {
      if (requestId === requestIdRef.current) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [workspaceRoot]);

  useEffect(() => {
    void refresh();
    return () => {
      requestIdRef.current += 1;
    };
  }, [refresh]);

  return (
    <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/20 p-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium text-slate-200">ReasoningBank</h3>
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-label="Refresh ReasoningBank"
          disabled={loading}
          onClick={() => void refresh()}
        >
          <RefreshCw className="size-3.5" />
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-red-300">
          {error}
        </p>
      ) : null}
      {loading && lessons.length === 0 ? (
        <p role="status" className="text-sm text-slate-400">
          Loading…
        </p>
      ) : lessons.length === 0 && !error ? (
        <p className="text-sm text-slate-400">No lessons saved.</p>
      ) : (
        <ul className="space-y-3">
          {lessons.map((lesson) => (
            <li
              key={lesson.id}
              className="space-y-2 rounded-lg border border-slate-800 p-3"
            >
              <h4 className="text-sm font-medium text-slate-100">
                {lesson.title}
              </h4>
              <p className="whitespace-pre-wrap text-sm text-slate-300">
                {lesson.content}
              </p>
              <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-400">
                <div>
                  <dt className="inline">Learned from: </dt>
                  <dd className="inline">{lesson.outcome}</dd>
                </div>
                <div>
                  <dt className="inline">Confidence: </dt>
                  <dd className="inline">
                    {Math.round(lesson.confidence * 100)}%
                  </dd>
                </div>
                <div>
                  <dt className="inline">Evidence: </dt>
                  <dd className="inline">{lesson.evidenceCount}</dd>
                </div>
                <div>
                  <dt className="inline">Helpful: </dt>
                  <dd className="inline">{lesson.helpfulCount}</dd>
                </div>
                <div>
                  <dt className="inline">Harmful: </dt>
                  <dd className="inline">{lesson.harmfulCount}</dd>
                </div>
                <div>
                  <dt className="inline">Retrievals: </dt>
                  <dd className="inline">{lesson.retrievalCount ?? 0}</dd>
                </div>
                {lesson.harmfulCount > lesson.helpfulCount ? (
                  <div>
                    <dt className="inline">Retrieval: </dt>
                    <dd className="inline">Paused</dd>
                  </div>
                ) : null}
                <div>
                  <dt className="inline">Last retrieved: </dt>
                  <dd className="inline">
                    {lesson.lastRetrievedAt === undefined ? (
                      "Never"
                    ) : (
                      <Timestamp value={lesson.lastRetrievedAt} />
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="inline">Created: </dt>
                  <dd className="inline">
                    <Timestamp value={lesson.createdAt} />
                  </dd>
                </div>
                <div>
                  <dt className="inline">Updated: </dt>
                  <dd className="inline">
                    <Timestamp value={lesson.updatedAt} />
                  </dd>
                </div>
              </dl>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};
