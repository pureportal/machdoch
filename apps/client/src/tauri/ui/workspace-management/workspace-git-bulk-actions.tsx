import {
  ArrowDownToLine,
  GitBranch,
  GitCommitHorizontal,
  LoaderCircle,
} from "lucide-react";
import { useState, type JSX } from "react";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import { Input } from "@machdoch/media-studio/tauri/ui/components/ui/input.js";
import {
  loadWorkspaceGitBranchStatus,
  runWorkspaceGitAction,
  switchWorkspaceGitBranches,
  type WorkspaceGitRepositoriesStatus,
} from "../runtime";
import type { WorkspaceGitControls } from "./use-workspace-git";
import {
  describeSkipped,
  planBulkBranchSwitch,
  planBulkCommit,
  planBulkPull,
  type BulkSkip,
} from "./workspace-git-bulk";

type BulkForm = "switch" | "commit" | null;
type BulkTask = "pull" | "switch" | "commit";

const failureText = (relativePath: string, error: unknown): string =>
  `${relativePath || "."}: ${error instanceof Error ? error.message : String(error)}`;

export const WorkspaceGitBulkActions = ({
  controls,
  status,
}: {
  controls: WorkspaceGitControls;
  status: WorkspaceGitRepositoriesStatus;
}): JSX.Element => {
  const [form, setForm] = useState<BulkForm>(null);
  const [value, setValue] = useState("");
  const [running, setRunning] = useState<BulkTask | null>(null);
  const [report, setReport] = useState<string | null>(null);

  const run = async (
    task: BulkTask,
    work: () => Promise<{ failures: string[]; skipped: BulkSkip[] }>,
  ): Promise<void> => {
    setRunning(task);
    setReport(null);
    try {
      const { failures, skipped } = await work();
      const lines = [...failures, describeSkipped(skipped)].filter(Boolean);
      setReport(lines.length > 0 ? lines.join("\n") : null);
      if (failures.length === 0) {
        setForm(null);
        setValue("");
      }
    } catch (error) {
      setReport(error instanceof Error ? error.message : String(error));
    } finally {
      setRunning(null);
      void controls.refresh();
    }
  };

  const pullAll = (): Promise<void> =>
    run("pull", async () => {
      const plan = planBulkPull(status.repositories);
      const failures: string[] = [];
      for (const repository of plan.targets) {
        await runWorkspaceGitAction(
          status.workspaceRoot,
          repository.repositoryRoot,
          "pull",
        ).catch((error: unknown) =>
          failures.push(failureText(repository.relativePath, error)),
        );
      }
      return { failures, skipped: plan.skipped };
    });

  const switchAll = (branchName: string): Promise<void> =>
    run("switch", async () => {
      const plan = planBulkBranchSwitch(
        await loadWorkspaceGitBranchStatus(status.workspaceRoot, branchName),
        branchName,
      );
      const results = plan.targets.length
        ? await switchWorkspaceGitBranches(
            status.workspaceRoot,
            plan.targets,
            true,
          )
        : [];
      return {
        failures: results.flatMap((result) =>
          result.error ? [failureText(result.relativePath, result.error)] : [],
        ),
        skipped: plan.skipped,
      };
    });

  const commitAll = (message: string): Promise<void> =>
    run("commit", async () => {
      const plan = planBulkCommit(status.repositories);
      if (
        plan.targets.length > 0 &&
        !window.confirm(
          `Stage and commit all changes in ${plan.targets.length === 1 ? "1 repository" : `${plan.targets.length} repositories`}?`,
        )
      ) {
        return { failures: [], skipped: [] };
      }
      const failures: string[] = [];
      for (const repository of plan.targets) {
        try {
          await runWorkspaceGitAction(
            status.workspaceRoot,
            repository.repositoryRoot,
            "stage-all",
          );
          await runWorkspaceGitAction(
            status.workspaceRoot,
            repository.repositoryRoot,
            "commit",
            {
              message,
            },
          );
        } catch (error) {
          failures.push(failureText(repository.relativePath, error));
        }
      }
      return { failures, skipped: plan.skipped };
    });

  const busy = controls.busy || running !== null;
  const changed = status.repositories.some(
    (repository) => repository.totalChanges > 0,
  );

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1">
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={busy}
          onClick={() => void pullAll()}
        >
          {running === "pull" ? (
            <LoaderCircle className="animate-spin" />
          ) : (
            <ArrowDownToLine />
          )}
          Pull all
        </Button>
        <Button
          type="button"
          size="xs"
          variant="outline"
          aria-pressed={form === "switch"}
          disabled={busy}
          onClick={() =>
            setForm((current) => (current === "switch" ? null : "switch"))
          }
        >
          <GitBranch />
          Switch all
        </Button>
        <Button
          type="button"
          size="xs"
          variant="outline"
          aria-pressed={form === "commit"}
          disabled={busy || !changed}
          onClick={() =>
            setForm((current) => (current === "commit" ? null : "commit"))
          }
        >
          <GitCommitHorizontal />
          Commit all
        </Button>
      </div>
      {form ? (
        <form
          className="flex items-center gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            const text = value.trim();
            if (!text) return;
            void (form === "switch" ? switchAll(text) : commitAll(text));
          }}
        >
          <Input
            autoFocus
            value={value}
            aria-label={form === "switch" ? "Branch" : "Commit message"}
            placeholder={form === "switch" ? "Branch name" : "Message"}
            onChange={(event) => setValue(event.target.value)}
            className="h-7 flex-1 border-slate-800 bg-slate-950 text-xs"
          />
          <Button type="submit" size="xs" disabled={busy || !value.trim()}>
            {running === form ? (
              <LoaderCircle className="animate-spin" />
            ) : null}
            {form === "switch" ? "Switch" : "Commit"}
          </Button>
        </form>
      ) : null}
      {report ? (
        <pre
          role="status"
          className="whitespace-pre-wrap rounded-md border border-slate-800 bg-slate-950/60 px-2 py-1.5 text-[11px] text-slate-400"
        >
          {report}
        </pre>
      ) : null}
    </div>
  );
};
