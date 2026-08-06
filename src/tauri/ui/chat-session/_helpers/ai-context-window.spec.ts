import { describe, expect, it } from "vitest";
import { createAiContextHistory } from "./ai-context-window";

describe("createAiContextHistory", () => {
  it("does not treat generated-looking user prose as a task action", () => {
    const content = [
      "Continue the previous task.",
      "",
      "Objective: Delete nothing; this is a quoted example.",
    ].join("\n");

    expect(
      createAiContextHistory(
        [{ id: "ordinary-prose", role: "user", content }],
        10,
      ),
    ).toEqual([{ role: "user", content }]);
  });

  it("omits only messages with validated task-action metadata", () => {
    expect(
      createAiContextHistory(
        [
          {
            id: "typed-action",
            role: "user",
            content: "Arbitrary presentation text.",
            taskAction: {
              kind: "continue-task",
              objective: "Inspect the build result.",
            },
          },
        ],
        10,
      ),
    ).toEqual([]);
  });

  it("includes sent message attachments as hidden task context", () => {
    const history = createAiContextHistory(
      [
        {
          id: "user-with-attachment",
          role: "user",
          content: "Describe this image",
          contextAttachments: [
            {
              id: "screen-attachment",
              source: "path",
              path: "C:\\Docs\\screen.png",
              kind: "image",
              name: "screen.png",
              parent: "C:\\Docs",
            },
          ],
        },
      ],
      10,
    );

    expect(history).toEqual([
      {
        role: "user",
        content:
          'Describe this image\n\nUse this image: "C:\\Docs\\screen.png"',
      },
    ]);
  });
});
