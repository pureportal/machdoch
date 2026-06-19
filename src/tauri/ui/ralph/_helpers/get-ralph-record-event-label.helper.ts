import type { RalphRunEvent } from "../../../../core/ralph.js";

export const getRalphRecordEventLabel = (event: RalphRunEvent): string => {
  switch (event.type) {
    case "block-start":
      return `Started ${event.blockId}`;
    case "block-output":
      return `${event.blockId} returned ${event.output}`;
    case "edge-route":
      return `${event.from}.${event.output} routed to ${event.to}`;
    case "retry":
      return `Retry ${event.blockId}: ${event.reason}`;
    case "input-required":
      return `${event.blockId} waiting for input`;
    case "input-submitted":
      return `${event.blockId} input submitted`;
    case "input-cancelled":
      return `${event.blockId} input cancelled`;
    case "crash":
      return `Crash at ${event.blockId}: ${event.reason}`;
    case "end":
      return `${event.status}: ${event.summary}`;
  }
};
