import { describe, expect, it } from "vitest";
import {
  defaultSidebarPreferences,
  moveSidebarEntry,
  resolveSidebar,
  sidebarEntries,
  sidebarPreferencesFrom,
  sidebarPreferencesSchema,
} from "./cloud-sidebar-contract";

const ids = (items: { id: string }[]) => items.map((item) => item.id);

describe("sidebar preferences", () => {
  it("shows Clients directly to administrators by default", () => {
    const admin = resolveSidebar(defaultSidebarPreferences, {
      role: "admin",
      github: false,
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
      "clients",
    ]);
    expect(ids(admin.more)).toContain("settings");
    const member = resolveSidebar(defaultSidebarPreferences, {
      role: "member",
      github: false,
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
          role: "member",
          github: true,
        }).workspace,
      ).slice(0, 2),
    ).toEqual(["issues", "pull-requests"]);
    expect(
      ids(
        sidebarEntries(defaultSidebarPreferences, {
          role: "owner",
          github: false,
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
        { id: "roadmap", placement: "show" },
      ],
      hiddenSections: ["favorites"],
      hiddenTeamIds: [],
    });
    const sidebar = resolveSidebar(preferences, {
      role: "owner",
      github: false,
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
      "roadmap",
      "initiatives",
      "views",
      "cycles",
    ]);
    expect(ids(sidebar.more)[0]).toBe("projects");
    expect(sidebar.sections.favorites).toBe(false);
    const member = resolveSidebar(preferences, {
      role: "member",
      github: false,
    });
    expect(ids(member.workspace)).toEqual([
      "issues",
      "roadmap",
      "initiatives",
      "views",
      "cycles",
    ]);
  });

  it("reorders entries only within their group", () => {
    const entries = sidebarEntries(defaultSidebarPreferences, {
      role: "admin",
      github: false,
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
      role: "admin",
      github: false,
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
      ids(resolveSidebar(saved, { role: "admin", github: false }).top),
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
});
