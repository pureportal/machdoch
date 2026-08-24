import { describe, expect, it } from "vitest";
import { CopilotCliOutputDecoder } from "./copilot-cli-output.js";

const eventLine = (value: Record<string, unknown>): string =>
  `${JSON.stringify(value)}\n`;

describe("Copilot CLI output decoder", () => {
  it("keeps intermediate messages separate from the final answer and result", () => {
    const decoder = new CopilotCliOutputDecoder();
    const output = [
      eventLine({
        type: "assistant.message",
        data: {
          content: "Inspecting the repository.",
          toolRequests: [{ name: "view" }],
        },
      }),
      eventLine({ type: "tool.execution_start", data: { toolName: "view" } }),
      eventLine({
        type: "assistant.message",
        data: {
          messageId: "final-message",
          content: "Final ",
          chunkIndex: 0,
          chunkCount: 2,
        },
      }),
      eventLine({
        type: "assistant.message",
        data: {
          messageId: "final-message",
          content: "answer.",
          chunkIndex: 1,
          chunkCount: 2,
        },
      }),
      eventLine({ type: "result", exitCode: 0 }),
    ].join("");
    const updates = [
      decoder.push(output.slice(0, 17)),
      decoder.push(output.slice(17, 113)),
      decoder.push(output.slice(113)),
    ];

    expect(updates.flatMap((update) => update.displayText)).toEqual([
      "Inspecting the repository.\n\n",
      "Final answer.\n\n",
    ]);
    expect(
      updates.find((update) => update.resultExitCode !== undefined)
        ?.resultExitCode,
    ).toBe(0);
    expect(decoder.getFinalOutput()).toBe("Final answer.");
    expect(decoder.isModelCallCountReported()).toBe(false);
  });

  it("uses the task summary when the latest assistant text starts tools", () => {
    const decoder = new CopilotCliOutputDecoder();

    decoder.push(
      eventLine({
        type: "assistant.message",
        data: { content: "Beginning the task.", toolRequests: [] },
      }),
    );
    decoder.push(
      eventLine({
        type: "assistant.message",
        data: {
          content: "Running the requested checks.",
          toolRequests: [{ name: "powershell" }],
        },
      }),
    );
    decoder.push(
      eventLine({
        type: "session.task_complete",
        data: { summary: "Task finished.", success: true },
      }),
    );
    const update = decoder.push(
      JSON.stringify({ type: "result", exitCode: 0 }),
    );
    const finalUpdate = decoder.finish();

    expect(update.resultExitCode).toBeUndefined();
    expect(finalUpdate.resultExitCode).toBe(0);
    expect(decoder.getFinalOutput()).toBe("Task finished.");
  });
});
