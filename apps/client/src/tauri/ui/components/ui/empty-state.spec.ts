import { Search } from "lucide-react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { EmptyState } from "./empty-state";

describe("EmptyState", () => {
  it("renders consistent title, description, icon, and status semantics", () => {
    const markup = renderToStaticMarkup(
      createElement(EmptyState, {
        icon: Search,
        title: "No matching workspaces",
        description: "Try a different name or path.",
        size: "compact",
        role: "status",
      }),
    );

    expect(markup).toContain('data-slot="empty-state"');
    expect(markup).toContain('data-size="compact"');
    expect(markup).toContain('role="status"');
    expect(markup).toContain('data-slot="empty-state-icon"');
    expect(markup).toContain('data-slot="empty-state-title"');
    expect(markup).toContain("No matching workspaces");
    expect(markup).toContain("Try a different name or path.");
  });

  it("supports page-level headings and actions", () => {
    const markup = renderToStaticMarkup(
      createElement(EmptyState, {
        title: "No runs yet",
        titleAs: "h2",
        size: "large",
        action: createElement("button", { type: "button" }, "New recipe"),
      }),
    );

    expect(markup).toContain('<h2 data-slot="empty-state-title"');
    expect(markup).toContain('data-slot="empty-state-action"');
    expect(markup).toContain("New recipe");
  });
});
