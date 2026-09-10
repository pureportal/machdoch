import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { z } from "zod";

import {
  fleetManagedSettingsDeliverySchema,
  hostMessageSchema,
  productCommandSchema,
  serializedGatewayMessageBytes,
} from "./index.ts";

const corpus = z
  .strictObject({
    version: z.literal(1),
    cases: z
      .array(
        z.strictObject({
          id: z.string().min(1),
          target: z.enum(["command", "managed-settings", "snapshot"]),
          accepted: z.boolean(),
          payload: z.json(),
          gatewayBytes: z.number().int().positive().optional(),
        }),
      )
      .min(1),
  })
  .parse(
    JSON.parse(
      readFileSync(
        new URL("../fixtures/protocol-conformance.json", import.meta.url),
        "utf8",
      ),
    ),
  );

assert.equal(
  new Set(corpus.cases.map(({ id }) => id)).size,
  corpus.cases.length,
);

const validators = {
  command: productCommandSchema,
  "managed-settings": fleetManagedSettingsDeliverySchema,
  snapshot: hostMessageSchema,
};

for (const fixture of corpus.cases) {
  void test(`conformance ${fixture.id}`, () => {
    const payload = structuredClone(fixture.payload);
    if (fixture.gatewayBytes !== undefined) {
      assert.equal(fixture.target, "snapshot");
      const logs = (
        payload as {
          response: { snapshot: { sessions: { logs: unknown[] }[] } };
        }
      ).response.snapshot.sessions[0]!.logs;
      assert.equal(logs.length, 0);
      const emptyLog = { createdAt: 0, stream: "stdout", chunk: "" };
      const emptyBytes = serializedGatewayMessageBytes(emptyLog);
      const entryBytes = emptyBytes + 12_000 + 1;
      const remaining =
        fixture.gatewayBytes - serializedGatewayMessageBytes(payload);
      const fullChunks = Math.floor((remaining - emptyBytes) / entryBytes);
      assert.ok(fullChunks >= 0);
      for (let index = 0; index < fullChunks; index++) {
        logs.push({ ...emptyLog, chunk: "x".repeat(12_000) });
      }
      const finalLength = remaining - fullChunks * entryBytes - emptyBytes;
      assert.ok(finalLength >= 0 && finalLength <= 12_000);
      logs.push({ ...emptyLog, chunk: "x".repeat(finalLength) });
      assert.equal(
        serializedGatewayMessageBytes(payload),
        fixture.gatewayBytes,
      );
    }

    const result = validators[fixture.target].safeParse(payload);
    process.stdout.write(
      `CONFORMANCE ${fixture.id} ${result.success ? "accept" : "reject"}\n`,
    );
    assert.equal(result.success, fixture.accepted, result.error?.message);
  });
}
