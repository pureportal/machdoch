import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createFleetSessionId } from "./session-routing.ts";

test("session identities are stable, bounded, and safe for arbitrary command text", async () => {
  for (const commandId of ["request-1", "../request/日本語", "x".repeat(128)]) {
    const identifier = await createFleetSessionId(commandId);
    assert.equal(await createFleetSessionId(commandId), identifier);
    const digest = createHash("sha256").update(commandId).digest("hex");
    assert.equal(identifier.slice(0, 8), digest.slice(0, 8));
    assert.equal(identifier.slice(-12), digest.slice(20, 32));
    assert.match(
      identifier,
      /^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u,
    );
  }
  assert.notEqual(
    await createFleetSessionId("request-1"),
    await createFleetSessionId("request-2"),
  );
});
