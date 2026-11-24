import type { RalphOverviewSelection } from "./ralph-overview-model";

const OPEN_RUN_EVENT = "machdoch:open-ralph-run";

let pendingSelection: RalphOverviewSelection | null = null;

export const openRalphRun = (selection: RalphOverviewSelection): void => {
  pendingSelection = selection;
  window.dispatchEvent(new Event(OPEN_RUN_EVENT));
};

export const takeRalphRunRequest = (): RalphOverviewSelection | null => {
  const selection = pendingSelection;
  pendingSelection = null;
  return selection;
};

export const onRalphRunRequest = (listener: () => void): (() => void) => {
  window.addEventListener(OPEN_RUN_EVENT, listener);
  return () => window.removeEventListener(OPEN_RUN_EVENT, listener);
};
