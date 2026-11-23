import {
  issueFilterOperatorsFor,
  type IssueFilterCondition,
  type IssueFilterField,
  type IssueFilterOperator,
  type IssueFilterTree,
} from "./issue-filter-model";

export interface IssueFilterOperatorChoice {
  negated: boolean;
  operator?: IssueFilterOperator;
}

const flagFields: readonly IssueFilterField[] = [
  "blocked",
  "blocking",
  "hasParent",
  "hasSubIssues",
  "duplicate",
  "automated",
];

export function isFlagFilterField(field: IssueFilterField): boolean {
  return flagFields.includes(field);
}

export function issueFilterOperatorChoices(
  field: IssueFilterField,
): IssueFilterOperatorChoice[] {
  const operators = issueFilterOperatorsFor(field);
  return [
    { negated: false },
    ...(operators.includes("all")
      ? [{ negated: false, operator: "all" as const }]
      : []),
    { negated: true },
    ...(operators.includes("empty")
      ? [
          { negated: false, operator: "empty" as const },
          { negated: true, operator: "empty" as const },
        ]
      : []),
    ...(["before", "after", "within"] as const)
      .filter((operator) => operators.includes(operator))
      .map((operator) => ({ negated: false, operator })),
  ];
}

export function sameOperatorChoice(
  condition: IssueFilterCondition,
  choice: IssueFilterOperatorChoice,
): boolean {
  return (
    condition.negated === choice.negated &&
    condition.operator === choice.operator
  );
}

function takesValueList(operator: IssueFilterOperator | undefined): boolean {
  return operator === undefined || operator === "all";
}

export function withIssueFilterOperator(
  condition: IssueFilterCondition,
  choice: IssueFilterOperatorChoice,
  today: string,
  firstOption: string | undefined,
): IssueFilterCondition | null {
  const next = { field: condition.field, negated: choice.negated };
  if (choice.operator === "empty")
    return { ...next, operator: "empty", values: [] };
  if (choice.operator === "before" || choice.operator === "after")
    return {
      ...next,
      operator: choice.operator,
      values: [
        condition.operator === "before" || condition.operator === "after"
          ? condition.values[0]!
          : today,
      ],
    };
  if (choice.operator === "within") return { ...next, operator: "within", values: ["7"] };
  const values = takesValueList(condition.operator)
    ? condition.values
    : firstOption
      ? [firstOption]
      : [];
  if (!values.length) return null;
  return choice.operator
    ? { ...next, operator: choice.operator, values }
    : { ...next, values };
}

export function primaryIssueFilterIndex(
  tree: IssueFilterTree,
  field: IssueFilterField,
): number {
  return tree.conditions.findIndex(
    (condition) =>
      condition.field === field &&
      !condition.negated &&
      takesValueList(condition.operator),
  );
}

export function replaceIssueFilterCondition(
  tree: IssueFilterTree,
  index: number,
  next: IssueFilterCondition | null,
): IssueFilterTree {
  return {
    groups: tree.groups,
    conditions: next
      ? tree.conditions.map((condition, position) =>
          position === index ? next : condition,
        )
      : tree.conditions.filter((_, position) => position !== index),
  };
}

export function toggleIssueFilterValue(
  tree: IssueFilterTree,
  field: IssueFilterField,
  value: string,
): IssueFilterTree {
  const index = primaryIssueFilterIndex(tree, field);
  if (index < 0)
    return {
      groups: tree.groups,
      conditions: [...tree.conditions, { field, negated: false, values: [value] }],
    };
  const current = tree.conditions[index]!;
  const values = current.values.includes(value)
    ? current.values.filter((entry) => entry !== value)
    : [...current.values, value];
  return replaceIssueFilterCondition(
    tree,
    index,
    values.length ? { ...current, values } : null,
  );
}

export function removeIssueFilterGroup(
  tree: IssueFilterTree,
  index: number,
): IssueFilterTree {
  return {
    conditions: tree.conditions,
    groups: tree.groups.filter((_, position) => position !== index),
  };
}

export function withoutIssueFilterFields(
  tree: IssueFilterTree,
  fields: readonly IssueFilterField[],
): IssueFilterTree {
  const kept = (condition: IssueFilterCondition) =>
    !fields.includes(condition.field);
  const groups = tree.groups.map((group) => group.filter(kept));
  return {
    conditions: [
      ...tree.conditions.filter(kept),
      ...groups.filter((group) => group.length === 1).flat(),
    ],
    groups: groups.filter((group) => group.length > 1),
  };
}
