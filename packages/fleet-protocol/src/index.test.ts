import assert from "node:assert/strict";
import test from "node:test";

import {
  projectNameSchema,
  fleetManagedSettingsDeliverySchema,
  hostMessageSchema,
  maximumGatewayMessageBytes,
  maximumManagedSettingsCollectionEntries,
  maximumManagedSettingsDeliveryBytes,
  productCommandSchema,
  serializedGatewayMessageBytes,
} from "./index.ts";

void test("project commands constrain folder names and reject arbitrary paths or extra fields", () => {
  for (const name of [
    "../escape",
    "C:\\projects",
    "/etc",
    ".hidden",
    "CON",
    "nul.txt",
    "com1",
    "name.",
    "with space",
    "a/b",
  ])
    assert.equal(projectNameSchema.safeParse(name).success, false, name);
  for (const name of ["my-project", "repo_2", "App.UI"])
    assert.equal(projectNameSchema.safeParse(name).success, true, name);
  const command = {
    kind: "clone-project",
    name: "repo",
    repository: "https://example.com/repo.git",
    shallow: false,
  };
  assert.equal(productCommandSchema.safeParse(command).success, true);
  assert.equal(
    productCommandSchema.safeParse({ ...command, workspace: "/arbitrary" })
      .success,
    false,
  );
  assert.equal(
    productCommandSchema.safeParse({ kind: "create-project", name: "repo" })
      .success,
    false,
  );
  assert.equal(
    productCommandSchema.safeParse({
      kind: "cancel-project-operation",
      projectId: "project-1",
    }).success,
    true,
  );
});

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

const managedSettingsDeliveryAtPayloadSize = (size: number) => {
  const delivery = managedSettingsDelivery();
  const contextPack = delivery.profile.document.contextPacks[0]!;
  delivery.profile.document.instructions = [];
  delivery.profile.document.prompts = [];
  delivery.profile.document.contextPacks = Array.from(
    { length: maximumManagedSettingsCollectionEntries },
    (_, index) => ({
      ...contextPack,
      id: `123e4567-e89b-42d3-a456-${index.toString().padStart(12, "0")}`,
      name: `Context pack ${index}`,
      instructions: "",
      prompt: "x",
    }),
  );

  let remaining = size - serializedGatewayMessageBytes(delivery);
  for (const pack of delivery.profile.document.contextPacks) {
    const instructionLength = Math.min(remaining, 128 * 1024);
    pack.instructions = "x".repeat(instructionLength);
    remaining -= instructionLength;

    const promptLength = Math.min(remaining, 128 * 1024 - 1);
    pack.prompt = "x".repeat(promptLength + 1);
    remaining -= promptLength;
  }

  assert.equal(remaining, 0);
  assert.equal(serializedGatewayMessageBytes(delivery), size);
  return delivery;
};

void test("accepts a gateway snapshot at the payload budget", () => {
  const message = snapshotMessageAtPayloadSize(maximumGatewayMessageBytes);

  assert.equal(
    serializedGatewayMessageBytes(message),
    maximumGatewayMessageBytes,
  );
  assert.equal(hostMessageSchema.safeParse(message).success, true);
});

void test("accepts a gateway snapshot below the payload budget", () => {
  const message = snapshotMessageAtPayloadSize(maximumGatewayMessageBytes - 1);

  assert.equal(
    serializedGatewayMessageBytes(message),
    maximumGatewayMessageBytes - 1,
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

void test("normalizes ECMAScript boundary whitespace in managed settings", () => {
  const delivery = managedSettingsDelivery();
  const profile = delivery.profile!;
  const document = profile.document;

  profile.name = " \uFEFFEngineering\uFEFF ";
  document.defaults.model = "\u3000gpt-5.6\u3000";
  document.instructions[0]!.name = "\uFEFFReview\uFEFF";
  document.instructions[0]!.tags = ["\uFEFFreview\uFEFF"];
  document.contextPacks[0]!.name = "\uFEFFChange review\uFEFF";
  document.contextPacks[0]!.model = "\uFEFFgpt-5.6\uFEFF";
  document.contextPacks[0]!.triggerPhrases = ["\uFEFFreview\uFEFF"];
  document.contextPacks[0]!.pathPatterns = ["\uFEFFsrc/**\uFEFF"];
  document.prompts[0]!.relativePath = "\uFEFFreview.prompt.md\uFEFF";

  const result = fleetManagedSettingsDeliverySchema.parse(delivery);

  assert.deepEqual(result.profile, managedSettingsDelivery().profile);

  const whitespaceOnly = managedSettingsDelivery();
  whitespaceOnly.profile!.name = " \uFEFF\u3000 ";
  assert.equal(
    fleetManagedSettingsDeliverySchema.safeParse(whitespaceOnly).success,
    false,
  );
});

void test("enforces the managed settings delivery payload budget", () => {
  for (const size of [
    maximumManagedSettingsDeliveryBytes - 1,
    maximumManagedSettingsDeliveryBytes,
  ]) {
    assert.equal(
      fleetManagedSettingsDeliverySchema.safeParse(
        managedSettingsDeliveryAtPayloadSize(size),
      ).success,
      true,
    );
  }

  const result = fleetManagedSettingsDeliverySchema.safeParse(
    managedSettingsDeliveryAtPayloadSize(
      maximumManagedSettingsDeliveryBytes + 1,
    ),
  );

  assert.equal(result.success, false);
  if (!result.success) {
    assert.deepEqual(
      result.error.issues.map((issue) => issue.message),
      ["Managed settings delivery exceeds the 18 MiB payload budget."],
    );
  }
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

void test("canonicalizes product command values", () => {
  const ralphRun = productCommandSchema.parse({
    kind: "ralph-run",
    commandId: " command-1 ",
    workspace: " C:\\workspace ",
    scope: "workspace",
    flowId: " release-flow ",
    parameters: { " environment ": "production" },
    provider: " openai ",
    model: " gpt-5.6 ",
    reasoning: "high",
  });

  assert.deepEqual(ralphRun, {
    kind: "ralph-run",
    commandId: "command-1",
    workspace: "C:\\workspace",
    scope: "workspace",
    flowId: "release-flow",
    parameters: { environment: "production" },
    provider: "openai",
    model: "gpt-5.6",
    reasoning: "high",
  });

  const mediaRun = productCommandSchema.parse({
    kind: "generate-media",
    prompt: " Create a geometric owl ",
    modelId: " openai:gpt-image-2 ",
    target: "image",
    aspectRatio: "1:1",
    outputCount: 1,
    outputFormat: "png",
    transparentBackground: false,
  });

  assert.deepEqual(mediaRun, {
    kind: "generate-media",
    prompt: "Create a geometric owl",
    modelId: "openai:gpt-image-2",
    target: "image",
    aspectRatio: "1:1",
    outputCount: 1,
    outputFormat: "png",
    transparentBackground: false,
  });
});

void test("rejects product command fields from other variants", () => {
  const cancel = { kind: "cancel", taskId: "task-1" };

  assert.equal(productCommandSchema.safeParse(cancel).success, true);
  assert.equal(
    productCommandSchema.safeParse({ ...cancel, sessionId: "session-1" })
      .success,
    false,
  );
  assert.equal(
    productCommandSchema.safeParse({ ...cancel, sessionId: null }).success,
    false,
  );
});

void test("requires GenerateMedia output formats compatible with the target", () => {
  const command = {
    kind: "generate-media",
    prompt: "Create a geometric owl",
    modelId: "openai:gpt-image-2",
    target: "image",
    aspectRatio: "1:1",
    outputCount: 1,
    outputFormat: "png",
    transparentBackground: false,
  };

  for (const outputFormat of ["png", "jpeg", "webp"]) {
    assert.equal(
      productCommandSchema.safeParse({ ...command, outputFormat }).success,
      true,
    );
  }

  assert.equal(
    productCommandSchema.safeParse({
      ...command,
      target: "svg",
      outputFormat: "svg",
    }).success,
    true,
  );

  for (const [target, outputFormat] of [
    ["image", "svg"],
    ["svg", "png"],
    ["svg", "jpeg"],
    ["svg", "webp"],
  ]) {
    assert.equal(
      productCommandSchema.safeParse({ ...command, target, outputFormat })
        .success,
      false,
    );
  }
});
