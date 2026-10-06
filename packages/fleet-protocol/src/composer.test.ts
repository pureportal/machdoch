import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { maximumComposerTextCharacters } from "./composer-contract.ts";
import {
  hostRequestSchema,
  hostResponseSchema,
  productCommandSchema,
  productSnapshotSchema,
} from "./index.ts";

type ComposerFixtures = {
  baseSnapshot: unknown;
  commands: {
    name: string;
    command: Record<string, unknown>;
    accepted: boolean;
    expected?: Record<string, unknown>;
  }[];
  snapshots: {
    name: string;
    composer: Record<string, unknown>;
    accepted: boolean;
  }[];
};

const fixtures: ComposerFixtures = JSON.parse(
  await readFile(
    new URL("../fixtures/composer-conformance.json", import.meta.url),
    "utf8",
  ),
);
const baseSnapshot = productSnapshotSchema.parse(fixtures.baseSnapshot);
const queuedMessage = {
  id: "message-1",
  content: "",
  attachments: [],
  status: "queued",
  createdAt: 0,
};
const snapshotWithComposer = (composer: Record<string, unknown>) => ({
  ...baseSnapshot,
  shell: {
    ...baseSnapshot.shell,
    composer: { ...baseSnapshot.shell?.composer, ...composer },
  },
});

await test("composer commands conform at the product and host request boundaries", () => {
  for (const entry of fixtures.commands) {
    const result = productCommandSchema.safeParse(entry.command);
    assert.equal(result.success, entry.accepted, entry.name);
    assert.equal(
      hostRequestSchema.safeParse({
        type: "executeProductCommand",
        command: entry.command,
      }).success,
      entry.accepted,
      entry.name,
    );
    if (result.success) {
      assert.deepEqual(
        result.data,
        entry.expected ?? entry.command,
        entry.name,
      );
      assert.deepEqual(
        productCommandSchema.parse(JSON.parse(JSON.stringify(result.data))),
        result.data,
        entry.name,
      );
    }
  }
});

await test("composer snapshots conform at the product and host response boundaries", () => {
  for (const entry of fixtures.snapshots) {
    const snapshot = snapshotWithComposer(entry.composer);
    const result = productSnapshotSchema.safeParse(snapshot);
    assert.equal(result.success, entry.accepted, entry.name);
    assert.equal(
      hostResponseSchema.safeParse({ type: "productSnapshot", snapshot })
        .success,
      entry.accepted,
      entry.name,
    );
    if (result.success) {
      assert.deepEqual(result.data, snapshot, entry.name);
      assert.deepEqual(
        productSnapshotSchema.parse(JSON.parse(JSON.stringify(result.data))),
        result.data,
        entry.name,
      );
    }
  }
});

await test("composer text limits count UTF-16 units and preserve blank queue edits", () => {
  const command = {
    kind: "update-queued-message",
    sessionId: "session-1",
    messageId: "message-1",
    prompt: "",
  };
  for (const prompt of [
    "",
    " \n ",
    "x".repeat(8_001),
    "😀".repeat(maximumComposerTextCharacters / 2),
  ]) {
    assert.deepEqual(productCommandSchema.parse({ ...command, prompt }), {
      ...command,
      prompt,
    });
  }
  assert.equal(
    productCommandSchema.safeParse({
      ...command,
      prompt: "😀".repeat(maximumComposerTextCharacters / 2) + "x",
    }).success,
    false,
  );
  for (const [field, maximum] of [
    ["id", 8_000],
    ["content", 8_000],
    ["failureMessage", 12_000],
  ] as const) {
    for (const value of ["x".repeat(maximum), "😀".repeat(maximum / 2)]) {
      assert.equal(
        productSnapshotSchema.safeParse(
          snapshotWithComposer({
            queuedMessages: [{ ...queuedMessage, [field]: value }],
          }),
        ).success,
        true,
        field,
      );
      assert.equal(
        productSnapshotSchema.safeParse(
          snapshotWithComposer({
            queuedMessages: [{ ...queuedMessage, [field]: value + "x" }],
          }),
        ).success,
        false,
        field,
      );
    }
  }
  const reason = "😀".repeat(6_000);
  assert.equal(
    productSnapshotSchema.safeParse(
      snapshotWithComposer({ imageInputDisabledReason: reason }),
    ).success,
    true,
  );
  assert.equal(
    productSnapshotSchema.safeParse(
      snapshotWithComposer({ imageInputDisabledReason: reason + "x" }),
    ).success,
    false,
  );
});

await test("composer collection limits accept their final slot and reject overflow", () => {
  for (const count of [512, 513]) {
    const queuedMessages = Array.from({ length: count }, (_, index) => ({
      ...queuedMessage,
      id: `message-${index}`,
    }));
    assert.equal(
      productSnapshotSchema.safeParse(snapshotWithComposer({ queuedMessages }))
        .success,
      count === 512,
    );
  }
  for (const count of [64, 65]) {
    const attachments = Array.from({ length: count }, (_, index) => ({
      id: `attachment-${index}`,
      source: "path",
      kind: "file",
      name: "",
      path: "",
    }));
    assert.equal(
      productSnapshotSchema.safeParse(
        snapshotWithComposer({
          queuedMessages: [{ ...queuedMessage, attachments }],
        }),
      ).success,
      count === 64,
    );
    assert.equal(
      productCommandSchema.safeParse({
        kind: "apply-context-pack",
        sessionId: "session-1",
        contextPackId: "pack-1",
        variableValues: Object.fromEntries(
          Array.from({ length: count }, (_, index) => [`key-${index}`, ""]),
        ),
      }).success,
      count === 64,
    );
  }
});

await test("context variable bounds preserve keys and count UTF-16 units", () => {
  const command = {
    kind: "apply-context-pack",
    sessionId: "session-1",
    contextPackId: "pack-1",
  };
  const key = "😀".repeat(120);
  const value = "😀".repeat(6_000);
  const variableValues = { [key]: value };
  assert.deepEqual(productCommandSchema.parse({ ...command, variableValues }), {
    ...command,
    variableValues,
  });
  for (const variables of [{ [key + "x"]: value }, { [key]: value + "x" }]) {
    assert.equal(
      productCommandSchema.safeParse({ ...command, variableValues: variables })
        .success,
      false,
    );
  }
});
