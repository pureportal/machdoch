import { expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { CloudAgentContextLimit } from "@machdoch/fleet-protocol/cloud-agent";
import {
  CloudAgentModelAdapter,
  type CloudModelTransport,
} from "./model-adapter.js";
import type { AgentModelStartParams } from "@machdoch/model-runtime/types";

const parameters: AgentModelStartParams = {
  model: "granted-model",
  reasoning: "high",
  toolChoice: "required",
  systemPrompt: "Runtime instructions",
  userPrompt: "Inspect the task source",
  tools: [
    {
      name: "read_file",
      description: "Read a file",
      inputSchema: { type: "object" },
    },
  ],
};

it("recompacts completed context after a reduced allowance without changing the original task", async () => {
  const transport = vi
    .fn<CloudModelTransport>()
    .mockResolvedValueOnce({
      text: "Read",
      toolCalls: [
        { id: "read", name: "read_file", arguments: { path: "README" } },
      ],
    })
    .mockRejectedValueOnce(new CloudAgentContextLimit(800))
    .mockResolvedValueOnce({ text: "Done", toolCalls: [] });
  const adapter = new CloudAgentModelAdapter("granted-model", 4096, transport);
  await adapter.startTurn(parameters);
  await adapter.continueTurn({
    toolResults: [
      {
        callId: "read",
        name: "read_file",
        output: "Read result: " + "x".repeat(2000),
      },
    ],
  });
  const initial = transport.mock.calls[1]![0],
    reduced = transport.mock.calls[2]![0];
  expect(initial.requestId).not.toBe(reduced.requestId);
  expect(Buffer.byteLength(reduced.context)).toBeLessThanOrEqual(800);
  expect(JSON.parse(reduced.context).messages[0].content).toBe(
    parameters.userPrompt,
  );
  expect(reduced.context).toContain("Read result:");
});

it("fails without dropping the original task when its prompt cannot fit the remaining allowance", async () => {
  const transport = vi
    .fn<CloudModelTransport>()
    .mockRejectedValue(new CloudAgentContextLimit(256));
  const adapter = new CloudAgentModelAdapter("granted-model", 4096, transport);
  await expect(
    adapter.startTurn({ ...parameters, userPrompt: "required ".repeat(100) }),
  ).rejects.toThrow("remaining cloud context allowance");
  expect(transport).toHaveBeenCalledTimes(1);
});

it("carries runtime guidance, options and complete tool exchanges without provider credentials", async () => {
  const transport = vi
    .fn()
    .mockResolvedValueOnce({
      text: "Inspecting",
      toolCalls: [
        { id: "read-1", name: "read_file", arguments: { path: "README" } },
      ],
    })
    .mockResolvedValueOnce({ text: "Finished", toolCalls: [] });
  const adapter = new CloudAgentModelAdapter("granted-model", 4096, transport);
  await adapter.startTurn(parameters);
  await adapter.continueTurn({
    toolResults: [
      { callId: "read-1", name: "read_file", output: "File contents" },
    ],
  });
  const [request] = transport.mock.calls[1]!;
  expect(request).toMatchObject({
    runtimePrompt: parameters.systemPrompt,
    modelOptions: { reasoning: "high", toolChoice: "required" },
  });
  expect(JSON.parse(request.context).messages).toEqual([
    { role: "user", content: parameters.userPrompt },
    {
      role: "assistant",
      content: "Inspecting",
      toolCalls: [
        { id: "read-1", name: "read_file", arguments: { path: "README" } },
      ],
    },
    {
      role: "tool",
      callId: "read-1",
      name: "read_file",
      output: "File contents",
    },
  ]);
  expect(request.requestId).not.toBe(transport.mock.calls[0]![0].requestId);
  expect(request).not.toHaveProperty("model");
  expect(request).not.toHaveProperty("provider");
});

it("rejects a model override and stale tool results before sending another request", async () => {
  const transport = vi.fn().mockResolvedValue({
    text: "",
    toolCalls: [{ id: "read-1", name: "read_file", arguments: {} }],
  });
  const adapter = new CloudAgentModelAdapter("granted-model", 4096, transport);
  await expect(
    adapter.startTurn({ ...parameters, model: "another-model" }),
  ).rejects.toThrow("grant");
  expect(transport).not.toHaveBeenCalled();
  await adapter.startTurn(parameters);
  await expect(
    adapter.continueTurn({
      toolResults: [{ callId: "old-read", name: "read_file", output: "stale" }],
    }),
  ).rejects.toThrow("pending model turn");
  expect(transport).toHaveBeenCalledTimes(1);
});

it("omits whole older exchanges while retaining the latest observation", async () => {
  let sequence = 0;
  const transport = vi.fn<CloudModelTransport>(async () => ({
    text: "",
    toolCalls: [{ id: `read-${++sequence}`, name: "read_file", arguments: {} }],
  }));
  const adapter = new CloudAgentModelAdapter("granted-model", 900, transport);
  await adapter.startTurn(parameters);
  for (let index = 1; index <= 3; index++)
    await adapter.continueTurn({
      toolResults: [
        {
          callId: `read-${index}`,
          name: "read_file",
          output: `observation-${index}:` + "x".repeat(220),
        },
      ],
    });
  const request = transport.mock.calls.at(-1)![0];
  const context = JSON.parse(request.context);
  expect(context.omittedExchanges).toBeGreaterThan(0);
  expect(request.context).toContain("observation-3:");
  expect(request.context).not.toContain("observation-1:");
  expect(
    Buffer.byteLength(request.context),
  ).toBeLessThanOrEqual(900);
});

it("keeps large completed writes recoverable through bounded previews and digests", async () => {
  const argumentsValue = {
    path: "large.txt",
    content: "start--" + "λ".repeat(40000) + "--end",
  };
  const transport = vi
    .fn<CloudModelTransport>()
    .mockResolvedValueOnce({
      text: "",
      toolCalls: [
        { id: "write", name: "create_file", arguments: argumentsValue },
      ],
    })
    .mockResolvedValueOnce({ text: "Complete", toolCalls: [] });
  const adapter = new CloudAgentModelAdapter("granted-model", 4096, transport);
  await adapter.startTurn({
    ...parameters,
    tools: [
      {
        name: "create_file",
        description: "Create a file",
        inputSchema: { type: "object" },
      },
    ],
  });
  await adapter.continueTurn({
    toolResults: [
      { callId: "write", name: "create_file", output: "Created large.txt." },
    ],
  });
  const request = transport.mock.calls[1]![0];
  const call = JSON.parse(request.context).messages[1].toolCalls[0];
  expect(call.truncatedArguments).toBe(true);
  expect(call.argumentsSha256).toBe(
    createHash("sha256").update(JSON.stringify(argumentsValue)).digest("hex"),
  );
  expect(call.argumentsPreview).toContain("start--");
  expect(call.argumentsPreview).toContain("--end");
  expect(request.context).toContain("Created large.txt.");
  expect(
    Buffer.byteLength(request.context),
  ).toBeLessThanOrEqual(4096);
});
