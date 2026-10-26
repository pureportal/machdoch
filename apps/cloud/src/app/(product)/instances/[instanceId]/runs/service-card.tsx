import { ExternalLink, Play, RotateCw, Square, Terminal } from "lucide-react";
import type { RunCommand, RunSnapshot } from "@machdoch/fleet-protocol";
import { ShowMore } from "@/components/show-more";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export function ServiceCard({
  configuration,
  status,
  blocked,
  previewsEnabled,
  onExecute,
  onPreview,
  onLogsChange,
}: {
  configuration: RunSnapshot["document"]["configurations"][number];
  status: RunSnapshot["statuses"][number];
  blocked: boolean;
  previewsEnabled: boolean;
  onExecute: (command: RunCommand) => Promise<boolean>;
  onPreview: (configurationId: string, port: number) => Promise<void>;
  onLogsChange: (open: boolean) => void;
}): React.ReactElement {
  const running = [
    "running",
    "unhealthy",
    "starting",
    "restarting",
    "stopping",
  ].includes(status.state);
  const changing = ["starting", "restarting", "stopping"].includes(
    status.state,
  );
  const command = (action: "start" | "stop" | "restart"): void => {
    void onExecute({
      action,
      commandId: crypto.randomUUID(),
      configurationId: configuration.id,
    });
  };
  return (
    <Card className="p-5 sm:p-6">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-secondary text-primary">
            <Terminal className="size-5" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h2 className="break-words font-semibold">{configuration.name}</h2>
            <p className="mt-1 text-sm capitalize text-muted-foreground">
              {status.state === "stopped" && status.exitCode === 0
                ? "Completed"
                : status.state}
              {status.health ? ` · ${status.health}` : ""}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant={running ? "outline" : "default"}
            disabled={blocked || changing}
            onClick={() => command(running ? "stop" : "start")}
          >
            {running ? <Square /> : <Play />}
            {changing ? `${status.state}…` : running ? "Stop" : "Start"}
          </Button>
          <Button
            variant="outline"
            disabled={blocked || changing}
            onClick={() => command("restart")}
          >
            <RotateCw />
            Restart
          </Button>
        </div>
      </div>
      {configuration.kind === "task" && configuration.ports.length ? (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          {configuration.ports.map((port) => (
            <Button
              key={port}
              variant="outline"
              disabled={
                blocked ||
                !status.pid ||
                !previewsEnabled ||
                !["running", "unhealthy"].includes(status.state)
              }
              onClick={() => void onPreview(configuration.id, port)}
            >
              <ExternalLink />
              Preview :{port}
            </Button>
          ))}
          {!previewsEnabled ? (
            <p className="text-xs text-muted-foreground">
              Previews are not configured.
            </p>
          ) : null}
        </div>
      ) : null}
      <ShowMore className="mt-3">
        <p className="break-all rounded-xl bg-muted/60 p-3 font-mono text-sm">
          {configuration.kind === "task"
            ? configuration.command
            : `${configuration.startOrder} group · ${configuration.children.length} services`}
        </p>
        <p className="text-xs text-muted-foreground">
          {status.pid ? `PID ${status.pid} · ` : ""}
          {status.restartCount} automatic restarts
          {status.startedAt
            ? ` · Started ${new Date(status.startedAt).toLocaleTimeString()}`
            : ""}
          {status.exitCode !== null ? ` · Exit ${status.exitCode}` : ""}
        </p>
      </ShowMore>
      {configuration.kind === "task" ? (
        <details
          className="fleet-disclosure mt-1"
          onToggle={(event) => onLogsChange(event.currentTarget.open)}
        >
          <summary className="flex min-h-11 w-fit cursor-pointer items-center gap-2 rounded-lg text-sm font-medium text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <Terminal className="size-4" aria-hidden="true" />
            Logs
          </summary>
          <pre
            tabIndex={0}
            aria-label={`${configuration.name} logs`}
            className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-xl bg-muted p-4 text-xs leading-relaxed"
          >
            {status.logs.length
              ? status.logs
                  .map(
                    (line) =>
                      `${new Date(line.at).toLocaleTimeString()} ${line.stream}  ${line.line}`,
                  )
                  .join("\n")
              : "No output yet."}
          </pre>
        </details>
      ) : null}
    </Card>
  );
}
