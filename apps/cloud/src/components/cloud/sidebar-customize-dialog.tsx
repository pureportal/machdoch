"use client";

import { useRef, useState } from "react";
import { GripVertical } from "lucide-react";
import type { CloudWorkspace } from "@/lib/cloud-contract";
import {
  defaultSidebarPreferences,
  moveSidebarEntry,
  sidebarEntries,
  sidebarPreferencesFrom,
  type SidebarEntry,
  type SidebarGroup,
  type SidebarItemId,
  type SidebarPlacement,
  type SidebarPreferences,
  type SidebarSection,
} from "@/lib/cloud-sidebar-contract";
import { FormDialog } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import { createCommandSender } from "./api-client";
import { sidebarAccess, sidebarIcons } from "./navigation";

const groups: { group: SidebarGroup; label: string }[] = [
  { group: "top", label: "Personal" },
  { group: "workspace", label: "Workspace" },
];
const placements: { value: SidebarPlacement; label: string }[] = [
  { value: "show", label: "Show" },
  { value: "more", label: "More" },
  { value: "hide", label: "Hide" },
];

export function SidebarCustomizeDialog({
  onOpenChange,
  workspace,
  preferences,
  onSaved,
}: {
  onOpenChange: (open: boolean) => void;
  workspace: CloudWorkspace;
  preferences: SidebarPreferences;
  onSaved: (preferences: SidebarPreferences) => void;
}) {
  const role = workspace.actor.role;
  const admin = role === "owner" || role === "admin";
  const [entries, setEntries] = useState<SidebarEntry[]>(() =>
    sidebarEntries(preferences, sidebarAccess(workspace)),
  );
  const [hiddenSections, setHiddenSections] = useState<SidebarSection[]>(
    preferences.hiddenSections,
  );
  const [hiddenTeams, setHiddenTeams] = useState<string[]>(
    preferences.hiddenTeamIds,
  );
  const [dragging, setDragging] = useState<SidebarItemId | null>(null);
  const sender = useRef(createCommandSender());
  const reset = () => {
    setEntries(
      sidebarEntries(defaultSidebarPreferences, sidebarAccess(workspace)),
    );
    setHiddenSections(defaultSidebarPreferences.hiddenSections);
    setHiddenTeams(defaultSidebarPreferences.hiddenTeamIds);
  };
  const sections: { section: SidebarSection; label: string }[] = [
    { section: "favorites", label: "Favorites" },
    ...(admin ? [{ section: "devices" as const, label: "Clients" }] : []),
    { section: "teams", label: "Your teams" },
  ];
  const toggle = <T,>(values: T[], value: T) =>
    values.includes(value)
      ? values.filter((entry) => entry !== value)
      : [...values, value];
  const neighbor = (id: SidebarItemId, step: number) => {
    const entry = entries.find((candidate) => candidate.item.id === id)!;
    const peers = entries.filter(
      (candidate) => candidate.item.group === entry.item.group,
    );
    return peers[peers.indexOf(entry) + step]?.item.id;
  };
  return (
    <FormDialog
      open
      onOpenChange={onOpenChange}
      title="Customize sidebar"
      submitLabel="Save"
      onSubmit={async () => {
        const result = await sender.current<{
          preferences: SidebarPreferences;
        }>(
          "sidebar",
          sidebarPreferencesFrom(entries, hiddenSections, hiddenTeams),
          "PATCH",
        );
        onSaved(result.preferences);
        onOpenChange(false);
      }}
    >
      <div className="cloud-sidebar-customize">
        {groups.map(({ group, label }) => (
          <section key={group} aria-label={label}>
            <h3>{label}</h3>
            <ol>
              {entries
                .filter((entry) => entry.item.group === group)
                .map((entry) => {
                  const Icon = sidebarIcons[entry.item.id];
                  return (
                    <li
                      key={entry.item.id}
                      draggable
                      data-dragging={dragging === entry.item.id || undefined}
                      data-placement={entry.placement}
                      onDragStart={(event) => {
                        event.dataTransfer.effectAllowed = "move";
                        setDragging(entry.item.id);
                      }}
                      onDragEnd={() => setDragging(null)}
                      onDragOver={(event) => {
                        if (!dragging || dragging === entry.item.id) return;
                        event.preventDefault();
                        setEntries((current) =>
                          moveSidebarEntry(current, dragging, entry.item.id),
                        );
                      }}
                      onDrop={(event) => event.preventDefault()}
                    >
                      <button
                        type="button"
                        className="cloud-sidebar-customize-handle"
                        aria-label={`Move ${entry.item.label}`}
                        aria-keyshortcuts="ArrowUp ArrowDown"
                        onKeyDown={(event) => {
                          const step =
                            event.key === "ArrowUp"
                              ? -1
                              : event.key === "ArrowDown"
                                ? 1
                                : 0;
                          const target = step && neighbor(entry.item.id, step);
                          if (!target) return;
                          event.preventDefault();
                          setEntries((current) =>
                            moveSidebarEntry(current, entry.item.id, target),
                          );
                        }}
                      >
                        <GripVertical size={14} />
                      </button>
                      <Icon size={15} strokeWidth={1.7} aria-hidden="true" />
                      <span>{entry.item.label}</span>
                      <span
                        className="cloud-sidebar-placement"
                        role="radiogroup"
                        aria-label={`${entry.item.label} placement`}
                      >
                        {placements.map((placement) => (
                          <button
                            key={placement.value}
                            type="button"
                            role="radio"
                            aria-checked={entry.placement === placement.value}
                            onClick={() =>
                              setEntries((current) =>
                                current.map((candidate) =>
                                  candidate.item.id === entry.item.id
                                    ? {
                                        ...candidate,
                                        placement: placement.value,
                                      }
                                    : candidate,
                                ),
                              )
                            }
                          >
                            {placement.label}
                          </button>
                        ))}
                      </span>
                    </li>
                  );
                })}
            </ol>
          </section>
        ))}
        <section aria-label="Sections">
          <h3>Sections</h3>
          {sections.map(({ section, label }) => (
            <label key={section} className="cloud-sidebar-customize-toggle">
              <input
                type="checkbox"
                checked={!hiddenSections.includes(section)}
                onChange={() =>
                  setHiddenSections((current) => toggle(current, section))
                }
              />
              {label}
            </label>
          ))}
        </section>
        {workspace.teams.length > 0 && !hiddenSections.includes("teams") && (
          <section aria-label="Teams">
            <h3>Teams</h3>
            {workspace.teams.map((team) => (
              <label key={team.id} className="cloud-sidebar-customize-toggle">
                <input
                  type="checkbox"
                  checked={!hiddenTeams.includes(team.id)}
                  onChange={() =>
                    setHiddenTeams((current) => toggle(current, team.id))
                  }
                />
                {team.name}
              </label>
            ))}
          </section>
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="cloud-sidebar-customize-reset"
          onClick={reset}
        >
          Reset to default
        </Button>
      </div>
    </FormDialog>
  );
}
