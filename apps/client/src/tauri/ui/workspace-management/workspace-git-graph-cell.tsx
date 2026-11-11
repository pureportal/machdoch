import type { JSX } from "react";
import { cn } from "@machdoch/media-studio/tauri/ui/lib/utils.js";
import type {
  WorkspaceGitGraphLane,
  WorkspaceGitGraphRow,
} from "./workspace-git-graph-layout";
import {
  GRAPH_LANE_COLORS,
  GRAPH_LANE_WIDTH,
  GRAPH_ROW_HEIGHT,
} from "./workspace-git-graph-style";

const laneX = (lane: number): number =>
  GRAPH_LANE_WIDTH / 2 + lane * GRAPH_LANE_WIDTH;

const connector = (
  fromLane: number,
  fromY: number,
  toLane: number,
  toY: number,
): string => {
  const fromX = laneX(fromLane);
  const toX = laneX(toLane);
  if (fromX === toX) return `M ${fromX} ${fromY} L ${toX} ${toY}`;
  const middle = (fromY + toY) / 2;
  return `M ${fromX} ${fromY} C ${fromX} ${middle}, ${toX} ${middle}, ${toX} ${toY}`;
};

const strokeOf = (lane: WorkspaceGitGraphLane | null | undefined): string =>
  GRAPH_LANE_COLORS[lane?.color ?? 0]!.stroke;

const graphColumnWidth = (lanes: number): number =>
  Math.max(1, lanes) * GRAPH_LANE_WIDTH;

export const WorkspaceGitGraphCell = ({
  row,
  lanes,
  head,
  forkPoint,
}: {
  row: WorkspaceGitGraphRow;
  lanes: number;
  head: boolean;
  forkPoint: boolean;
}): JSX.Element => {
  const middle = GRAPH_ROW_HEIGHT / 2;
  const nodeX = laneX(row.lane);
  const color = GRAPH_LANE_COLORS[row.color]!;
  const merge = row.commit.parents.length > 1;
  return (
    <svg
      aria-hidden="true"
      width={graphColumnWidth(lanes)}
      height={GRAPH_ROW_HEIGHT}
      className="shrink-0 overflow-visible"
    >
      <g fill="none" strokeWidth={1.75} strokeLinecap="round">
        {row.top.map((lane, index) =>
          lane && lane.hash !== row.commit.hash ? (
            <path
              key={`pass:${index}`}
              d={connector(index, 0, index, GRAPH_ROW_HEIGHT)}
              className={strokeOf(lane)}
            />
          ) : null,
        )}
        {row.incoming.map((index) => (
          <path
            key={`in:${index}`}
            d={connector(index, 0, row.lane, middle)}
            className={strokeOf(row.top[index])}
          />
        ))}
        {row.outgoing.map((index) => (
          <path
            key={`out:${index}`}
            d={connector(row.lane, middle, index, GRAPH_ROW_HEIGHT)}
            className={strokeOf(row.bottom[index])}
          />
        ))}
      </g>
      {forkPoint ? (
        <circle
          cx={nodeX}
          cy={middle}
          r={7}
          className="fill-none stroke-amber-300"
          strokeWidth={1.5}
          strokeDasharray="2 2"
        />
      ) : null}
      {head ? (
        <circle
          cx={nodeX}
          cy={middle}
          r={5.5}
          className={cn("fill-(--app-surface)", color.stroke)}
          strokeWidth={2}
        />
      ) : null}
      <circle
        cx={nodeX}
        cy={middle}
        r={head ? 2.5 : merge ? 3.5 : 3.75}
        className={
          merge && !head ? cn("fill-(--app-surface)", color.stroke) : color.fill
        }
        strokeWidth={merge && !head ? 1.75 : 0}
      />
    </svg>
  );
};

export const WorkspaceGitGraphContinuation = ({
  row,
  lanes,
}: {
  row: WorkspaceGitGraphRow;
  lanes: number;
}): JSX.Element => (
  <span
    aria-hidden="true"
    className="relative shrink-0 self-stretch"
    style={{ width: graphColumnWidth(lanes) }}
  >
    {row.bottom.map((lane, index) =>
      lane ? (
        <span
          key={index}
          className={cn(
            "absolute inset-y-0 w-[1.75px] -translate-x-1/2",
            GRAPH_LANE_COLORS[lane.color]!.line,
          )}
          style={{ left: laneX(index) }}
        />
      ) : null,
    )}
  </span>
);
