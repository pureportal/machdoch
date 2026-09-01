import assert from "node:assert/strict";
import test from "node:test";

import {
  fleetManagedSettingsDeliverySchema,
  hostMessageSchema,
  maximumGatewayMessageBytes,
  maximumManagedSettingsCollectionEntries,
  productCommandSchema,
  serializedGatewayMessageBytes,
} from "./index.ts";

const managedSettingsDelivery = () => ({
  schemaVersion: 2,
  managerId: "manager_MDEyMzQ1Njc4OTAxMjM0NTY3",
  profile: {
    profileId: "profile_MDEyMzQ1Njc4OTAxMjM0NTY3",
    name: "Engineering",
    revision: 1,
    document: {
      defaults: {
        provider: "openai",
        model: "gpt-5.6",
        mode: "machdoch",
        reasoning: "high",
        webSearchProvider: "tavily",
        theme: "dark",
        density: "compact",
        accent: "sky",
      },
      agentLimits: {
        infinite: false,
        executorTurns: 20,
        autopilotExecutorIterations: 10,
      },
      instructions: [
        {
          id: "123e4567-e89b-42d3-a456-426614174000",
          name: "Review",
          body: "Review carefully.",
          enabled: true,
          global: true,
          tags: ["review"],
        },
      ],
      contextPacks: [
        {
          id: "123e4567-e89b-42d3-a456-426614174001",
          name: "Change review",
          instructions: "Review carefully.",
          prompt: "Review this change.",
          provider: "openai",
          model: "gpt-5.6",
          mode: "ask",
          reasoning: "medium",
          variables: [{ name: "target", defaultValue: "src" }],
          triggerPhrases: ["review"],
          pathPatterns: ["src/**"],
          promptEnhancementMode: "web-search",
          interviewEnabled: true,
          sessionMemoryEnabled: false,
          useGlobalMemory: true,
          uiControlEnabled: false,
        },
      ],
      prompts: [
        {
          id: "123e4567-e89b-42d3-a456-426614174002",
          relativePath: "review.prompt.md",
          content: "Review this change.",
        },
      ],
    },
    secrets: { openai: "secret" },
  },
});

const snapshotMessage = (chunks: string[]) => ({
  type: "response" as const,
  requestId: "request-1",
  response: {
    type: "productSnapshot" as const,
    snapshot: {
      enabled: true,
      serverTime: 0,
      eventId: 0,
      sessions: [
        {
          taskId: "task-1",
          task: "task",
          mode: "mode",
          state: "state",
          message: "message",
          cancellable: true,
          startedAt: 0,
          updatedAt: 0,
          progressCount: 0,
          logs: chunks.map((chunk) => ({
            createdAt: 0,
            stream: "stdout",
            chunk,
          })),
          timeline: [],
        },
      ],
      commands: [],
    },
  },
});

const snapshotMessageAtPayloadSize = (size: number) => {
  const chunks: string[] = [];
  let message = snapshotMessage(chunks);

  while (
    serializedGatewayMessageBytes(
      snapshotMessage([...chunks, "x".repeat(12_000)]),
    ) <= size
  ) {
    chunks.push("x".repeat(12_000));
    message = snapshotMessage(chunks);
  }

  const finalChunkOverhead =
    serializedGatewayMessageBytes(snapshotMessage([...chunks, ""])) -
    serializedGatewayMessageBytes(message);
  chunks.push(
    "x".repeat(
      size - serializedGatewayMessageBytes(message) - finalChunkOverhead,
    ),
  );
  return snapshotMessage(chunks);
};

void test("accepts a gateway snapshot at the payload budget", () => {
  const message = snapshotMessageAtPayloadSize(maximumGatewayMessageBytes);

  assert.equal(
    serializedGatewayMessageBytes(message),
    maximumGatewayMessageBytes,
  );
  assert.equal(hostMessageSchema.safeParse(message).success, true);
});

void test("rejects a gateway snapshot over the payload budget", () => {
  const message = snapshotMessageAtPayloadSize(maximumGatewayMessageBytes + 1);
  const result = hostMessageSchema.safeParse(message);

  assert.equal(
    serializedGatewayMessageBytes(message),
    maximumGatewayMessageBytes + 1,
  );
  assert.equal(result.success, false);
  if (!result.success) {
    assert.deepEqual(
      result.error.issues.map((issue) => issue.message),
      ["Gateway message exceeds the 4 MiB payload budget."],
    );
  }
});

void test("accepts a complete managed settings delivery", () => {
  assert.equal(
    fleetManagedSettingsDeliverySchema.safeParse(managedSettingsDelivery())
      .success,
    true,
  );
});

void test("rejects invalid managed settings identifiers and relationships", () => {
  const invalidManager = managedSettingsDelivery();
  invalidManager.managerId = "manager-not-valid";

  const invalidUuid = managedSettingsDelivery();
  invalidUuid.profile.document.instructions[0]!.id = "not-a-uuid";

  const defaultsDelivery = managedSettingsDelivery();
  const invalidDefaults = {
    ...defaultsDelivery,
    profile: {
      ...defaultsDelivery.profile,
      document: {
        ...defaultsDelivery.profile.document,
        defaults: {
          ...defaultsDelivery.profile.document.defaults,
          provider: null,
        },
      },
    },
  };

  const contextPackDelivery = managedSettingsDelivery();
  const contextPack = contextPackDelivery.profile.document.contextPacks[0]!;
  const invalidContextPack = {
    ...contextPackDelivery,
    profile: {
      ...contextPackDelivery.profile,
      document: {
        ...contextPackDelivery.profile.document,
        contextPacks: [{ ...contextPack, model: null }],
      },
    },
  };

  assert.equal(
    fleetManagedSettingsDeliverySchema.safeParse(invalidManager).success,
    false,
  );
  assert.equal(
    fleetManagedSettingsDeliverySchema.safeParse(invalidUuid).success,
    false,
  );
  assert.equal(
    fleetManagedSettingsDeliverySchema.safeParse(invalidDefaults).success,
    false,
  );
  assert.equal(
    fleetManagedSettingsDeliverySchema.safeParse(invalidContextPack).success,
    false,
  );
});

void test("rejects excessive managed settings collections", () => {
  const delivery = managedSettingsDelivery();
  const instruction = delivery.profile.document.instructions[0]!;
  delivery.profile.document.instructions = Array.from(
    { length: maximumManagedSettingsCollectionEntries + 1 },
    (_, index) => ({
      ...instruction,
      id: `123e4567-e89b-42d3-a456-${index.toString().padStart(12, "0")}`,
      name: `Instruction ${index}`,
      tags: [`tag-${index}`],
    }),
  );

  assert.equal(
    fleetManagedSettingsDeliverySchema.safeParse(delivery).success,
    false,
  );
});

void test("validates session-memory forget commands", () => {
  const command = {
    kind: "forget-session-memory",
    commandId: "command-1",
    sessionId: "session-1",
    memoryId: "memory-1",
  };

  assert.equal(productCommandSchema.safeParse(command).success, true);
  assert.equal(
    productCommandSchema.safeParse({ ...command, memoryId: "" }).success,
    false,
  );
});
