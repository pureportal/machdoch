import { z } from "zod";
import { cloudId, issuePriorities } from "./cloud-contract";
import { pullRequestStages } from "./git-automation";
import { slaStates } from "./issue-sla";

export const issueFilterFields = [
  "status",
  "assignee",
  "creator",
  "priority",
  "label",
  "project",
  "cycle",
  "estimate",
  "due",
  "created",
  "updated",
  "pullRequest",
  "team",
  "milestone",
  "initiative",
  "delegate",
  "blocked",
  "blocking",
  "hasParent",
  "hasSubIssues",
  "duplicate",
  "automated",
  "releasedIn",
  "sla",
] as const;
export type IssueFilterField = (typeof issueFilterFields)[number];

export const issueFilterOperators = [
  "all",
  "empty",
  "before",
  "after",
  "within",
] as const;
export type IssueFilterOperator = (typeof issueFilterOperators)[number];

export const noneFilterValue = "none";
export const meFilterValue = "me";
export const aiFilterValue = "ai";
export const flagFilterValue = "yes";
export const dueFilterValues = ["overdue", "week", "month", "none"] as const;
export const createdFilterValues = ["day", "week", "month"] as const;
export const estimateFilterValues = ["none", "set"] as const;
export const relativeCycleValues = ["current", "upcoming", "previous"] as const;
export const issueFilterParameter = "filter";
const negatedSuffix = ".not" as const;
const maximumValues = 50;
const maximumTerms = 40;
const maximumWithinDays = 3650;
const reservedCharacters = /[,;|()!:]/;

const flag = z.literal(flagFilterValue);
const optionalReference = z.union([cloudId, z.literal(noneFilterValue)]);
const valueSchemas: Record<IssueFilterField, z.ZodType<string>> = {
  status: cloudId,
  assignee: z.union([
    cloudId,
    z.enum([meFilterValue, noneFilterValue, aiFilterValue]),
  ]),
  creator: z.union([cloudId, z.literal(meFilterValue)]),
  priority: z.enum(issuePriorities),
  label: optionalReference,
  project: optionalReference,
  cycle: z.union([cloudId, z.enum([noneFilterValue, ...relativeCycleValues])]),
  estimate: z.union([
    z.enum(estimateFilterValues),
    z
      .string()
      .trim()
      .min(1)
      .max(16)
      .refine((value) => !reservedCharacters.test(value)),
  ]),
  due: z.enum(dueFilterValues),
  created: z.enum(createdFilterValues),
  updated: z.enum(createdFilterValues),
  pullRequest: z.enum([...pullRequestStages, noneFilterValue]),
  team: cloudId,
  milestone: optionalReference,
  initiative: optionalReference,
  delegate: z.union([
    cloudId,
    z.enum([meFilterValue, noneFilterValue, aiFilterValue]),
  ]),
  blocked: flag,
  blocking: flag,
  hasParent: flag,
  hasSubIssues: flag,
  duplicate: flag,
  automated: flag,
  releasedIn: optionalReference,
  sla: z.enum(slaStates),
};

const dateFields: readonly IssueFilterField[] = ["due", "created", "updated"];
const operatorValueSchemas = {
  before: z.iso.date(),
  after: z.iso.date(),
  within: z
    .string()
    .regex(/^\d{1,4}$/)
    .refine((value) => {
      const days = Number(value);
      return days >= 1 && days <= maximumWithinDays;
    }),
} satisfies Partial<Record<IssueFilterOperator, z.ZodType<string>>>;

export function issueFilterOperatorsFor(
  field: IssueFilterField,
): IssueFilterOperator[] {
  return issueFilterOperators.filter((operator) => {
    if (operator === "all") return field === "label";
    if (operator === "empty")
      return valueSchemas[field].safeParse(noneFilterValue).success;
    return dateFields.includes(field);
  });
}

export function issueFilterProblems(condition: {
  field: IssueFilterField;
  operator?: IssueFilterOperator;
  values: string[];
}): string[] {
  const { field, operator, values } = condition;
  if (operator && !issueFilterOperatorsFor(field).includes(operator))
    return [`${field} filters cannot use "${operator}".`];
  if (operator === "empty")
    return values.length ? ["An empty filter takes no values."] : [];
  if (operator === "before" || operator === "after" || operator === "within")
    return values.length === 1 &&
      operatorValueSchemas[operator].safeParse(values[0]).success
      ? []
      : [`Use one valid ${operator === "within" ? "day count" : "date"}.`];
  if (!values.length) return ["Choose at least one value."];
  const problems: string[] = [];
  if (new Set(values).size !== values.length)
    problems.push("Choose each value once.");
  for (const value of values)
    if (!valueSchemas[field].safeParse(value).success)
      problems.push(`"${value}" is not a valid ${field} filter.`);
  return problems;
}

export const issueFilterConditionSchema = z
  .strictObject({
    field: z.enum(issueFilterFields),
    negated: z.boolean(),
    operator: z.enum(issueFilterOperators).optional(),
    values: z.array(z.string()).max(maximumValues),
  })
  .superRefine((condition, context) => {
    for (const message of issueFilterProblems(condition))
      context.addIssue({ code: "custom", path: ["values"], message });
  });
export type IssueFilterCondition = z.infer<typeof issueFilterConditionSchema>;

export const issueFilterGroupSchema = z
  .array(issueFilterConditionSchema)
  .min(2)
  .max(10);

export interface IssueFilterTree {
  conditions: IssueFilterCondition[];
  groups: IssueFilterCondition[][];
}

export type IssueFilterKey =
  | IssueFilterField
  | `${IssueFilterField}.not`
  | typeof issueFilterParameter;

function legacyKey(field: IssueFilterField, negated: boolean): IssueFilterKey {
  return negated ? `${field}${negatedSuffix}` : field;
}

export const issueFilterKeys: [IssueFilterKey, ...IssueFilterKey[]] = [
  issueFilterParameter,
  ...issueFilterFields.flatMap((field) => [
    legacyKey(field, false),
    legacyKey(field, true),
  ]),
];

function encodeCondition(condition: IssueFilterCondition): string {
  const head = `${condition.negated ? "!" : ""}${condition.field}${condition.operator ? `.${condition.operator}` : ""}`;
  return condition.values.length
    ? `${head}:${condition.values.join(",")}`
    : head;
}

export function encodeIssueFilter(tree: IssueFilterTree): string {
  return [
    ...tree.conditions.map(encodeCondition),
    ...tree.groups.map((group) => `(${group.map(encodeCondition).join("|")})`),
  ].join(";");
}

function decodeCondition(term: string): IssueFilterCondition | null {
  const match = /^(!?)([A-Za-z]+)(?:\.([a-z]+))?(?::(.*))?$/.exec(term.trim());
  if (!match) return null;
  const parsed = issueFilterConditionSchema.safeParse({
    field: match[2],
    negated: match[1] === "!",
    ...(match[3] ? { operator: match[3] } : {}),
    values: match[4]
      ? match[4]
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean)
      : [],
  });
  return parsed.success ? parsed.data : null;
}

export function decodeIssueFilter(raw: string): IssueFilterTree {
  const tree: IssueFilterTree = { conditions: [], groups: [] };
  for (const term of raw.split(";").slice(0, maximumTerms)) {
    const trimmed = term.trim();
    if (!trimmed.startsWith("(") || !trimmed.endsWith(")")) {
      const condition = decodeCondition(trimmed);
      if (condition) tree.conditions.push(condition);
      continue;
    }
    const group = trimmed
      .slice(1, -1)
      .split("|")
      .map(decodeCondition)
      .filter((condition) => condition !== null);
    if (group.length > 1) tree.groups.push(group.slice(0, 10));
    else if (group.length === 1) tree.conditions.push(group[0]!);
  }
  return tree;
}

function legacyConditions(
  params: Record<string, string | string[] | undefined>,
): IssueFilterCondition[] {
  const conditions: IssueFilterCondition[] = [];
  for (const field of issueFilterFields)
    for (const negated of [false, true]) {
      const raw = params[legacyKey(field, negated)];
      if (typeof raw !== "string") continue;
      const values = [
        ...new Set(
          raw
            .split(",")
            .map((value) => value.trim())
            .filter((value) => valueSchemas[field].safeParse(value).success),
        ),
      ].slice(0, maximumValues);
      if (values.length) conditions.push({ field, negated, values });
    }
  return conditions;
}

export function parseIssueFilterTree(
  params: Record<string, string | string[] | undefined>,
): IssueFilterTree {
  const raw = params[issueFilterParameter];
  const encoded =
    typeof raw === "string"
      ? decodeIssueFilter(raw)
      : { conditions: [], groups: [] };
  return {
    conditions: [...legacyConditions(params), ...encoded.conditions],
    groups: encoded.groups,
  };
}

export function withIssueFilterTree(
  search: URLSearchParams,
  tree: IssueFilterTree,
): URLSearchParams {
  const next = new URLSearchParams(search);
  for (const key of issueFilterKeys) next.delete(key);
  const encoded = encodeIssueFilter(tree);
  if (encoded) next.set(issueFilterParameter, encoded);
  return next;
}
