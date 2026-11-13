import { z } from "zod";
import { cloudId, issuePriorities } from "./cloud-contract";
import { pullRequestStages } from "./git-automation";

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
] as const;
export type IssueFilterField = (typeof issueFilterFields)[number];

export const noneFilterValue = "none";
export const meFilterValue = "me";
export const dueFilterValues = ["overdue", "week", "month", "none"] as const;
export const createdFilterValues = ["day", "week", "month"] as const;
export const estimateFilterValues = ["none", "set"] as const;
const negatedSuffix = ".not" as const;
const maximumValues = 50;

const valueSchemas: Record<IssueFilterField, z.ZodType<string>> = {
  status: cloudId,
  assignee: z.union([cloudId, z.enum([meFilterValue, noneFilterValue])]),
  creator: z.union([cloudId, z.literal(meFilterValue)]),
  priority: z.enum(issuePriorities),
  label: z.union([cloudId, z.literal(noneFilterValue)]),
  project: z.union([cloudId, z.literal(noneFilterValue)]),
  cycle: z.union([cloudId, z.literal(noneFilterValue)]),
  estimate: z.enum(estimateFilterValues),
  due: z.enum(dueFilterValues),
  created: z.enum(createdFilterValues),
  updated: z.enum(createdFilterValues),
  pullRequest: z.enum([...pullRequestStages, noneFilterValue]),
};

export const issueFilterConditionSchema = z
  .strictObject({
    field: z.enum(issueFilterFields),
    negated: z.boolean(),
    values: z.array(z.string()).min(1).max(maximumValues),
  })
  .superRefine((condition, context) => {
    if (new Set(condition.values).size !== condition.values.length)
      context.addIssue({
        code: "custom",
        path: ["values"],
        message: "Choose each value once.",
      });
    for (const value of condition.values)
      if (!valueSchemas[condition.field].safeParse(value).success)
        context.addIssue({
          code: "custom",
          path: ["values"],
          message: `"${value}" is not a valid ${condition.field} filter.`,
        });
  });
export type IssueFilterCondition = z.infer<typeof issueFilterConditionSchema>;

export type IssueFilterKey = IssueFilterField | `${IssueFilterField}.not`;

export function issueFilterKey(
  field: IssueFilterField,
  negated: boolean,
): IssueFilterKey {
  return negated ? `${field}${negatedSuffix}` : field;
}
export const issueFilterKeys = issueFilterFields.flatMap((field) => [
  issueFilterKey(field, false),
  issueFilterKey(field, true),
]) as [IssueFilterKey, ...IssueFilterKey[]];

export function parseIssueFilterConditions(
  params: Record<string, string | string[] | undefined>,
): IssueFilterCondition[] {
  const conditions: IssueFilterCondition[] = [];
  for (const field of issueFilterFields)
    for (const negated of [false, true]) {
      const raw = params[issueFilterKey(field, negated)];
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

export function withIssueFilterCondition(
  search: URLSearchParams,
  field: IssueFilterField,
  condition: { negated: boolean; values: string[] } | null,
): URLSearchParams {
  const next = new URLSearchParams(search);
  next.delete(issueFilterKey(field, false));
  next.delete(issueFilterKey(field, true));
  if (condition?.values.length)
    next.set(
      issueFilterKey(field, condition.negated),
      condition.values.join(","),
    );
  return next;
}
