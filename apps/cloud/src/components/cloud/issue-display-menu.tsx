"use client";

import {
  Columns3,
  LayoutList,
  Rows3,
  Rows4,
  SlidersHorizontal,
} from "lucide-react";
import { Popover } from "radix-ui";
import { Button } from "@/components/ui/button";
import { issueDisplayProperties } from "@/lib/issue-display";
import { parseIssueSort } from "@/lib/issue-scopes";
import { issueSortLabels } from "@/lib/issue-sorting";
import {
  completedWindows,
  parseIssueViewOptions,
} from "@/lib/issue-view-options";
import { issueGroupings } from "./issue-grouping";
import { useIssueDisplay } from "./use-issue-display";

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="cloud-display-row">
      <span>{label}</span>
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}

export function IssueDisplayMenu({
  search,
  setFilter,
  layout = false,
  archived = false,
}: {
  search: URLSearchParams;
  setFilter: (name: string, value: string) => void;
  layout?: boolean;
  archived?: boolean;
}) {
  const display = useIssueDisplay();
  const options = parseIssueViewOptions(search);
  const grouping = search.get("group") ?? "status";
  const ordering = parseIssueSort(search.get("sort"));
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <Button variant="ghost" size="sm" className="cloud-filter-button">
          <SlidersHorizontal />
          Display
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="cloud-menu cloud-display-menu"
          align="end"
          sideOffset={4}
          collisionPadding={12}
          aria-label="Display options"
        >
          <div className="cloud-display-segments">
            {layout && (
              <div
                className="cloud-display-layout"
                role="group"
                aria-label="Layout"
              >
                <button
                  type="button"
                  aria-pressed={!options.board}
                  onClick={() => setFilter("view", "")}
                >
                  <LayoutList size={15} aria-hidden="true" />
                  List
                </button>
                <button
                  type="button"
                  aria-pressed={options.board}
                  onClick={() => setFilter("view", "board")}
                >
                  <Columns3 size={15} aria-hidden="true" />
                  Board
                </button>
              </div>
            )}
            <div
              className="cloud-display-layout"
              role="group"
              aria-label="Density"
            >
              <button
                type="button"
                aria-pressed={options.density === "comfortable"}
                onClick={() => setFilter("density", "")}
              >
                <Rows3 size={15} aria-hidden="true" />
                Comfortable
              </button>
              <button
                type="button"
                aria-pressed={options.density === "compact"}
                onClick={() => setFilter("density", "compact")}
              >
                <Rows4 size={15} aria-hidden="true" />
                Compact
              </button>
            </div>
          </div>
          <label className="cloud-display-row">
            <span>{options.board ? "Columns" : "Grouping"}</span>
            <select
              value={grouping}
              onChange={(event) =>
                setFilter(
                  "group",
                  event.target.value === "status" ? "" : event.target.value,
                )
              }
            >
              {Object.entries(issueGroupings)
                .filter(([value]) => !options.board || value !== "none")
                .map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
            </select>
          </label>
          <label className="cloud-display-row">
            <span>Ordering</span>
            <select
              value={ordering}
              onChange={(event) =>
                setFilter(
                  "sort",
                  event.target.value === "priority" ? "" : event.target.value,
                )
              }
            >
              {Object.entries(issueSortLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="cloud-display-row">
            <span>Completed issues</span>
            <select
              value={options.completed}
              onChange={(event) =>
                setFilter(
                  "completed",
                  event.target.value === "all" ? "" : event.target.value,
                )
              }
            >
              {Object.entries(completedWindows).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <Toggle
            label="Reverse order"
            checked={search.get("order") === "reverse"}
            onChange={(checked) => setFilter("order", checked ? "reverse" : "")}
          />
          <Toggle
            label="Sub-issues"
            checked={options.subIssues}
            onChange={(checked) =>
              setFilter("subIssues", checked ? "" : "hide")
            }
          />
          {!options.board && (
            <Toggle
              label="Empty groups"
              checked={options.emptyGroups}
              onChange={(checked) => setFilter("empty", checked ? "show" : "")}
            />
          )}
          {archived && (
            <Toggle
              label="Archived issues"
              checked={search.get("archived") === "true"}
              onChange={(checked) =>
                setFilter("archived", checked ? "true" : "")
              }
            />
          )}
          <section className="cloud-display-properties" aria-label="Properties">
            <h3>Properties</h3>
            <div>
              {issueDisplayProperties.map((property) => (
                <button
                  key={property.id}
                  type="button"
                  aria-pressed={display.shows(property.id)}
                  onClick={() => display.toggle(property.id)}
                >
                  {property.label}
                </button>
              ))}
            </div>
          </section>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
