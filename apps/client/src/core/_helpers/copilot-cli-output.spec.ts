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

  it("ignores subagent messages and completion events", () => {
    const decoder = new CopilotCliOutputDecoder();

    const rootUpdate = decoder.push(
      eventLine({
        type: "assistant.message",
        data: { content: "Implemented the ticket." },
      }),
    );
    const subagentUpdate = decoder.push(
      [
        eventLine({
          type: "assistant.message",
          agentId: "rubber-duck-1",
          data: { content: "No findings." },
        }),
        eventLine({
          type: "session.task_complete",
          agentId: "rubber-duck-1",
          data: {
            summary: "Review blocked.",
            success: false,
            outcome: "blocked",
          },
        }),
      ].join(""),
    );
    decoder.push(
      eventLine({
        type: "session.task_complete",
        data: {
          summary: "Implemented and verified the ticket.",
          success: true,
          outcome: "completed",
        },
      }),
    );
    const resultUpdate = decoder.push(
      eventLine({ type: "result", exitCode: 0 }),
    );

    expect(rootUpdate.displayText).toEqual(["Implemented the ticket.\n\n"]);
    expect(subagentUpdate.displayText).toEqual([]);
    expect(resultUpdate.resultExitCode).toBe(0);
    expect(decoder.getFinalOutput()).toBe("Implemented the ticket.");
  });

  it("reports rejected root task completion as a failed result", () => {
    const decoder = new CopilotCliOutputDecoder();

    decoder.push(
      eventLine({
        type: "session.task_complete",
        data: {
          summary: "More implementation work is required.",
          reason: "The continuation limit was reached.",
          success: false,
          outcome: "continue",
        },
      }),
    );
    const update = decoder.push(eventLine({ type: "result", exitCode: 0 }));

    expect(update.resultExitCode).toBe(1);
    expect(decoder.hasTerminalResult()).toBe(true);
    expect(decoder.getFinalOutput()).toBe(
      [
        "More implementation work is required.",
        "The continuation limit was reached.",
      ].join("\n"),
    );
  });

  it("accepts successful completion after a rejected completion attempt", () => {
    const decoder = new CopilotCliOutputDecoder();

    decoder.push(
      eventLine({
        type: "session.task_complete",
        data: { success: false, outcome: "continue" },
      }),
    );
    decoder.push(
      eventLine({
        type: "session.task_complete",
        data: {
          summary: "The remaining work was completed.",
          success: true,
          outcome: "completed",
        },
      }),
    );
    const update = decoder.push(eventLine({ type: "result", exitCode: 0 }));

    expect(update.resultExitCode).toBe(0);
    expect(decoder.getFinalOutput()).toBe("The remaining work was completed.");
  });
});
