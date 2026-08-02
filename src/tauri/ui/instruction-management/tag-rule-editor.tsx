import { Brackets, Plus, Trash2 } from "lucide-react";
import type { JSX } from "react";
import type { InstructionTagRule } from "../../../core/instruction-system/types.js";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { cn } from "../lib/utils";

export const createEmptyTagGroup = (): InstructionTagRule => ({
  op: "and",
  rules: [{ op: "tag", tag: "" }],
});

export const isCompleteTagRule = (rule: InstructionTagRule): boolean =>
  rule.op === "tag"
    ? rule.tag.trim().length > 0
    : rule.rules.length > 0 && rule.rules.every(isCompleteTagRule);

const RuleNode = ({
  rule,
  depth,
  disabled,
  removable,
  onChange,
  onRemove,
}: {
  rule: InstructionTagRule;
  depth: number;
  disabled: boolean;
  removable: boolean;
  onChange: (rule: InstructionTagRule) => void;
  onRemove: () => void;
}): JSX.Element => {
  if (rule.op === "tag") {
    return (
      <div className="flex min-w-0 items-center gap-2">
        <Input
          value={rule.tag}
          disabled={disabled}
          aria-label="Matching workspace tag"
          placeholder="Workspace tag"
          onChange={(event) => onChange({ op: "tag", tag: event.target.value })}
          className="h-9 min-w-0 border-slate-800 bg-slate-950"
        />
        {removable ? (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            disabled={disabled}
            aria-label="Remove rule"
            onClick={onRemove}
          >
            <Trash2 className="size-3.5" />
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "space-y-2 rounded-lg border border-slate-800 bg-slate-950/45 p-3",
        depth > 0 && "ml-3 border-l-sky-900/60",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-md border border-slate-800 bg-slate-950 p-0.5">
          {(["and", "or"] as const).map((op) => (
            <button
              key={op}
              type="button"
              disabled={disabled}
              aria-pressed={rule.op === op}
              onClick={() => onChange({ ...rule, op })}
              className={cn(
                "rounded px-2 py-1 text-[11px] font-semibold uppercase",
                rule.op === op
                  ? "bg-sky-500/15 text-sky-200"
                  : "text-slate-500 hover:text-slate-200",
              )}
            >
              {op}
            </button>
          ))}
        </div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={disabled}
          onClick={() =>
            onChange({
              ...rule,
              rules: [...rule.rules, { op: "tag", tag: "" }],
            })
          }
        >
          <Plus className="size-3.5" />
          Tag
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={disabled || depth >= 6}
          onClick={() =>
            onChange({ ...rule, rules: [...rule.rules, createEmptyTagGroup()] })
          }
        >
          <Brackets className="size-3.5" />
          Group
        </Button>
        {removable ? (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            disabled={disabled}
            aria-label="Remove group"
            className="ml-auto"
            onClick={onRemove}
          >
            <Trash2 className="size-3.5" />
          </Button>
        ) : null}
      </div>
      <div className="space-y-2">
        {rule.rules.map((child, index) => (
          <RuleNode
            key={`${index}:${child.op}`}
            rule={child}
            depth={depth + 1}
            disabled={disabled}
            removable={rule.rules.length > 1}
            onChange={(next) =>
              onChange({
                ...rule,
                rules: rule.rules.map((candidate, childIndex) =>
                  childIndex === index ? next : candidate,
                ),
              })
            }
            onRemove={() =>
              onChange({
                ...rule,
                rules: rule.rules.filter(
                  (_, childIndex) => childIndex !== index,
                ),
              })
            }
          />
        ))}
      </div>
    </div>
  );
};

export const TagRuleEditor = ({
  value,
  disabled = false,
  onChange,
}: {
  value: InstructionTagRule;
  disabled?: boolean;
  onChange: (rule: InstructionTagRule) => void;
}): JSX.Element => (
  <RuleNode
    rule={value}
    depth={0}
    disabled={disabled}
    removable={false}
    onChange={onChange}
    onRemove={() => undefined}
  />
);
