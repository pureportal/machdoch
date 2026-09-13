import type { ProductSnapshot } from "@machdoch/fleet-protocol";
import { MessageSquare, Square } from "lucide-react";
import { formatDuration } from "./format";
import type { ProductCommandHandler } from "./product-runtime";

export function InspectorTasks({
  snapshot,
  pending,
  onCommand,
  onOpenChat,
}: {
  snapshot: ProductSnapshot;
  pending: boolean;
  onCommand: ProductCommandHandler;
  onOpenChat: (sessionId: string) => Promise<boolean>;
}): React.ReactElement {
  if (snapshot.sessions.length === 0) {
    return <p className="m-product-empty-small">No tasks</p>;
  }
  return (
    <div className="m-product-card-list">
      {snapshot.sessions.map((task) => {
        const session = snapshot.shell?.sessions.find(
          (item) => item.runningTaskId === task.taskId,
        );
        return (
          <article
            key={task.taskId}
            className="m-product-card m-product-task-card"
            aria-label={task.task}
          >
            <div className="m-product-card-heading">
              <strong>{task.task}</strong>
              <span data-state={task.state}>{task.state}</span>
            </div>
            <p>{task.message}</p>
            <div className="m-product-card-meta">
              <span>{task.mode}</span>
              <span>{formatDuration(task.startedAt, task.updatedAt)}</span>
            </div>
            {task.timeline.length || task.logs.length ? (
              <details className="m-product-task-details">
                <summary>Task details</summary>
                {task.timeline.length ? (
                  <ol
                    className="m-product-task-timeline"
                    aria-label="Task progress"
                  >
                    {task.timeline.map((entry, index) => (
                      <li key={`${entry.createdAt}:${index}`}>
                        <strong>{entry.label}</strong>
                        {entry.detail ? <p>{entry.detail}</p> : null}
                      </li>
                    ))}
                  </ol>
                ) : null}
                {task.logs.length ? (
                  <pre tabIndex={0} aria-label="Task logs">
                    {task.logs
                      .map(
                        (log) =>
                          `${new Date(log.createdAt).toLocaleTimeString()} ${log.toolName ?? log.stream}\n${log.chunk}`,
                      )
                      .join("\n")}
                  </pre>
                ) : null}
              </details>
            ) : null}
            <div className="m-product-card-actions">
              {session ? (
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => void onOpenChat(session.id)}
                >
                  <MessageSquare aria-hidden="true" />
                  Open chat
                </button>
              ) : null}
              {task.cancellable ? (
                <button
                  type="button"
                  className="m-product-secondary-button"
                  disabled={pending}
                  onClick={() =>
                    void onCommand({ kind: "cancel", taskId: task.taskId })
                  }
                >
                  <Square aria-hidden="true" />
                  Cancel
                </button>
              ) : null}
            </div>
          </article>
        );
      })}
    </div>
  );
}
