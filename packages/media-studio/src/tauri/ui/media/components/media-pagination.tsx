import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
} from "lucide-react";
import type { JSX } from "react";
import { Button } from "../../components/ui/button";
import { cn } from "../../lib/utils";

interface MediaPaginationProps {
  page: number;
  pageCount: number;
  firstItemNumber: number;
  lastItemNumber: number;
  totalItems: number;
  itemLabel: string;
  onPageChange: (page: number) => void;
  className?: string;
}

export const MediaPagination = ({
  page,
  pageCount,
  firstItemNumber,
  lastItemNumber,
  totalItems,
  itemLabel,
  onPageChange,
  className,
}: MediaPaginationProps): JSX.Element | null => {
  if (pageCount < 2 || page < 1) {
    return null;
  }

  return (
    <nav
      aria-label={`${itemLabel} pages`}
      className={cn(
        "flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-800/80 bg-slate-950/35 px-2.5 py-2",
        className,
      )}
    >
      <span className="text-[10px] tabular-nums text-slate-500">
        Showing {firstItemNumber}–{lastItemNumber} of {totalItems} {itemLabel}
      </span>
      <div className="flex items-center gap-1">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          disabled={page === 1}
          aria-label={`First ${itemLabel} page`}
          onClick={() => onPageChange(1)}
          className="h-7 w-7 text-slate-400 hover:bg-slate-800 hover:text-slate-100"
        >
          <ChevronsLeft className="h-3.5 w-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          disabled={page === 1}
          aria-label={`Previous ${itemLabel} page`}
          onClick={() => onPageChange(page - 1)}
          className="h-7 w-7 text-slate-400 hover:bg-slate-800 hover:text-slate-100"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </Button>
        <label className="flex items-center gap-1.5 text-[10px] text-slate-500">
          <span>Page</span>
          <select
            aria-label={`Current ${itemLabel} page`}
            value={page}
            onChange={(event) =>
              onPageChange(Number.parseInt(event.currentTarget.value, 10))
            }
            className="h-7 rounded-md border border-slate-700 bg-slate-900 px-2 text-[10px] tabular-nums text-slate-200 outline-none focus:border-sky-400/50 focus:ring-2 focus:ring-sky-400/15"
          >
            {Array.from({ length: pageCount }, (_, index) => index + 1).map(
              (pageNumber) => (
                <option key={pageNumber} value={pageNumber}>
                  {pageNumber}
                </option>
              ),
            )}
          </select>
          <span>of {pageCount}</span>
        </label>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          disabled={page === pageCount}
          aria-label={`Next ${itemLabel} page`}
          onClick={() => onPageChange(page + 1)}
          className="h-7 w-7 text-slate-400 hover:bg-slate-800 hover:text-slate-100"
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          disabled={page === pageCount}
          aria-label={`Last ${itemLabel} page`}
          onClick={() => onPageChange(pageCount)}
          className="h-7 w-7 text-slate-400 hover:bg-slate-800 hover:text-slate-100"
        >
          <ChevronsRight className="h-3.5 w-3.5" />
        </Button>
      </div>
    </nav>
  );
};
