import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { hostMessageSchema } from "./index.ts";

const fixture = JSON.parse(
  readFileSync(
    new URL("../fixtures/desktop-snapshot.json", import.meta.url),
    "utf8",
  ),
);
const telemetry = {
  capturedAt: 100,
  platform: "linux",
  architecture: "x64",
  cpuCount: 8,
  cpuUsagePercent: 12.5,
  memoryTotalBytes: 1024,
  memoryUsedBytes: 512,
  uptimeSeconds: 100,
};

void test("host telemetry is accepted inside real desktop snapshots", () => {
  const message = structuredClone(fixture);
  message.response.snapshot.telemetry = telemetry;
  assert.equal(hostMessageSchema.safeParse(message).success, true);
  message.response.snapshot.telemetry.cpuUsagePercent = null;
  assert.equal(hostMessageSchema.safeParse(message).success, true);
});

void test("invalid and excessive hardware readings are rejected", () => {
  for (const invalid of [
    { cpuUsagePercent: 101 },
    { cpuUsagePercent: -1 },
    { cpuCount: 0 },
    { memoryUsedBytes: 1025 },
    { memoryTotalBytes: -1 },
    { platform: "x".repeat(65) },
    { architecture: "" },
    { uptimeSeconds: 0.5 },
    { unknown: true },
  ]) {
    const message = structuredClone(fixture);
    message.response.snapshot.telemetry = { ...telemetry, ...invalid };
    assert.equal(
      hostMessageSchema.safeParse(message).success,
      false,
      JSON.stringify(invalid),
    );
  }
});
