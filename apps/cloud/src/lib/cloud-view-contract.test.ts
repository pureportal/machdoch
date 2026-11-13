import { describe, expect, it } from "vitest";
import { savedViewHref, viewChanged, viewFilters } from "./cloud-view-contract";

describe("saved views", () => {
  const view = {
    id: "8a6f8a52-6b8f-4d63-9c27-6d22a0b3c2a1",
    filters: { view: "board", priority: "high", hide: "created" },
  };

  it("links to the issues page with the view's filters", () => {
    expect(savedViewHref(view)).toBe(
      `/cloud/issues?view=board&priority=high&hide=created&savedView=${view.id}`,
    );
  });

  it("keeps only view settings from the address", () => {
    expect(
      viewFilters(
        new URLSearchParams(`view=board&savedView=${view.id}&density=compact`),
      ),
    ).toEqual({ view: "board", density: "compact" });
  });

  it("detects changes against the saved settings", () => {
    expect(
      viewChanged(view, new URLSearchParams(savedViewHref(view).split("?")[1])),
    ).toBe(false);
    expect(
      viewChanged(
        view,
        new URLSearchParams("view=board&priority=high&hide=created,updated"),
      ),
    ).toBe(true);
    expect(
      viewChanged(view, new URLSearchParams("view=board&priority=high")),
    ).toBe(true);
  });
});
