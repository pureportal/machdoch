import { describe, expect, it } from "vitest";
import {
  ALL_SESSION_PROJECTS_FILTER,
  type SessionProjectFilter,
} from "@machdoch/product-ui";
import {
  DEFAULT_SESSION_PROJECT_FILTER,
  matchesSessionProjectFilter,
  retainAvailableSessionProjects,
  toggleSessionProjectFilterProject,
} from "./session-project-filter";

describe("session project filter", () => {
  it("matches every project until a project is selected", () => {
    expect(
      matchesSessionProjectFilter(DEFAULT_SESSION_PROJECT_FILTER, "alpha"),
    ).toBe(true);
    expect(
      matchesSessionProjectFilter({ mode: "exclude", projectIds: [] }, "alpha"),
    ).toBe(true);
  });

  it("includes or excludes the selected projects", () => {
    const projectIds = ["alpha", "beta"];

    expect(
      ["alpha", "beta", "gamma"].map((projectId) =>
        matchesSessionProjectFilter({ mode: "include", projectIds }, projectId),
      ),
    ).toEqual([true, true, false]);
    expect(
      ["alpha", "beta", "gamma"].map((projectId) =>
        matchesSessionProjectFilter({ mode: "exclude", projectIds }, projectId),
      ),
    ).toEqual([false, false, true]);
  });

  it("toggles projects, keeps the mode, and clears through the all-projects id", () => {
    const filter: SessionProjectFilter = {
      mode: "exclude",
      projectIds: ["alpha"],
    };
    const withBeta = toggleSessionProjectFilterProject(filter, "beta");

    expect(withBeta).toEqual({
      mode: "exclude",
      projectIds: ["alpha", "beta"],
    });
    expect(toggleSessionProjectFilterProject(withBeta, "alpha")).toEqual({
      mode: "exclude",
      projectIds: ["beta"],
    });
    expect(
      toggleSessionProjectFilterProject(withBeta, ALL_SESSION_PROJECTS_FILTER),
    ).toEqual({ mode: "exclude", projectIds: [] });
  });

  it("drops unavailable projects and keeps the same filter when nothing changes", () => {
    const filter: SessionProjectFilter = {
      mode: "include",
      projectIds: ["alpha", "removed"],
    };
    const available = new Set(["alpha", "beta"]);
    const retained = retainAvailableSessionProjects(filter, available);

    expect(retained).toEqual({ mode: "include", projectIds: ["alpha"] });
    expect(retainAvailableSessionProjects(retained, available)).toBe(retained);
  });
});
