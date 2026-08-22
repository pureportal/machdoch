import { describe, expect, it } from "vitest";
import {
  getRalphContinuationWorkspaceWriterLeaseRequirement,
  getRalphKnownFlowWorkspaceWriterLeaseRequirement,
  getRalphWorkspaceWriterBlockingRun,
  getRalphWorkspaceWriterBlockingRunForRequirement,
} from "./ralph-workspace-writer-conflict.helper";

describe("RALPH workspace writer conflicts", () => {
  const activeRuns = [
    { id: "reader", requiresWorkspaceWriterLease: false },
    { id: "owner", requiresWorkspaceWriterLease: true },
  ];

  it("returns the active owner before launching another autonomous flow", () => {
    expect(
      getRalphWorkspaceWriterBlockingRun(
        { settings: { autonomy: true } },
        false,
        activeRuns,
      ),
    ).toBe(activeRuns[1]);
    expect(
      getRalphWorkspaceWriterBlockingRun(
        { settings: { autonomy: {} } },
        false,
        activeRuns,
      ),
    ).toBe(activeRuns[1]);
  });

  it("does not block non-autonomous flows or the selected active flow", () => {
    expect(
      getRalphWorkspaceWriterBlockingRun(
        { settings: { autonomy: false } },
        false,
        activeRuns,
      ),
    ).toBeNull();
    expect(
      getRalphWorkspaceWriterBlockingRun(
        { settings: { autonomy: { enabled: false } } },
        false,
        activeRuns,
      ),
    ).toBeNull();
    expect(
      getRalphWorkspaceWriterBlockingRun(
        { settings: { autonomy: true } },
        true,
        activeRuns,
      ),
    ).toBeNull();
  });

  it("allows an autonomous flow when the workspace has no active run", () => {
    expect(
      getRalphWorkspaceWriterBlockingRun(
        { settings: { autonomy: true } },
        false,
        [],
      ),
    ).toBeNull();
  });

  it("allows an autonomous flow alongside known non-writer runs", () => {
    expect(
      getRalphWorkspaceWriterBlockingRun(
        { settings: { autonomy: true } },
        false,
        [{ id: "reader", requiresWorkspaceWriterLease: false }],
      ),
    ).toBeNull();
  });

  it("conservatively treats restored runs with unknown lease metadata as writers", () => {
    const restoredRun = { id: "restored" };

    expect(
      getRalphWorkspaceWriterBlockingRun(
        { settings: { autonomy: true } },
        false,
        [restoredRun],
      ),
    ).toBe(restoredRun);
  });

  it("derives restored task metadata only from the matching loaded flow", () => {
    expect(
      getRalphKnownFlowWorkspaceWriterLeaseRequirement("reader-flow", {
        id: "reader-flow",
        settings: { autonomy: false },
      }),
    ).toBe(false);
    expect(
      getRalphKnownFlowWorkspaceWriterLeaseRequirement("writer-flow", {
        id: "writer-flow",
        settings: { autonomy: true },
      }),
    ).toBe(true);
    expect(
      getRalphKnownFlowWorkspaceWriterLeaseRequirement("other-flow", {
        id: "reader-flow",
        settings: { autonomy: false },
      }),
    ).toBeUndefined();
  });

  it("keeps incomplete continuation metadata conservative without losing known flow settings", () => {
    expect(
      getRalphContinuationWorkspaceWriterLeaseRequirement(
        { flow: "writer-flow" },
        { id: "writer-flow", settings: { autonomy: true } },
      ),
    ).toBe(true);
    expect(
      getRalphContinuationWorkspaceWriterLeaseRequirement(
        { flow: "reader-flow" },
        { id: "reader-flow", settings: { autonomy: false } },
      ),
    ).toBe(false);
    expect(
      getRalphContinuationWorkspaceWriterLeaseRequirement(
        { flow: "restored-flow" },
        null,
      ),
    ).toBeUndefined();
    expect(
      getRalphContinuationWorkspaceWriterLeaseRequirement(
        { flow: "writer-flow", autonomy: { enabled: true } },
        { id: "writer-flow", settings: { autonomy: false } },
      ),
    ).toBe(true);
  });

  it("blocks writer continuations while allowing known readers", () => {
    expect(
      getRalphWorkspaceWriterBlockingRunForRequirement(true, false, activeRuns),
    ).toBe(activeRuns[1]);
    expect(
      getRalphWorkspaceWriterBlockingRunForRequirement(
        undefined,
        false,
        activeRuns,
      ),
    ).toBe(activeRuns[1]);
    expect(
      getRalphWorkspaceWriterBlockingRunForRequirement(
        false,
        false,
        activeRuns,
      ),
    ).toBeNull();
  });
});
