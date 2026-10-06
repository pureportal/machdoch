import { createHash } from "node:crypto";
import type { OperationResponse } from "@machdoch/fleet-protocol";

interface Operation {
  digest: string;
  touched: number;
  result?: { content: string } | { error: string };
}

export class FleetOperationStore {
  private readonly operations = new Map<string, Operation>();
  private readonly events: Array<{
    cursor: number;
    name: "desktop-task-progress";
    payload: Extract<
      OperationResponse,
      { state: "events" }
    >["events"][number]["payload"];
  }> = [];
  private cursor = 0;

  async handle<
    Request extends {
      kind: string;
      id?: string;
      command?: string;
      offset?: number;
      after?: number;
    },
  >(
    request: Request,
    invoke: () => Promise<unknown>,
    control = false,
  ): Promise<OperationResponse> {
    for (const [id, operation] of this.operations)
      if (operation.result && Date.now() - operation.touched > 600_000)
        this.operations.delete(id);
    if (request.kind === "events")
      return {
        state: "events",
        cursor: this.cursor,
        events: this.events
          .filter((event) => event.cursor > (request.after ?? 0))
          .map(({ name, payload }) => ({ name, payload })),
      };
    const id = request.id!;
    const operation = this.operations.get(id);
    if (request.kind === "release") {
      if (operation && !operation.result)
        return { state: "failed", error: "Operation is still running." };
      this.operations.delete(id);
      return { state: "complete", chunk: "", offset: 0, total: 0 };
    }
    if (request.kind === "read") {
      if (!operation)
        return {
          state: "failed",
          error: "Operation expired. Refresh and check Runs before retrying.",
        };
      operation.touched = Date.now();
      if (!operation.result) return { state: "pending" };
      if ("error" in operation.result)
        return { state: "failed", error: operation.result.error };
      const offset = request.offset!;
      const content = operation.result.content;
      if (offset > content.length)
        return { state: "failed", error: "Invalid response offset." };
      return {
        state: "complete",
        chunk: content.slice(offset, offset + 262_144),
        offset,
        total: content.length,
      };
    }
    const digest = createHash("sha256")
      .update(JSON.stringify(request))
      .digest("hex");
    if (operation) {
      if (operation.digest !== digest)
        return {
          state: "failed",
          error: "Operation ID was reused with different arguments.",
        };
      operation.touched = Date.now();
      return { state: "pending" };
    }
    if (
      this.operations.size >= 128 ||
      [...this.operations.values()].filter((value) => !value.result).length >=
        (control ? 24 : 16)
    )
      return {
        state: "failed",
        error: "Operation queue is full. Wait for an operation to finish.",
      };
    const current: Operation = { digest, touched: Date.now() };
    this.operations.set(id, current);
    void Promise.resolve()
      .then(invoke)
      .then((value) => {
        const bytes = Buffer.from(JSON.stringify(value));
        const content = bytes.toString("base64");
        const retained = [...this.operations.values()].reduce(
          (total, entry) =>
            total +
            (entry.result && "content" in entry.result
              ? entry.result.content.length
              : 0),
          0,
        );
        current.result =
          content.length > 64 * 1024 * 1024 ||
          retained + content.length > 128 * 1024 * 1024
            ? {
                error:
                  "Response storage is full. Inspect the saved run on the device.",
              }
            : { content };
        current.touched = Date.now();
      })
      .catch((error: unknown) => {
        current.result = {
          error: (error instanceof Error ? error.message : String(error)).slice(
            0,
            12_000,
          ),
        };
        current.touched = Date.now();
      });
    return { state: "pending" };
  }

  recordProgress(
    payload: Extract<
      OperationResponse,
      { state: "events" }
    >["events"][number]["payload"],
  ): void {
    if (Buffer.byteLength(JSON.stringify(payload)) > 16_384) return;
    this.events.push({
      cursor: ++this.cursor,
      name: "desktop-task-progress",
      payload,
    });
    if (this.events.length > 64) this.events.shift();
  }
}
