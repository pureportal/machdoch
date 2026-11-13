import { describe, expect, it } from "vitest";
import {
  defaultSidebarPreferences,
  moveSidebarEntry,
  resolveSidebar,
  canSeeSidebarItem,
  sidebarEntries,
  sidebarItems,
  sidebarPages,
  sidebarPreferencesFrom,
  sidebarPreferencesSchema,
} from "./cloud-sidebar-contract";
import { builtinRoles, type CloudPermission } from "./cloud-permissions";

const access = {
  owner: { owner: true, permissions: builtinRoles.owner.permissions },
  admin: { owner: false, permissions: builtinRoles.admin.permissions },
  member: { owner: false, permissions: builtinRoles.member.permissions },
};

const ids = (items: { id: string }[]) => items.map((item) => item.id);

describe("sidebar preferences", () => {
  it("shows Clients directly to administrators by default", () => {
    const admin = resolveSidebar(defaultSidebarPreferences, {
      ...access.admin,
      git: false,
    });
    expect(ids(admin.top)).toEqual([
      "inbox",
      "my-issues",
      "pulse",
      "agent",
      "activity",
    ]);
    expect(ids(admin.workspace)).toEqual([
      "issues",
      "initiatives",
      "projects",
      "views",
      "cycles",
      "releases",
      "automations",
      "clients",
    ]);
    expect(ids(admin.more)).toContain("settings");
    const member = resolveSidebar(defaultSidebarPreferences, {
      ...access.member,
      git: false,
    });
    expect(ids(member.workspace)).not.toContain("clients");
    expect(ids(member.more)).not.toContain("settings");
    expect(member.sections).toEqual({
      favorites: true,
      teams: true,
      devices: true,
    });
  });

  it("shows pull requests next to issues only when GitHub is connected", () => {
    expect(
      ids(
        resolveSidebar(defaultSidebarPreferences, {
          ...access.member,
          git: true,
        }).workspace,
      ).slice(0, 2),
    ).toEqual(["issues", "pull-requests"]);
    expect(
      ids(
        sidebarEntries(defaultSidebarPreferences, {
          ...access.owner,
          git: false,
        }).map((entry) => entry.item),
      ),
    ).not.toContain("pull-requests");
  });

  it("applies the saved order and placements and appends new items", () => {
    const preferences = sidebarPreferencesSchema.parse({
      items: [
        { id: "clients", placement: "show" },
        { id: "issues", placement: "show" },
        { id: "pulse", placement: "hide" },
        { id: "projects", placement: "more" },
        { id: "teams", placement: "show" },
      ],
      hiddenSections: ["favorites"],
      hiddenTeamIds: [],
    });
    const sidebar = resolveSidebar(preferences, {
      ...access.owner,
      git: false,
    });
    expect(ids(sidebar.top)).toEqual([
      "inbox",
      "my-issues",
      "agent",
      "activity",
    ]);
    expect(ids(sidebar.workspace)).toEqual([
      "clients",
      "issues",
      "teams",
      "initiatives",
      "views",
      "cycles",
      "releases",
      "automations",
    ]);
    expect(ids(sidebar.more)[0]).toBe("projects");
    expect(sidebar.sections.favorites).toBe(false);
    const member = resolveSidebar(preferences, {
      ...access.member,
      git: false,
    });
    expect(ids(member.workspace)).toEqual([
      "issues",
      "teams",
      "initiatives",
      "views",
      "cycles",
      "releases",
      "automations",
    ]);
  });

  it("reorders entries only within their group", () => {
    const entries = sidebarEntries(defaultSidebarPreferences, {
      ...access.admin,
      git: false,
    });
    const moved = moveSidebarEntry(entries, "clients", "issues");
    expect(ids(moved.map((entry) => entry.item)).slice(5, 8)).toEqual([
      "clients",
      "issues",
      "initiatives",
    ]);
    expect(moveSidebarEntry(entries, "inbox", "issues")).toBe(entries);
    expect(
      ids(
        moveSidebarEntry(entries, "inbox", "agent").map((entry) => entry.item),
      ).slice(0, 4),
    ).toEqual(["my-issues", "pulse", "agent", "inbox"]);
  });

  it("round-trips edited entries and rejects duplicates", () => {
    const entries = sidebarEntries(defaultSidebarPreferences, {
      ...access.admin,
      git: false,
    });
    const reordered = [entries[1]!, entries[0]!, ...entries.slice(2)].map(
      (entry) =>
        entry.item.id === "agent"
          ? { ...entry, placement: "hide" as const }
          : entry,
    );
    const saved = sidebarPreferencesFrom(reordered, ["devices"], []);
    expect(sidebarPreferencesSchema.parse(saved)).toEqual(saved);
    expect(
      ids(resolveSidebar(saved, { ...access.admin, git: false }).top),
    ).toEqual(["my-issues", "inbox", "pulse", "activity"]);
    expect(
      sidebarPreferencesSchema.safeParse({
        items: [
          { id: "inbox", placement: "show" },
          { id: "inbox", placement: "hide" },
        ],
        hiddenSections: [],
        hiddenTeamIds: [],
      }).success,
    ).toBe(false);
  });

  it("merges related pages into tabs that follow permissions", () => {
    const item = (id: string) =>
      sidebarItems.find((candidate) => candidate.id === id)!;
    const hrefs = (
      id: string,
      holder: { owner: boolean; permissions: readonly CloudPermission[] },
    ) => sidebarPages(item(id), holder).map((page) => page.href);
    expect(hrefs("clients", access.admin)).toEqual([
      "/instances",
      "/workspaces",
      "/enrollment",
      "/settings",
    ]);
    const profilesOnly = { owner: false, permissions: ["ai.manage"] as const };
    expect(hrefs("clients", profilesOnly)).toEqual(["/settings"]);
    expect(
      canSeeSidebarItem(item("clients"), { ...profilesOnly, git: false }),
    ).toBe(true);
    expect(
      canSeeSidebarItem(item("clients"), { ...access.member, git: false }),
    ).toBe(false);
    expect(hrefs("automations", access.member)).toEqual([
      "/cloud/automations",
      "/cloud/schedules",
    ]);
    expect(hrefs("activity", access.member)).toEqual([
      "/cloud/activity",
      "/cloud/tasks",
    ]);
    for (const entry of sidebarItems)
      for (const page of sidebarPages(entry, access.owner))
        expect(page.description.length, page.href).toBeGreaterThan(20);
    expect(
      sidebarPreferencesSchema.safeParse({
        items: [{ id: "schedules", placement: "show" }],
        hiddenSections: [],
        hiddenTeamIds: [],
      }).success,
    ).toBe(false);
  });
});
