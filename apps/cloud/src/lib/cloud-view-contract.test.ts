import { describe, expect, it } from "vitest";
import {
  maximumPinnedViews,
  pinnedViewHref,
  savedViewDraftChanged,
  savedViewHref,
  savedViewUpdate,
  togglePinnedView,
  viewChanged,
  viewFilters,
  viewPinnable,
  withoutPinnedTeam,
  type SavedView,
} from "./cloud-view-contract";

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

describe("inline view editing", () => {
  const view: SavedView = {
    id: "8a6f8a52-6b8f-4d63-9c27-6d22a0b3c2a1",
    name: "Can Be Picked",
    description: "Ready work",
    icon: "target",
    scope: "team",
    teamId: "1b6f8a52-6b8f-4d63-9c27-6d22a0b3c2a1",
    filters: { priority: "high" },
    owned: true,
  };
  const saved = new URLSearchParams("priority=high");

  it("detects name, description and filter chip changes", () => {
    const draft = { name: view.name, description: view.description };
    expect(savedViewDraftChanged(view, draft, saved)).toBe(false);
    expect(
      savedViewDraftChanged(view, { ...draft, name: "Picked " }, saved),
    ).toBe(true);
    expect(
      savedViewDraftChanged(view, { ...draft, description: "" }, saved),
    ).toBe(true);
    expect(
      savedViewDraftChanged(
        view,
        draft,
        new URLSearchParams("priority=high&status=todo"),
      ),
    ).toBe(true);
  });

  it("saves the draft and current filters while keeping icon and scope", () => {
    expect(
      savedViewUpdate(
        view,
        { name: " Picked ", description: " Next up " },
        { status: "todo" },
      ),
    ).toEqual({
      name: "Picked",
      description: "Next up",
      icon: "target",
      scope: "team",
      teamId: view.teamId,
      filters: { status: "todo" },
    });
  });
});

describe("team pinned views", () => {
  it("pins only workspace views and views of the same team", () => {
    expect(viewPinnable({ scope: "workspace", teamId: null }, "a")).toBe(true);
    expect(viewPinnable({ scope: "team", teamId: "a" }, "a")).toBe(true);
    expect(viewPinnable({ scope: "team", teamId: "b" }, "a")).toBe(false);
    expect(viewPinnable({ scope: "personal", teamId: null }, "a")).toBe(false);
  });

  it("toggles pins in order and keeps the newest within the limit", () => {
    expect(togglePinnedView(["a", "b"], "a")).toEqual(["b"]);
    expect(togglePinnedView(["a"], "b")).toEqual(["a", "b"]);
    const full = Array.from({ length: maximumPinnedViews }, (_, i) => `${i}`);
    expect(togglePinnedView(full, "new")).toEqual([...full.slice(1), "new"]);
  });

  it("opens pinned views inside the team without treating it as a change", () => {
    const workspaceView = { id: "v", filters: { priority: "high" } };
    expect(pinnedViewHref(workspaceView, "t")).toBe(
      "/cloud/issues?priority=high&teamId=t&savedView=v",
    );
    expect(
      pinnedViewHref({ id: "v", filters: { teamId: "x" } }, "t"),
    ).toBe("/cloud/issues?teamId=x&savedView=v");
    expect(
      withoutPinnedTeam(workspaceView, { priority: "high", teamId: "t" }, "t"),
    ).toEqual({ priority: "high" });
    expect(
      withoutPinnedTeam(workspaceView, { priority: "high", teamId: "t" }, null),
    ).toEqual({ priority: "high", teamId: "t" });
    expect(
      withoutPinnedTeam(
        { filters: { teamId: "t" } },
        { teamId: "t" },
        "t",
      ),
    ).toEqual({ teamId: "t" });
  });
});
