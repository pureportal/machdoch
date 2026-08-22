import type { JSX } from "react";

import type {
  RalphUtilityCondition,
  RalphUtilityConditionStyle,
} from "../../../../core/ralph.js";
import { Input } from "../../components/ui/input";
import { Textarea } from "../../components/ui/textarea";
import { cn } from "../../lib/utils";
import { RalphInspectorField } from "./ralph-inspector-primitives";

interface RalphUtilityConditionFieldsProps {
  condition: RalphUtilityCondition | undefined;
  inspectorTwoColumnClass: string;
  onChange: (condition: RalphUtilityCondition) => void;
}

const DEFAULT_UTILITY_CONDITION: RalphUtilityCondition = {
  style: "simple",
  expression: "status == 200",
};

const JSON_PATH_OPERATORS: NonNullable<
  RalphUtilityCondition["operator"]
>[] = [
  "exists",
  "not-exists",
  "truthy",
  "falsy",
  "equals",
  "not-equals",
  "contains",
  "matches",
  "gt",
  "gte",
  "lt",
  "lte",
];

export const RalphUtilityConditionFields = ({
  condition,
  inspectorTwoColumnClass,
  onChange,
}: RalphUtilityConditionFieldsProps): JSX.Element => {
  const currentCondition = condition ?? DEFAULT_UTILITY_CONDITION;

  const updateCondition = (patch: Partial<RalphUtilityCondition>): void => {
    onChange({
      ...currentCondition,
      ...patch,
    });
  };

  return (
    <div className="grid gap-2 rounded-md border border-slate-800 bg-slate-950 p-2">
      <div className={cn("grid gap-2", inspectorTwoColumnClass)}>
        <label className="grid gap-1.5 text-xs text-slate-300">
          <span className="font-medium">Condition</span>
          <select
            value={currentCondition.style}
            aria-label="Utility condition style"
            onChange={(event) =>
              updateCondition({
                style: event.target.value as RalphUtilityConditionStyle,
              })
            }
            className="h-8 rounded-md border border-slate-700 bg-slate-950 px-2 text-xs text-slate-100"
          >
            <option value="simple">Simple</option>
            <option value="json-path">JSON Path</option>
            <option value="javascript">JavaScript</option>
          </select>
        </label>
        {currentCondition.style === "json-path" ? (
          <label className="grid gap-1.5 text-xs text-slate-300">
            <span className="font-medium">Operator</span>
            <select
              value={currentCondition.operator ?? "truthy"}
              aria-label="Utility condition operator"
              onChange={(event) =>
                updateCondition({
                  operator: event.target
                    .value as RalphUtilityCondition["operator"],
                })
              }
              className="h-8 rounded-md border border-slate-700 bg-slate-950 px-2 text-xs text-slate-100"
            >
              {JSON_PATH_OPERATORS.map((operator) => (
                <option key={operator} value={operator}>
                  {operator}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>

      {currentCondition.style === "json-path" ? (
        <div className={cn("grid gap-2", inspectorTwoColumnClass)}>
          <RalphInspectorField
            label="JSON path"
            help="Result field to inspect."
            className="text-xs text-slate-300"
          >
            <Input
              value={currentCondition.path ?? ""}
              aria-label="Utility condition path"
              placeholder="body.state"
              onChange={(event) => updateCondition({ path: event.target.value })}
              className="h-8 border-slate-700 bg-slate-950 font-mono text-xs text-slate-100"
            />
          </RalphInspectorField>
          <RalphInspectorField
            label="Expected value"
            help="Used by equals, contains, matches, or range checks."
            className="text-xs text-slate-300"
          >
            <Input
              value={currentCondition.value ?? ""}
              aria-label="Utility condition value"
              placeholder="done"
              onChange={(event) => updateCondition({ value: event.target.value })}
              className="h-8 border-slate-700 bg-slate-950 font-mono text-xs text-slate-100"
            />
          </RalphInspectorField>
        </div>
      ) : (
        <RalphInspectorField
          label={
            currentCondition.style === "javascript"
              ? "JavaScript expression"
              : "Condition expression"
          }
          help={
            currentCondition.style === "javascript"
              ? "Evaluated against the utility result object."
              : "Simple status/body check expression."
          }
          className="text-xs text-slate-300"
        >
          <Textarea
            value={currentCondition.expression ?? ""}
            aria-label="Utility condition expression"
            placeholder={
              currentCondition.style === "javascript"
                ? "result.status === 200 && result.body.state === 'done'"
                : "status == 200"
            }
            onChange={(event) =>
              updateCondition({ expression: event.target.value })
            }
            className="min-h-20 border-slate-700 bg-slate-950 font-mono text-xs leading-5 text-slate-100 placeholder:text-slate-600"
          />
        </RalphInspectorField>
      )}
    </div>
  );
};
