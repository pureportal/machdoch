import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { PromptEnhancementPending } from "./prompt-enhancement-pending";

describe("PromptEnhancementPending", () => {
  it("renders one cancellable enhancement state", () => {
    const markup = renderToStaticMarkup(
      createElement(PromptEnhancementPending, {
        onCancel: () => {},
      }),
    );

    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain("Enhancing prompt");
    expect(markup).toContain('aria-label="Cancel enhancement"');
    expect(markup).toContain("lucide-loader-circle");
    expect(markup).not.toContain("Execution timeline");
  });
});
