import { parentPort, workerData } from "node:worker_threads";
import { createModelAdapter } from "@machdoch/model-runtime/connections";
import { validateToolArguments } from "@machdoch/model-runtime/tool-argument-validation";

let streamTimer;
let finalSeen = false;
let finalEvent;
let text = "";
let textBytes = 0;
let heartbeat;
let outputExceeded = false;
function enforceOutputLimit(bytes) {
  if (bytes <= 256 * 1024) return;
  outputExceeded = true;
  throw new Error("Model output exceeded its limit");
}
function flushEvents() {
  clearTimeout(streamTimer);
  streamTimer = undefined;
  if (finalEvent) parentPort.postMessage({ kind: "event", event: finalEvent });
  else if (text)
    parentPort.postMessage({
      kind: "event",
      event: { type: "text-delta", delta: text },
    });
  finalEvent = undefined;
  text = "";
  textBytes = 0;
}
function streamEvent(event) {
  if (event.type === "final-answer") {
    enforceOutputLimit(Buffer.byteLength(event.snapshot.text));
    finalSeen = true;
    finalEvent = event;
    text = "";
    textBytes = 0;
  } else if (event.type === "text-delta" && !finalSeen) {
    textBytes += Buffer.byteLength(event.delta);
    enforceOutputLimit(textBytes);
    text += event.delta;
  } else return;
  streamTimer ??= setTimeout(flushEvents, 50);
}

try {
  parentPort.postMessage({ kind: "ready" });
  heartbeat = setInterval(
    () => parentPort.postMessage({ kind: "heartbeat" }),
    500,
  );
  if (workerData.kind === "validate") {
    const valid = workerData.calls.every((call) => {
      const tool = workerData.tools.find((tool) => tool.name === call.name);
      return (
        !!tool &&
        !call.argumentError &&
        !validateToolArguments(tool.inputSchema, call.arguments)
      );
    });
    parentPort.postMessage({ kind: "result", result: valid });
  } else if (workerData.kind === "model") {
    const adapter = await createModelAdapter(
      workerData.connection,
      workerData.tools,
    );
    const result = await adapter.startTurn({
      ...workerData.request,
      onStreamEvent: streamEvent,
    });
    enforceOutputLimit(Buffer.byteLength(JSON.stringify(result)));
    flushEvents();
    parentPort.postMessage({ kind: "result", result });
  } else throw new Error("Unknown model operation");
} catch (error) {
  const status =
    error &&
    typeof error === "object" &&
    "status" in error &&
    Number.isInteger(error.status)
      ? error.status
      : undefined;
  parentPort.postMessage({
    kind: "error",
    status,
    code: outputExceeded ? "output_limit" : "worker_failed",
  });
} finally {
  clearTimeout(streamTimer);
  clearInterval(heartbeat);
  parentPort.close();
}
