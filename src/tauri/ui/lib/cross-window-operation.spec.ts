import { describe, expect, it } from "vitest";
import {
  beginCrossWindowOperation,
  completeCrossWindowOperation,
  releaseCrossWindowOperation,
} from "./cross-window-operation";

describe("cross-window operation leases", () => {
  it("allows only one owner and allows a released operation to retry", async () => {
    const operationId = "test:release-and-retry";
    const firstLease = await beginCrossWindowOperation(operationId);

    expect(firstLease).not.toBeNull();
    if (!firstLease) {
      throw new Error("Expected the first operation lease to be acquired.");
    }

    await expect(beginCrossWindowOperation(operationId)).resolves.toBeNull();
    await expect(releaseCrossWindowOperation(firstLease)).resolves.toBe(true);
    await expect(beginCrossWindowOperation(operationId)).resolves.not.toBeNull();
  });

  it("does not reacquire a completed operation", async () => {
    const operationId = "test:complete-once";
    const lease = await beginCrossWindowOperation(operationId);

    expect(lease).not.toBeNull();
    if (!lease) {
      throw new Error("Expected the operation lease to be acquired.");
    }

    await expect(completeCrossWindowOperation(lease)).resolves.toBe(true);
    await expect(beginCrossWindowOperation(operationId)).resolves.toBeNull();
  });
});
