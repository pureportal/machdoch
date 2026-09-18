import { Clock3, LoaderCircle, Plus, RotateCw, Search } from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from "react";
import type {
  MediaAssetRecord,
  MediaHumanReviewDecisionRequest,
  MediaRunDetail,
  MediaRunRecord,
  MediaProviderReviewAction,
} from "../../../../core/media/contracts.js";
import { paginateMediaItems } from "../../../../core/media/gallery.js";
import { matchesMediaRunQuery } from "../../../../core/media/run-library.js";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { EmptyState } from "../../components/ui/empty-state";
import { SearchField } from "../../components/ui/search-field";
import type { MediaGenerationRecipeSnapshot } from "../media-generation-queue";
import { groupRunsByDate } from "../media-run-presentation";
import { MediaPagination } from "./media-pagination";
import { MediaRunRow } from "./media-run-row";
import { MEDIA_RUN_STATES } from "./media-run-state";
import { MediaRunInspector } from "./media-run-inspector";
import { useMediaRunCommands } from "./use-media-run-commands";

const RUN_HISTORY_PAGE_SIZE = 30;

export interface MediaRunsViewProps {
  errorNotice?: ReactNode;
  runs: readonly MediaRunRecord[];
  assets: readonly MediaAssetRecord[];
  selectedRun: MediaRunDetail | null;
  selectedRunId: string | null;
  selectedRunLoading: boolean;
  onOpenAsset: (asset: MediaAssetRecord) => void;
  selectedRecipe: MediaGenerationRecipeSnapshot | null;
  onCreate: () => void;
  onClose: () => void;
  onSelect: (runId: string) => void;
  onCancel: (runId: string) => void;
  onRetry: (runId: string) => void;
  onResolveProviderReview: (
    providerJobId: string,
    action: MediaProviderReviewAction,
  ) => void;
  providerReviewPending: boolean;
  onResolveHumanReview: (request: MediaHumanReviewDecisionRequest) => void;
  humanReviewPending: boolean;
  onInspectInFlow: (run: MediaRunDetail) => void;
  onReuseSettings: (runId: string) => void;
  onRefresh: () => void;
}

export const MediaRunsView = (props: MediaRunsViewProps): JSX.Element => {
  const {
    runs,
    assets,
    selectedRun,
    selectedRunId,
    selectedRunLoading,
    onCreate,
    onSelect,
    onClose,
    onRefresh,
  } = props;
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [runPage, setRunPage] = useState(1);
  const runListRef = useRef<HTMLDivElement | null>(null);
  const selectedRowRef = useRef<HTMLElement | null>(null);
  const filteredRuns = useMemo(
    () =>
      runs
        .filter(
          (run) =>
            (status === "all" || run.status === status) &&
            matchesMediaRunQuery(run, query),
        )
        .sort(
          (left, right) =>
            right.createdAt.localeCompare(left.createdAt) ||
            right.id.localeCompare(left.id),
        ),
    [runs, query, status],
  );
  const pagination = useMemo(
    () => paginateMediaItems(filteredRuns, runPage, RUN_HISTORY_PAGE_SIZE),
    [filteredRuns, runPage],
  );
  const groups = groupRunsByDate(pagination.items);
  const assetsByRun = useMemo(() => {
    const grouped = new Map<string, MediaAssetRecord[]>();
    for (const asset of assets) {
      const group = grouped.get(asset.runId);
      if (group) group.push(asset);
      else grouped.set(asset.runId, [asset]);
    }
    return grouped;
  }, [assets]);

  useEffect(() => {
    setRunPage(pagination.page || 1);
  }, [pagination.page]);
  useEffect(() => {
    runListRef.current?.scrollTo({ top: 0 });
  }, [query, status, pagination.page]);
  useMediaRunCommands(props);

  return (
    <div className="@container flex h-full min-h-0 min-w-0 flex-col bg-slate-950 px-4 py-5 sm:px-7 sm:py-7">
      <div className="mx-auto flex min-h-0 w-full max-w-6xl flex-1 flex-col">
        <header className="flex shrink-0 flex-wrap items-center justify-between gap-3">
          <h1 className="text-lg font-semibold tracking-tight text-slate-100">
            Run history
          </h1>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Refresh runs"
              onClick={onRefresh}
            >
              <RotateCw className="size-4" />
            </Button>
            <Button
              onClick={onCreate}
              className="bg-sky-400 text-slate-950 hover:bg-sky-300"
            >
              <Plus className="size-4" />
              New recipe
            </Button>
          </div>
        </header>
        {runs.length > 0 ? (
          <div className="mt-5 flex shrink-0 flex-wrap items-center gap-3">
            <SearchField
              aria-label="Search run history"
              placeholder="Search runs"
              value={query}
              onChange={(event) => {
                setQuery(event.currentTarget.value);
                setRunPage(1);
              }}
              containerClassName="min-w-0 basis-full @min-[480px]:basis-64 @min-[480px]:max-w-sm @min-[480px]:flex-1"
              className="border-slate-800 bg-slate-900/50 text-slate-200 placeholder:text-slate-400"
            />
            <select
              aria-label="Filter runs by status"
              value={status}
              onChange={(event) => {
                setStatus(event.currentTarget.value);
                setRunPage(1);
              }}
              className="h-9 min-w-0 rounded-md border border-slate-800 bg-slate-900/50 px-3 text-xs text-slate-300 outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
            >
              <option value="all">All statuses</option>
              {Object.entries(MEDIA_RUN_STATES).map(([value, state]) => (
                <option key={value} value={value}>
                  {state.label}
                </option>
              ))}
            </select>
            <span
              role="status"
              className="ml-auto text-xs tabular-nums text-slate-400"
            >
              {query.trim() || status !== "all"
                ? `${filteredRuns.length} of ${runs.length}`
                : runs.length}{" "}
              {runs.length === 1 ? "run" : "runs"}
            </span>
          </div>
        ) : null}
        {runs.length === 0 ? (
          <EmptyState
            icon={Clock3}
            title="No runs yet"
            titleAs="h2"
            size="large"
            className="mt-6 min-h-0 flex-1 border-0 bg-transparent"
          />
        ) : (
          <>
            <div
              ref={runListRef}
              tabIndex={-1}
              aria-label="Run history list"
              className="mt-5 min-h-0 flex-1 overflow-y-auto overscroll-contain outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
            >
              {groups.map((group) => (
                <section
                  key={group.date}
                  aria-label={group.label}
                  className="mb-5 last:mb-0"
                >
                  <h2 className="sticky top-0 z-10 border-b border-slate-800 bg-slate-950 px-2 py-2.5 text-xs font-medium text-slate-400 @min-[680px]:px-3">
                    {group.label}
                  </h2>
                  <div>
                    {group.runs.map((run) => (
                      <MediaRunRow
                        key={run.id}
                        run={run}
                        assets={assetsByRun.get(run.id) ?? []}
                        selected={selectedRunId === run.id}
                        onSelect={(runId) => {
                          selectedRowRef.current =
                            document.activeElement instanceof HTMLElement
                              ? document.activeElement
                              : null;
                          onSelect(runId);
                        }}
                      />
                    ))}
                  </div>
                </section>
              ))}
              {filteredRuns.length === 0 ? (
                <EmptyState
                  icon={Search}
                  title="No matching runs"
                  role="status"
                  className="min-h-52 border-0 bg-transparent"
                  action={
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setQuery("");
                        setStatus("all");
                        setRunPage(1);
                      }}
                    >
                      Clear filters
                    </Button>
                  }
                />
              ) : null}
            </div>
            <MediaPagination
              page={pagination.page}
              pageCount={pagination.pageCount}
              firstItemNumber={pagination.firstItemNumber}
              lastItemNumber={pagination.lastItemNumber}
              totalItems={pagination.totalItems}
              itemLabel="runs"
              onPageChange={(page) => {
                setRunPage(page);
                runListRef.current?.focus({ preventScroll: true });
              }}
              className="mt-3 shrink-0"
            />
          </>
        )}
        <Dialog
          open={selectedRunLoading || selectedRun !== null}
          onOpenChange={(open) => {
            if (!open) onClose();
          }}
        >
          <DialogContent
            aria-describedby={undefined}
            className="flex max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden border-slate-800 bg-slate-950 p-0 text-slate-100 sm:max-w-3xl"
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              const target = selectedRowRef.current;
              if (target?.isConnected) target.focus({ preventScroll: true });
              else runListRef.current?.focus({ preventScroll: true });
            }}
          >
            <DialogHeader className="shrink-0 border-b border-slate-800 px-5 py-4 pr-12 text-left sm:px-6 sm:pr-12">
              <DialogTitle className="text-base leading-6">
                {selectedRunLoading ? "Run details" : selectedRun?.flowName}
              </DialogTitle>
            </DialogHeader>
            <div className="min-h-0 overflow-y-auto overscroll-contain">
              {props.errorNotice}
              {selectedRunLoading ? (
                <div
                  role="status"
                  className="flex items-center gap-2 p-6 text-sm text-slate-400"
                >
                  <LoaderCircle className="size-4 motion-safe:animate-spin" />
                  Loading run…
                </div>
              ) : selectedRun ? (
                <MediaRunInspector
                  {...props}
                  key={selectedRun.id}
                  run={selectedRun}
                  onOpenAsset={(asset) => {
                    onClose();
                    props.onOpenAsset(asset);
                  }}
                  onInspectInFlow={(run) => {
                    onClose();
                    props.onInspectInFlow(run);
                  }}
                  onReuseSettings={(runId) => {
                    onClose();
                    props.onReuseSettings(runId);
                  }}
                />
              ) : null}
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
};
