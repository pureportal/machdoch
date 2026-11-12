"use client";

import { Columns3, LayoutList, SlidersHorizontal } from "lucide-react";
import { Popover } from "radix-ui";
import { Button } from "@/components/ui/button";
import { issueDisplayProperties } from "@/lib/issue-display";
import { parseIssueSort } from "@/lib/issue-scopes";
import { issueSortLabels } from "@/lib/issue-sorting";
import { issueGroupings } from "./issue-grouping";
import { useIssueDisplay } from "./use-issue-display";

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
  const board = search.get("view") === "board";
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
          {layout && (
            <div
              className="cloud-display-layout"
              role="group"
              aria-label="Layout"
            >
              <button
                type="button"
                aria-pressed={!board}
                onClick={() => setFilter("view", "")}
              >
                <LayoutList size={15} aria-hidden="true" />
                List
              </button>
              <button
                type="button"
                aria-pressed={board}
                onClick={() => setFilter("view", "board")}
              >
                <Columns3 size={15} aria-hidden="true" />
                Board
              </button>
            </div>
          )}
          <label className="cloud-display-row">
            <span>Grouping</span>
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
                .filter(([value]) => !board || value !== "none")
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
            <span>Reverse order</span>
            <input
              type="checkbox"
              role="switch"
              checked={search.get("order") === "reverse"}
              onChange={(event) =>
                setFilter("order", event.target.checked ? "reverse" : "")
              }
            />
          </label>
          {archived && (
            <label className="cloud-display-row">
              <span>Archived issues</span>
              <input
                type="checkbox"
                role="switch"
                checked={search.get("archived") === "true"}
                onChange={(event) =>
                  setFilter("archived", event.target.checked ? "true" : "")
                }
              />
            </label>
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
