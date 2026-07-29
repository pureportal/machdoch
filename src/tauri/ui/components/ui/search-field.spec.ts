import { LoaderCircle } from "lucide-react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { SearchField } from "./search-field";

describe("SearchField", () => {
  it("renders the shared search affordance and input semantics", () => {
    const markup = renderToStaticMarkup(
      createElement(SearchField, {
        "aria-label": "Search workspaces",
        placeholder: "Search workspaces",
        defaultValue: "docs",
        className: "rounded-xl",
        containerClassName: "w-72",
      }),
    );

    expect(markup).toContain('data-slot="search-field"');
    expect(markup).toContain('data-slot="search-field-icon"');
    expect(markup).toContain('type="search"');
    expect(markup).toContain('aria-label="Search workspaces"');
    expect(markup).toContain("pl-9");
    expect(markup).toContain("rounded-xl");
    expect(markup).toContain("w-72");
  });

  it("reserves space for a trailing activity indicator", () => {
    const markup = renderToStaticMarkup(
      createElement(SearchField, {
        "aria-label": "Search catalog",
        endAdornment: createElement(LoaderCircle, {
          "aria-label": "Updating results",
        }),
      }),
    );

    expect(markup).toContain('data-slot="search-field-end"');
    expect(markup).toContain('aria-label="Updating results"');
    expect(markup).toContain("pr-9");
  });

  it("keeps context-specific input sizing overrides", () => {
    const markup = renderToStaticMarkup(
      createElement(SearchField, {
        "aria-label": "Search compact results",
        className: "h-8 pl-8 text-[10px] md:text-[10px]",
        iconClassName: "left-2.5 size-3.5",
      }),
    );

    expect(markup).toContain("pl-8");
    expect(markup).not.toContain("pl-9");
    expect(markup).toContain("left-2.5");
    expect(markup).toContain("size-3.5");
  });
});
