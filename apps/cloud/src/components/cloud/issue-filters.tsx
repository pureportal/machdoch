"use client";

import { ListFilter, Users, X } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import type { CloudTeam, CloudWorkspace } from "@/lib/cloud-contract";
import {
  parseIssueFilterConditions,
  withIssueFilterCondition,
  type IssueFilterCondition,
  type IssueFilterField,
} from "@/lib/issue-filter-model";
import { FilterMenu, type FilterMenuField } from "./filter-menu";
import {
  conditionOperator,
  conditionValues,
  type FilterFieldDefinition,
} from "./issue-filter-fields";

const teamKey = "teamId";

export function useIssueFilterState(
  search: URLSearchParams,
  definitions: FilterFieldDefinition[],
  teams: CloudTeam[],
  navigate: (next: URLSearchParams) => void,
) {
  const conditions = parseIssueFilterConditions(Object.fromEntries(search));
  const teamId = search.get(teamKey);
  const condition = (field: IssueFilterField) =>
    conditions.find((entry) => entry.field === field) ?? null;
  const setCondition = (
    field: IssueFilterField,
    next: { negated: boolean; values: string[] } | null,
  ) => navigate(withIssueFilterCondition(search, field, next));
  const fields: FilterMenuField[] = [
    ...(teams.length > 1
      ? [
          {
            key: teamKey,
            label: "Team",
            icon: Users,
            multiple: false,
            options: teams.map((team) => ({
              value: team.id,
              label: team.name,
            })),
          },
        ]
      : []),
    ...definitions.map((definition) => ({
      key: definition.field,
      label: definition.label,
      icon: definition.icon,
      options: definition.options,
      multiple: true,
    })),
  ];
  const selected = (key: string) =>
    key === teamKey
      ? teamId
        ? [teamId]
        : []
      : (condition(key as IssueFilterField)?.values ?? []);
  const toggle = (key: string, value: string) => {
    if (key === teamKey) {
      let next = new URLSearchParams(search);
      for (const field of ["status", "label", "project", "cycle"] as const)
        next = withIssueFilterCondition(next, field, null);
      if (value === teamId) next.delete(teamKey);
      else next.set(teamKey, value);
      navigate(next);
      return;
    }
    const field = key as IssueFilterField;
    const current = condition(field);
    const values = current?.values ?? [];
    const nextValues = values.includes(value)
      ? values.filter((entry) => entry !== value)
      : [...values, value];
    setCondition(
      field,
      nextValues.length
        ? { negated: current?.negated ?? false, values: nextValues }
        : null,
    );
  };
  return { conditions, teamId, fields, selected, toggle, setCondition };
}

export function IssueFilterButton({
  fields,
  selected,
  onToggle,
}: {
  fields: FilterMenuField[];
  selected: (key: string) => string[];
  onToggle: (key: string, value: string) => void;
}) {
  return (
    <FilterMenu
      fields={fields}
      selected={selected}
      onToggle={onToggle}
      shortcut
    >
      <Button
        variant="ghost"
        size="sm"
        className="cloud-filter-button"
        aria-keyshortcuts="F"
      >
        <ListFilter />
        Filter
      </Button>
    </FilterMenu>
  );
}

function FilterChip({
  condition,
  definition,
  menuField,
  selected,
  onToggle,
  onChange,
}: {
  condition: IssueFilterCondition;
  definition: FilterFieldDefinition | undefined;
  menuField: FilterMenuField | undefined;
  selected: (key: string) => string[];
  onToggle: (key: string, value: string) => void;
  onChange: (next: { negated: boolean; values: string[] } | null) => void;
}) {
  const Icon = definition?.icon;
  return (
    <span className="cloud-filter-chip">
      <span className="cloud-filter-chip-field">
        {Icon && <Icon size={12} aria-hidden="true" />}
        {definition?.label ?? condition.field}
      </span>
      <button
        type="button"
        className="cloud-filter-chip-operator"
        aria-label={`${definition?.label ?? condition.field}: ${conditionOperator(condition)}. Switch operator`}
        onClick={() =>
          onChange({ negated: !condition.negated, values: condition.values })
        }
      >
        {conditionOperator(condition)}
      </button>
      {menuField ? (
        <FilterMenu
          fields={[menuField]}
          selected={selected}
          onToggle={onToggle}
          initialKey={menuField.key}
        >
          <button type="button" className="cloud-filter-chip-value">
            {conditionValues(condition, definition)}
          </button>
        </FilterMenu>
      ) : (
        <span className="cloud-filter-chip-value">
          {conditionValues(condition, definition)}
        </span>
      )}
      <button
        type="button"
        aria-label={`Remove ${(definition?.label ?? condition.field).toLowerCase()} filter`}
        onClick={() => onChange(null)}
      >
        <X size={12} />
      </button>
    </span>
  );
}

export function IssueFilterChips({
  state,
  definitions,
  workspace,
  onClear,
  children,
}: {
  state: ReturnType<typeof useIssueFilterState>;
  definitions: FilterFieldDefinition[];
  workspace: CloudWorkspace;
  onClear: () => void;
  children?: ReactNode;
}) {
  const team = workspace.teams.find((entry) => entry.id === state.teamId);
  return (
    <div className="cloud-filter-bar">
      {team && workspace.teams.length > 1 && (
        <span className="cloud-filter-chip">
          <span className="cloud-filter-chip-field">
            <Users size={12} aria-hidden="true" />
            Team
          </span>
          <span className="cloud-filter-chip-operator">is</span>
          <span className="cloud-filter-chip-value">{team.name}</span>
          <button
            type="button"
            aria-label="Remove team filter"
            onClick={() => state.toggle(teamKey, team.id)}
          >
            <X size={12} />
          </button>
        </span>
      )}
      {state.conditions.map((condition) => (
        <FilterChip
          key={`${condition.field}:${condition.negated}`}
          condition={condition}
          definition={definitions.find(
            (entry) => entry.field === condition.field,
          )}
          menuField={state.fields.find(
            (entry) => entry.key === condition.field,
          )}
          selected={state.selected}
          onToggle={state.toggle}
          onChange={(next) => state.setCondition(condition.field, next)}
        />
      ))}
      <Button variant="ghost" size="sm" onClick={onClear}>
        Clear
      </Button>
      <span className="cloud-filter-spacer" />
      {children}
    </div>
  );
}
