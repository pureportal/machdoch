import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { PromptEnhancementPending } from "./prompt-enhancement-pending";

describe("PromptEnhancementPending", () => {
  it("renders a compact editor replacement without agent-style progress", () => {
    const markup = renderToStaticMarkup(
      createElement(PromptEnhancementPending, {
        variant: "editor",
        modeLabel: "Simple enhance",
        onCancel: () => {},
      }),
    );

    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain("Enhance ongoing");
    expect(markup).toContain('aria-label="Cancel edit"');
    expect(markup).not.toContain("Simple enhance");
    expect(markup).not.toContain("Enhancing prompt");
    expect(markup).not.toContain("lucide-loader-circle");
    expect(markup).not.toContain("Execution timeline");
  });

  it("retains the existing panel presentation for other flows", () => {
    const markup = renderToStaticMarkup(
      createElement(PromptEnhancementPending, {
        modeLabel: "Enhance with web search",
      }),
    );

    expect(markup).toContain("Enhancing prompt");
    expect(markup).toContain("Enhance with web search");
    expect(markup).toContain("lucide-loader-circle");
  });
});
