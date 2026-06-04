import { describe, expect, it } from "vitest";
import { createAiContextHistory } from "./ai-context-window";

describe("createAiContextHistory", () => {
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
        content: 'Describe this image\n\nUse this image: "C:\\Docs\\screen.png"',
      },
    ]);
  });
});
