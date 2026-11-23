"use client";

import { ListFilter, Users, X } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import type { CloudTeam, CloudWorkspace } from "@/lib/cloud-contract";
import {
  issueFilterOperatorChoices,
  primaryIssueFilterIndex,
  removeIssueFilterGroup,
  replaceIssueFilterCondition,
  sameOperatorChoice,
  toggleIssueFilterValue,
  withIssueFilterOperator,
  withoutIssueFilterFields,
} from "@/lib/issue-filter-editing";
import {
  parseIssueFilterTree,
  withIssueFilterTree,
  type IssueFilterCondition,
  type IssueFilterField,
  type IssueFilterTree,
} from "@/lib/issue-filter-model";
import { FilterMenu, type FilterMenuField } from "./filter-menu";
import {
  conditionValues,
  describeCondition,
  operatorLabel,
  type FilterFieldDefinition,
} from "./issue-filter-fields";

const teamKey = "teamId";
const teamScopedFields: readonly IssueFilterField[] = [
  "status",
  "label",
  "project",
  "cycle",
];

export interface IssueFilterState {
  tree: IssueFilterTree;
  teamId: string | null;
  fields: FilterMenuField[];
  selected: (key: string) => string[];
  toggle: (key: string, value: string) => void;
  change: (tree: IssueFilterTree) => void;
}

function menuFields(definitions: FilterFieldDefinition[]): FilterMenuField[] {
  return definitions
    .filter((definition) => definition.field !== "team")
    .map((definition) => ({
      key: definition.field,
      label: definition.label,
      icon: definition.icon,
      options: definition.options,
      multiple: true,
    }));
}

export function useFilterTreeState(
  tree: IssueFilterTree,
  change: (tree: IssueFilterTree) => void,
  definitions: FilterFieldDefinition[],
): IssueFilterState {
  return {
    tree,
    teamId: null,
    fields: menuFields(definitions),
    selected: (key) =>
      tree.conditions[primaryIssueFilterIndex(tree, key as IssueFilterField)]
        ?.values ?? [],
    toggle: (key, value) =>
      change(toggleIssueFilterValue(tree, key as IssueFilterField, value)),
    change,
  };
}

export function useIssueFilterState(
  search: URLSearchParams,
  definitions: FilterFieldDefinition[],
  teams: CloudTeam[],
  navigate: (next: URLSearchParams) => void,
): IssueFilterState {
  const tree = parseIssueFilterTree(Object.fromEntries(search));
  const teamId = search.get(teamKey);
  const state = useFilterTreeState(
    tree,
    (next) => navigate(withIssueFilterTree(search, next)),
    definitions,
  );
  return {
    ...state,
    teamId,
    fields: [
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
      ...state.fields,
    ],
    selected: (key) =>
      key === teamKey ? (teamId ? [teamId] : []) : state.selected(key),
    toggle: (key, value) => {
      if (key !== teamKey) return state.toggle(key, value);
      const next = withIssueFilterTree(
        search,
        withoutIssueFilterFields(tree, teamScopedFields),
      );
      if (value === teamId) next.delete(teamKey);
      else next.set(teamKey, value);
      navigate(next);
    },
  };
}

export function hasIssueFilters(state: IssueFilterState): boolean {
  return state.tree.conditions.length > 0 || state.tree.groups.length > 0;
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

function ConditionValue({
  condition,
  definition,
  menuField,
  onChange,
}: {
  condition: IssueFilterCondition;
  definition: FilterFieldDefinition | undefined;
  menuField: FilterMenuField | undefined;
  onChange: (next: IssueFilterCondition | null) => void;
}) {
  const label = definition?.label ?? condition.field;
  if (condition.operator === "before" || condition.operator === "after")
    return (
      <input
        type="date"
        className="cloud-filter-chip-value"
        aria-label={`${label} date`}
        value={condition.values[0] ?? ""}
        onChange={(event) =>
          event.target.value &&
          onChange({ ...condition, values: [event.target.value] })
        }
      />
    );
  if (condition.operator === "within")
    return (
      <input
        type="number"
        min={1}
        max={3650}
        className="cloud-filter-chip-value cloud-filter-chip-days"
        aria-label={`${label} days`}
        value={condition.values[0] ?? ""}
        onChange={(event) => {
          const days = Number(event.target.value);
          if (Number.isInteger(days) && days >= 1 && days <= 3650)
            onChange({ ...condition, values: [String(days)] });
        }}
      />
    );
  const text = conditionValues(condition, definition);
  if (!text) return null;
  if (!menuField) return <span className="cloud-filter-chip-value">{text}</span>;
  return (
    <FilterMenu
      fields={[menuField]}
      selected={() => condition.values}
      onToggle={(_, value) => {
        const values = condition.values.includes(value)
          ? condition.values.filter((entry) => entry !== value)
          : [...condition.values, value];
        onChange(values.length ? { ...condition, values } : null);
      }}
      initialKey={menuField.key}
    >
      <button type="button" className="cloud-filter-chip-value">
        {text}
      </button>
    </FilterMenu>
  );
}

function FilterChip({
  condition,
  definition,
  menuField,
  onChange,
}: {
  condition: IssueFilterCondition;
  definition: FilterFieldDefinition | undefined;
  menuField: FilterMenuField | undefined;
  onChange: (next: IssueFilterCondition | null) => void;
}) {
  const Icon = definition?.icon;
  const label = definition?.label ?? condition.field;
  const choices = issueFilterOperatorChoices(condition.field);
  const multiple = condition.values.length > 1;
  return (
    <span className="cloud-filter-chip">
      <span className="cloud-filter-chip-field">
        {Icon && <Icon size={12} aria-hidden="true" />}
        {label}
      </span>
      <select
        className="cloud-filter-chip-operator"
        aria-label={`${label} operator`}
        value={choices.findIndex((choice) =>
          sameOperatorChoice(condition, choice),
        )}
        onChange={(event) =>
          onChange(
            withIssueFilterOperator(
              condition,
              choices[Number(event.target.value)]!,
              new Date().toISOString().slice(0, 10),
              definition?.options[0]?.value,
            ),
          )
        }
      >
        {choices.map((choice, index) => (
          <option key={index} value={index}>
            {operatorLabel(condition.field, choice, multiple)}
          </option>
        ))}
      </select>
      <ConditionValue
        condition={condition}
        definition={definition}
        menuField={menuField}
        onChange={onChange}
      />
      <button
        type="button"
        aria-label={`Remove ${label.toLowerCase()} filter`}
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
  state: IssueFilterState;
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
      {state.tree.conditions.map((condition, index) => (
        <FilterChip
          key={`${index}:${condition.field}`}
          condition={condition}
          definition={definitions.find(
            (entry) => entry.field === condition.field,
          )}
          menuField={state.fields.find(
            (entry) => entry.key === condition.field,
          )}
          onChange={(next) =>
            state.change(replaceIssueFilterCondition(state.tree, index, next))
          }
        />
      ))}
      {state.tree.groups.map((group, index) => (
        <span key={`group:${index}`} className="cloud-filter-chip">
          <span className="cloud-filter-chip-value">
            {group
              .map((condition) => describeCondition(condition, definitions))
              .join(" or ")}
          </span>
          <button
            type="button"
            aria-label="Remove filter group"
            onClick={() =>
              state.change(removeIssueFilterGroup(state.tree, index))
            }
          >
            <X size={12} />
          </button>
        </span>
      ))}
      <Button variant="ghost" size="sm" onClick={onClear}>
        Clear
      </Button>
      <span className="cloud-filter-spacer" />
      {children}
    </div>
  );
}
