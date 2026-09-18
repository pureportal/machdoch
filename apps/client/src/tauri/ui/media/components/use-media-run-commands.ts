import { useMemo, useRef } from "react";
import { useOptionalRegisterCommands } from "../../commands/command-context";
import { getDefaultCommandShortcut } from "../../commands/command-defaults";
import type { CommandDefinition } from "../../commands/command-types";
import { canCancelMediaRun, isRuntimeRun } from "../media-run-presentation";
import type { MediaRunsViewProps } from "./media-runs-view";

export const useMediaRunCommands = ({
  onCancel,
  onCreate,
  onInspectInFlow,
  onRefresh,
  onRetry,
  onSelect,
  runs,
  selectedRun,
}: Pick<
  MediaRunsViewProps,
  | "onCancel"
  | "onCreate"
  | "onInspectInFlow"
  | "onRefresh"
  | "onRetry"
  | "onSelect"
  | "runs"
  | "selectedRun"
>): void => {
  const runsCommandStateRef = useRef({
    onCancel,
    onCreate,
    onInspectInFlow,
    onRefresh,
    onRetry,
    onSelect,
    runs,
    selectedRun,
  });
  runsCommandStateRef.current = {
    onCancel,
    onCreate,
    onInspectInFlow,
    onRefresh,
    onRetry,
    onSelect,
    runs,
    selectedRun,
  };
  const runCommands = useMemo<readonly CommandDefinition[]>(
    () => [
      {
        id: "media.activity.recipe.new",
        title: "New media recipe",
        group: "Media Activity",
        scope: { kind: "view", ownerId: "media" },
        shortcuts: [
          {
            chord: getDefaultCommandShortcut("media.activity.recipe.new"),
            runtimes: ["tauri"],
            allowIn: [
              "document",
              "text-entry",
              "interactive-control",
              "command-surface",
            ],
          },
        ],
        palette: "visible",
        execute: () => runsCommandStateRef.current.onCreate(),
      },
      {
        id: "media.activity.refresh",
        title: "Refresh media runs",
        group: "Media Activity",
        scope: { kind: "view", ownerId: "media" },
        palette: "visible",
        execute: () => runsCommandStateRef.current.onRefresh(),
      },
      {
        id: "media.activity.run.open",
        title: "Open media run",
        group: "Media Activity",
        scope: { kind: "view", ownerId: "media" },
        palette: "visible",
        availability: () =>
          runsCommandStateRef.current.runs.some(isRuntimeRun)
            ? { state: "enabled" }
            : { state: "disabled", reason: "No runtime runs" },
        children: () => ({
          id: "media-activity-run-open",
          title: "Open media run",
          searchPlaceholder: "Choose run",
          groups: [
            {
              id: "runs",
              items: runsCommandStateRef.current.runs
                .filter(isRuntimeRun)
                .map((run) => ({
                  id: run.id,
                  title: run.flowName,
                  keywords: [run.prompt, run.status, run.modelLabel],
                  current:
                    runsCommandStateRef.current.selectedRun?.id === run.id,
                  execute: () => runsCommandStateRef.current.onSelect(run.id),
                })),
            },
          ],
        }),
      },
      {
        id: "media.activity.run.inspect-flow",
        title: "Inspect selected run in workflow",
        group: "Media Activity",
        scope: { kind: "view", ownerId: "media" },
        palette: "visible",
        availability: () =>
          runsCommandStateRef.current.selectedRun?.planSnapshot
            ? { state: "enabled" }
            : {
                state: "disabled",
                reason: "The selected run has no workflow snapshot",
              },
        execute: () => {
          const run = runsCommandStateRef.current.selectedRun;
          if (run?.planSnapshot)
            runsCommandStateRef.current.onInspectInFlow(run);
        },
      },
      {
        id: "media.activity.run.cancel",
        title: "Cancel selected run",
        group: "Media Activity",
        scope: { kind: "view", ownerId: "media" },
        palette: "visible",
        availability: () => {
          const run = runsCommandStateRef.current.selectedRun;
          return run && canCancelMediaRun(run)
            ? { state: "enabled" }
            : {
                state: "disabled",
                reason: "The selected run cannot be canceled",
              };
        },
        execute: () => {
          const run = runsCommandStateRef.current.selectedRun;
          if (run) runsCommandStateRef.current.onCancel(run.id);
        },
      },
      {
        id: "media.activity.run.retry",
        title: "Retry selected run",
        group: "Media Activity",
        scope: { kind: "view", ownerId: "media" },
        palette: "visible",
        availability: () => {
          const run = runsCommandStateRef.current.selectedRun;
          return run &&
            run.executor === "deterministic-fixture" &&
            ["failed", "canceled"].includes(run.status) &&
            run.humanReviews.length === 0
            ? { state: "enabled" }
            : {
                state: "disabled",
                reason: "The selected run cannot be retried",
              };
        },
        execute: () => {
          const run = runsCommandStateRef.current.selectedRun;
          if (run) runsCommandStateRef.current.onRetry(run.id);
        },
      },
    ],
    [runsCommandStateRef],
  );
  useOptionalRegisterCommands(runCommands);
};
