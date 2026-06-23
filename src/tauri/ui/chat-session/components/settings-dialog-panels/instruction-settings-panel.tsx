import {
  Copy,
  FileText,
  Plus,
  RefreshCw,
  Save,
  Search,
  WandSparkles,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type JSX,
} from "react";
import type {
  CustomizationDiagnostic,
  DiscoveredInstruction,
  InstructionAudience,
  InstructionMode,
  InstructionTargetAudience,
} from "../../../../../core/types.js";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { Textarea } from "../../../components/ui/textarea";
import { cn } from "../../../lib/utils";
import type {
  InstructionMutationInput,
  WritableInstructionScope,
} from "../../../runtime";
import {
  ChoiceButtons,
  SettingPanel,
  SettingsCard,
  SettingsStatus,
} from "./shared";
import type { InstructionSettingsControls } from "./types";

export interface InstructionSettingsPanelProps {
  setup: InstructionSettingsControls;
}

type InstructionEditorMode = "manual" | "ai";
type InstructionWorkflow = "idle" | "create" | "edit" | "generate" | "copy";
type InstructionAudienceDraft = "default" | InstructionAudience;
type InstructionScopeLabel =
  | WritableInstructionScope
  | "compatibility"
  | "ralph-flow";
type InstructionScopeFilter = "all" | InstructionScopeLabel;
type InstructionModeFilter =
  | "all"
  | "always"
  | "auto"
  | "agent-requested"
  | "manual"
  | "disabled"
  | "issues";

interface InstructionDraft {
  editorMode: InstructionEditorMode;
  workflow: InstructionWorkflow;
  name: string;
  path: string;
  scope: WritableInstructionScope;
  activationMode: InstructionMode;
  audience: InstructionAudienceDraft;
  applyTo: string;
  exclude: string;
  keywords: string;
  priority: string;
  prompt: string;
  maxRounds: string;
}

interface ApplicabilityDraft {
  task: string;
  path: string;
  audience: InstructionTargetAudience;
}

interface ApplicabilityMatch {
  instruction: DiscoveredInstruction;
  reason: string;
  priority: number;
}

const INPUT_CLASS =
  "h-9 rounded-lg border-slate-800 bg-slate-950 text-sm text-slate-100";
const MONO_INPUT_CLASS = `${INPUT_CLASS} font-mono`;
const TEXTAREA_CLASS =
  "min-h-24 rounded-lg border-slate-800 bg-slate-950 font-mono text-sm text-slate-100";

const INSTRUCTION_SCOPE_OPTIONS: ReadonlyArray<{
  value: WritableInstructionScope;
  label: string;
}> = [
  { value: "workspace", label: "Workspace" },
  { value: "user", label: "Global" },
];

const SCOPE_FILTER_OPTIONS: ReadonlyArray<{
  value: InstructionScopeFilter;
  label: string;
}> = [
  { value: "all", label: "All" },
  { value: "workspace", label: "Workspace" },
  { value: "user", label: "Global" },
  { value: "ralph-flow", label: "Ralph flow" },
  { value: "compatibility", label: "Read-only" },
];

const MODE_FILTER_OPTIONS: ReadonlyArray<{
  value: InstructionModeFilter;
  label: string;
}> = [
  { value: "all", label: "Any mode" },
  { value: "always", label: "Always" },
  { value: "auto", label: "Auto" },
  { value: "agent-requested", label: "Agent" },
  { value: "manual", label: "Manual" },
  { value: "disabled", label: "Off" },
  { value: "issues", label: "Issues" },
];

const INSTRUCTION_MODE_OPTIONS: ReadonlyArray<{
  value: InstructionMode;
  label: string;
}> = [
  { value: "auto", label: "Auto-matched" },
  { value: "always", label: "Always active" },
  { value: "agent-requested", label: "Agent-requested" },
  { value: "manual", label: "Manual only" },
  { value: "disabled", label: "Disabled" },
];

const INSTRUCTION_AUDIENCE_OPTIONS: ReadonlyArray<{
  value: InstructionAudienceDraft;
  label: string;
}> = [
  { value: "default", label: "Default" },
  { value: "executor", label: "Executor" },
  { value: "validator", label: "Validator" },
  { value: "generator", label: "Generator" },
  { value: "all", label: "All" },
];

const TEST_AUDIENCE_OPTIONS: ReadonlyArray<{
  value: InstructionTargetAudience;
  label: string;
}> = [
  { value: "executor", label: "Executor" },
  { value: "validator", label: "Validator" },
  { value: "generator", label: "Generator" },
];

const createEmptyDraft = (
  workspaceAvailable: boolean,
  workflow: InstructionWorkflow,
  editorMode: InstructionEditorMode,
): InstructionDraft => ({
  editorMode,
  workflow,
  name: "",
  path: "",
  scope: workspaceAvailable ? "workspace" : "user",
  activationMode: "auto",
  audience: "default",
  applyTo: "",
  exclude: "",
  keywords: "",
  priority: "",
  prompt: "",
  maxRounds: "2",
});

const getInstructionKey = (instruction: DiscoveredInstruction): string => {
  return `${instruction.scope ?? "workspace"}:${instruction.path}`;
};

const getInstructionScope = (
  instruction: DiscoveredInstruction,
): InstructionScopeLabel => {
  if (instruction.scope === "user") {
    return "user";
  }

  if (instruction.scope === "compatibility") {
    return "compatibility";
  }

  if (instruction.scope === "ralph-flow") {
    return "ralph-flow";
  }

  return "workspace";
};

const getInstructionMode = (
  instruction: DiscoveredInstruction,
): InstructionMode => {
  if (instruction.mode) {
    return instruction.mode;
  }

  return instruction.kind === "always-on" ? "always" : "auto";
};

const getApplyToPatterns = (
  instruction: DiscoveredInstruction,
): string[] => {
  if (instruction.applyToPatterns && instruction.applyToPatterns.length > 0) {
    return instruction.applyToPatterns;
  }

  return instruction.applyTo ? [instruction.applyTo] : [];
};

const formatPathDisplay = (path: string): string => {
  const normalizedPath = path.replace(/\\/gu, "/");

  return normalizedPath.length > 84
    ? `...${normalizedPath.slice(-84)}`
    : normalizedPath;
};

const formatStringList = (values: string[] | undefined): string => {
  return values && values.length > 0 ? values.join("\n") : "";
};

const parseStringList = (value: string): string[] | undefined => {
  const entries = value
    .split(/\r?\n|,/u)
    .map((entry) => entry.trim())
    .filter(Boolean);

  return entries.length > 0 ? Array.from(new Set(entries)) : undefined;
};

const parseOptionalInteger = (value: string): number | undefined => {
  const normalizedValue = value.trim();

  if (!normalizedValue) {
    return undefined;
  }

  const parsed = Number(normalizedValue);

  return Number.isFinite(parsed) ? Math.trunc(parsed) : undefined;
};

const createMutationInput = (
  draft: InstructionDraft,
): InstructionMutationInput => {
  const input: InstructionMutationInput = {
    name: draft.name.trim(),
    prompt: draft.prompt.trim(),
    scope: draft.scope,
  };
  const priority = parseOptionalInteger(draft.priority);
  const maxRounds = parseOptionalInteger(draft.maxRounds);
  const applyTo = parseStringList(draft.applyTo);
  const exclude = parseStringList(draft.exclude);
  const keywords = parseStringList(draft.keywords);

  if (draft.path.trim()) {
    input.path = draft.path.trim();
  }

  if (draft.activationMode) {
    input.mode = draft.activationMode;
  }

  if (draft.audience !== "default") {
    input.audience = draft.audience;
  }

  if (applyTo) {
    input.applyTo = applyTo;
  }

  if (exclude) {
    input.exclude = exclude;
  }

  if (keywords) {
    input.keywords = keywords;
  }

  if (priority !== undefined) {
    input.priority = priority;
  }

  if (draft.editorMode === "ai" && maxRounds !== undefined) {
    input.maxRounds = maxRounds;
  }

  return input;
};

const sortInstructions = (
  left: DiscoveredInstruction,
  right: DiscoveredInstruction,
): number => {
  const leftScope = getInstructionScope(left);
  const rightScope = getInstructionScope(right);

  if (leftScope !== rightScope) {
    return leftScope.localeCompare(rightScope);
  }

  return left.name.localeCompare(right.name);
};

const scopeLabel = (scope: InstructionScopeLabel): string => {
  switch (scope) {
    case "user":
      return "Global";
    case "compatibility":
      return "Read-only import";
    case "ralph-flow":
      return "Ralph flow";
    case "workspace":
      return "Workspace";
  }
};

const modeLabel = (mode: InstructionMode): string => {
  switch (mode) {
    case "always":
      return "Always active";
    case "auto":
      return "Auto-matched";
    case "agent-requested":
      return "Agent-requested";
    case "manual":
      return "Manual only";
    case "disabled":
      return "Disabled";
  }
};

const audienceLabel = (
  audience: InstructionAudience | undefined,
): string => {
  switch (audience) {
    case "executor":
      return "Executor";
    case "validator":
      return "Validator";
    case "generator":
      return "Generator";
    case "all":
      return "All audiences";
    case undefined:
      return "Default audience";
  }
};

const getInstructionDiagnostics = (
  instruction: DiscoveredInstruction,
  diagnostics: CustomizationDiagnostic[],
): CustomizationDiagnostic[] => {
  const normalizedPath = instruction.path.replace(/\\/gu, "/").toLowerCase();

  return diagnostics.filter((diagnostic) => {
    const diagnosticPath = diagnostic.path?.replace(/\\/gu, "/").toLowerCase();

    return Boolean(
      diagnosticPath &&
        (diagnosticPath === normalizedPath ||
          diagnosticPath.endsWith(normalizedPath)),
    );
  });
};

const hasDiagnostics = (
  instruction: DiscoveredInstruction,
  diagnostics: CustomizationDiagnostic[],
): boolean => {
  return getInstructionDiagnostics(instruction, diagnostics).length > 0;
};

const getSearchText = (instruction: DiscoveredInstruction): string => {
  return [
    instruction.name,
    instruction.path,
    instruction.description,
    instruction.body,
    ...instruction.keywords,
    ...getApplyToPatterns(instruction),
    ...(instruction.excludePatterns ?? []),
  ]
    .filter((part): part is string => Boolean(part))
    .join(" ")
    .toLowerCase();
};

const normalizePathLike = (value: string): string => {
  return value.trim().replace(/\\/gu, "/");
};

const escapeRegex = (value: string): string => {
  return value.replace(/[|\\{}()[\]^$+?.]/gu, "\\$&");
};

const globToRegex = (pattern: string): RegExp => {
  const normalizedPattern = normalizePathLike(pattern);
  let source = "";

  for (let index = 0; index < normalizedPattern.length; index += 1) {
    const char = normalizedPattern[index];
    const next = normalizedPattern[index + 1];

    if (char === "*" && next === "*") {
      source += ".*";
      index += 1;
      continue;
    }

    if (char === "*") {
      source += "[^/]*";
      continue;
    }

    source += escapeRegex(char ?? "");
  }

  return new RegExp(`^${source}$`, "iu");
};

const matchesGlob = (path: string, pattern: string): boolean => {
  if (!path.trim() || !pattern.trim()) {
    return false;
  }

  return globToRegex(pattern).test(normalizePathLike(path));
};

const tokenizeText = (value: string): string[] => {
  return Array.from(
    new Set(
      value
        .toLowerCase()
        .split(/[^a-z0-9]+/u)
        .filter((part) => part.length >= 3),
    ),
  );
};

const instructionMatchesAudience = (
  instruction: DiscoveredInstruction,
  audience: InstructionTargetAudience,
): boolean => {
  return (
    !instruction.audience ||
    instruction.audience === "all" ||
    instruction.audience === audience
  );
};

const getExplicitInstructionReferences = (task: string): Set<string> => {
  const references = new Set<string>();
  const pattern = /@instruction(?::|\s+)(?:"([^"]+)"|'([^']+)'|([^\s,;]+))/giu;

  for (const match of task.matchAll(pattern)) {
    const rawReference = match[1] ?? match[2] ?? match[3];

    if (rawReference) {
      references.add(rawReference.trim().replace(/\\/gu, "/").toLowerCase());
    }
  }

  return references;
};

const isExplicitlyReferenced = (
  instruction: DiscoveredInstruction,
  references: Set<string>,
): boolean => {
  if (references.size === 0) {
    return false;
  }

  return [instruction.name, instruction.path, instruction.path.split("/").at(-1) ?? ""]
    .map((candidate) => candidate.trim().replace(/\\/gu, "/").toLowerCase())
    .some((candidate) => references.has(candidate));
};

const evaluateInstructionApplicability = (
  instruction: DiscoveredInstruction,
  draft: ApplicabilityDraft,
): ApplicabilityMatch | null => {
  const task = draft.task.trim();
  const path = normalizePathLike(draft.path);
  const mode = getInstructionMode(instruction);

  if (!task && !path) {
    return null;
  }

  if (mode === "disabled" || !instructionMatchesAudience(instruction, draft.audience)) {
    return null;
  }

  const references = getExplicitInstructionReferences(task);
  const explicitlyReferenced = isExplicitlyReferenced(instruction, references);

  if (mode === "manual" && !explicitlyReferenced) {
    return null;
  }

  if (
    !explicitlyReferenced &&
    path &&
    instruction.excludePatterns?.some((pattern) => matchesGlob(path, pattern))
  ) {
    return null;
  }

  if (mode === "always") {
    return {
      instruction,
      reason: "Always active for this audience.",
      priority: instruction.priority ?? 0,
    };
  }

  if (explicitlyReferenced) {
    return {
      instruction,
      reason: "Explicit @instruction reference.",
      priority: instruction.priority ?? 0,
    };
  }

  const reasons: string[] = [];
  const applyToPatterns = getApplyToPatterns(instruction);

  if (path && applyToPatterns.length > 0) {
    const matchedPattern = applyToPatterns.find((pattern) =>
      matchesGlob(path, pattern),
    );

    if (!matchedPattern) {
      return null;
    }

    reasons.push(`File path matches ${matchedPattern}.`);
  }

  const normalizedTask = task.toLowerCase();
  const matchedKeywords = instruction.keywords.filter((keyword) =>
    normalizedTask.includes(keyword.toLowerCase()),
  );

  if (matchedKeywords.length > 0) {
    reasons.push(`Task keywords: ${matchedKeywords.join(", ")}.`);
  }

  if (reasons.length === 0 && task) {
    const taskTokens = new Set(tokenizeText(task));
    const metadataTokens = tokenizeText(
      [instruction.name, instruction.description].filter(Boolean).join(" "),
    );
    const matchedTerms = metadataTokens.filter((term) => taskTokens.has(term));

    if (matchedTerms.length > 0) {
      reasons.push(`Metadata terms: ${matchedTerms.join(", ")}.`);
    }
  }

  if (reasons.length === 0) {
    return null;
  }

  return {
    instruction,
    reason: reasons.join(" "),
    priority: instruction.priority ?? 0,
  };
};

const getWorkflowTitle = (draft: InstructionDraft): string => {
  switch (draft.workflow) {
    case "create":
      return "Create instruction manually";
    case "edit":
      return `Editing ${draft.name || "instruction"}`;
    case "generate":
      return draft.path ? `Generate update for ${draft.name}` : "Generate instruction with AI";
    case "copy":
      return `Create editable copy of ${draft.name}`;
    case "idle":
      return "Create or edit instruction";
  }
};

const getWorkflowDescription = (draft: InstructionDraft): string => {
  switch (draft.workflow) {
    case "create":
      return "Write the instruction body directly. Save creates a new file and will not overwrite an existing one.";
    case "edit":
      return "Update this existing instruction file.";
    case "generate":
      return "Describe the rule you want. The AI writes the instruction file and validates it before saving.";
    case "copy":
      return "Copy a read-only compatibility instruction into an editable workspace or global file.";
    case "idle":
      return "Choose an instruction or start a create/generate flow.";
  }
};

export const InstructionSettingsPanel = ({
  setup,
}: InstructionSettingsPanelProps): JSX.Element => {
  const workspaceAvailable = Boolean(setup.workspaceRoot?.trim());
  const [draft, setDraft] = useState<InstructionDraft>(() =>
    createEmptyDraft(workspaceAvailable, "idle", "manual"),
  );
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [scopeFilter, setScopeFilter] =
    useState<InstructionScopeFilter>("all");
  const [modeFilter, setModeFilter] = useState<InstructionModeFilter>("all");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [tester, setTester] = useState<ApplicabilityDraft>({
    task: "",
    path: "",
    audience: "executor",
  });

  const sortedInstructions = useMemo(
    () => [...setup.instructions].sort(sortInstructions),
    [setup.instructions],
  );
  const filteredInstructions = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    return sortedInstructions.filter((instruction) => {
      const scope = getInstructionScope(instruction);
      const mode = getInstructionMode(instruction);

      if (scopeFilter !== "all" && scope !== scopeFilter) {
        return false;
      }

      if (modeFilter === "issues") {
        if (!hasDiagnostics(instruction, setup.diagnostics)) {
          return false;
        }
      } else if (modeFilter !== "all" && mode !== modeFilter) {
        return false;
      }

      return !normalizedQuery || getSearchText(instruction).includes(normalizedQuery);
    });
  }, [modeFilter, query, scopeFilter, setup.diagnostics, sortedInstructions]);
  const selectedInstruction = useMemo(() => {
    return sortedInstructions.find((instruction) => getInstructionKey(instruction) === selectedKey);
  }, [selectedKey, sortedInstructions]);
  const selectedDiagnostics = selectedInstruction
    ? getInstructionDiagnostics(selectedInstruction, setup.diagnostics)
    : [];
  const applicabilityMatches = useMemo(() => {
    return sortedInstructions
      .map((instruction) => evaluateInstructionApplicability(instruction, tester))
      .filter((match): match is ApplicabilityMatch => match !== null)
      .sort((left, right) => right.priority - left.priority);
  }, [sortedInstructions, tester]);
  const scopeBlocked = draft.scope === "workspace" && !workspaceAvailable;
  const submitDisabled =
    draft.workflow === "idle" ||
    setup.saving ||
    !draft.name.trim() ||
    !draft.prompt.trim() ||
    scopeBlocked;
  const editingActive = draft.workflow !== "idle";

  useEffect(() => {
    if (!workspaceAvailable && draft.scope === "workspace") {
      setDraft((current) => ({
        ...current,
        scope: "user",
      }));
    }
  }, [draft.scope, workspaceAvailable]);

  useEffect(() => {
    if (sortedInstructions.length === 0) {
      setSelectedKey(null);
      return;
    }

    if (
      !selectedKey ||
      !sortedInstructions.some((instruction) => getInstructionKey(instruction) === selectedKey)
    ) {
      setSelectedKey(getInstructionKey(sortedInstructions[0]));
    }
  }, [selectedKey, sortedInstructions]);

  const startManualCreate = (): void => {
    setAdvancedOpen(false);
    setDraft(createEmptyDraft(workspaceAvailable, "create", "manual"));
  };

  const startAiGenerate = (): void => {
    setAdvancedOpen(false);
    setDraft(createEmptyDraft(workspaceAvailable, "generate", "ai"));
  };

  const loadInstructionForEditing = (
    instruction: DiscoveredInstruction,
  ): void => {
    const scope = getInstructionScope(instruction);

    if (scope === "compatibility" || scope === "ralph-flow") {
      return;
    }

    setSelectedKey(getInstructionKey(instruction));
    setAdvancedOpen(false);
    setDraft({
      editorMode: "manual",
      workflow: "edit",
      name: instruction.name,
      path: instruction.path,
      scope,
      activationMode: getInstructionMode(instruction),
      audience: instruction.audience ?? "default",
      applyTo: formatStringList(getApplyToPatterns(instruction)),
      exclude: formatStringList(instruction.excludePatterns),
      keywords: formatStringList(instruction.keywords),
      priority:
        instruction.priority === undefined ? "" : String(instruction.priority),
      prompt: instruction.body,
      maxRounds: "2",
    });
  };

  const copyInstruction = (
    instruction: DiscoveredInstruction,
    scope: WritableInstructionScope,
  ): void => {
    setSelectedKey(getInstructionKey(instruction));
    setAdvancedOpen(false);
    setDraft({
      editorMode: "manual",
      workflow: "copy",
      name: instruction.name,
      path: "",
      scope,
      activationMode: getInstructionMode(instruction),
      audience: instruction.audience ?? "default",
      applyTo: formatStringList(getApplyToPatterns(instruction)),
      exclude: formatStringList(instruction.excludePatterns),
      keywords: formatStringList(instruction.keywords),
      priority:
        instruction.priority === undefined ? "" : String(instruction.priority),
      prompt: instruction.body,
      maxRounds: "2",
    });
  };

  const generateFromInstruction = (
    instruction: DiscoveredInstruction,
  ): void => {
    const scope = getInstructionScope(instruction);

    if (scope === "compatibility" || scope === "ralph-flow") {
      copyInstruction(instruction, workspaceAvailable ? "workspace" : "user");
      return;
    }

    setSelectedKey(getInstructionKey(instruction));
    setAdvancedOpen(false);
    setDraft({
      editorMode: "ai",
      workflow: "generate",
      name: instruction.name,
      path: instruction.path,
      scope,
      activationMode: getInstructionMode(instruction),
      audience: instruction.audience ?? "default",
      applyTo: formatStringList(getApplyToPatterns(instruction)),
      exclude: formatStringList(instruction.excludePatterns),
      keywords: formatStringList(instruction.keywords),
      priority:
        instruction.priority === undefined ? "" : String(instruction.priority),
      prompt: "",
      maxRounds: "2",
    });
  };

  const clearEditor = (): void => {
    setAdvancedOpen(false);
    setDraft(createEmptyDraft(workspaceAvailable, "idle", "manual"));
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();

    if (submitDisabled) {
      return;
    }

    const input = createMutationInput(draft);

    if (draft.editorMode === "manual") {
      void setup.onManualSave(input);
      return;
    }

    void setup.onGenerate(input);
  };

  return (
    <div className="grid gap-5">
      <SettingsCard
        title="Instruction files"
        description="Browse, inspect, and manage workspace, global, and read-only compatibility instruction files."
      >
        <div className="grid gap-4 py-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-slate-400">
              {setup.loading
                ? "Loading instructions..."
                : `${filteredInstructions.length} shown of ${sortedInstructions.length}`}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={setup.saving}
                onClick={startManualCreate}
                className="h-8 rounded-lg border-slate-800 bg-slate-950 px-3 text-xs text-slate-200 hover:bg-slate-900"
              >
                <Plus className="h-3.5 w-3.5" />
                Create manually
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={setup.saving}
                onClick={startAiGenerate}
                className="h-8 rounded-lg border-slate-800 bg-slate-950 px-3 text-xs text-slate-200 hover:bg-slate-900"
              >
                <WandSparkles className="h-3.5 w-3.5" />
                Generate with AI
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={setup.loading || setup.saving}
                onClick={() => {
                  void setup.onRefresh();
                }}
                className="h-8 rounded-lg border-slate-800 bg-slate-950 px-3 text-xs text-slate-200 hover:bg-slate-900"
              >
                <RefreshCw className={cn("h-3.5 w-3.5", setup.loading && "animate-spin")} />
                Refresh
              </Button>
            </div>
          </div>

          <div className="grid gap-3 rounded-lg border border-slate-800 bg-slate-950/50 p-3">
            <label className="grid gap-1 text-xs font-medium text-slate-400">
              <span>Search instruction files</span>
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-500" />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  className={`${INPUT_CLASS} pl-9`}
                  placeholder="Name, path, keyword, or body text"
                />
              </div>
            </label>
            <div className="grid gap-3">
              <div className="grid gap-1">
                <p className="text-xs font-medium text-slate-400">Scope</p>
                <ChoiceButtons
                  value={scopeFilter}
                  options={SCOPE_FILTER_OPTIONS}
                  disabled={setup.loading}
                  onChange={setScopeFilter}
                />
              </div>
              <div className="grid gap-1">
                <p className="text-xs font-medium text-slate-400">Activation</p>
                <ChoiceButtons
                  value={modeFilter}
                  options={MODE_FILTER_OPTIONS}
                  disabled={setup.loading}
                  onChange={setModeFilter}
                />
              </div>
            </div>
          </div>

          <div className="grid gap-3 lg:grid-cols-[minmax(15rem,0.9fr)_minmax(0,1.1fr)]">
            <div className="grid max-h-80 gap-2 overflow-y-auto pr-1 [scrollbar-width:thin]">
              {filteredInstructions.length > 0 ? (
                filteredInstructions.map((instruction) => {
                  const scope = getInstructionScope(instruction);
                  const mode = getInstructionMode(instruction);
                  const selected = getInstructionKey(instruction) === selectedKey;
                  const issueCount = getInstructionDiagnostics(
                    instruction,
                    setup.diagnostics,
                  ).length;

                  return (
                    <button
                      key={getInstructionKey(instruction)}
                      type="button"
                      onClick={() => setSelectedKey(getInstructionKey(instruction))}
                      className={cn(
                        "grid gap-2 rounded-lg border px-3 py-3 text-left transition-colors",
                        selected
                          ? "border-sky-500/40 bg-sky-500/10"
                          : "border-slate-800 bg-slate-950/70 hover:border-slate-700 hover:bg-slate-900/70",
                      )}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="break-words text-sm font-medium text-slate-100">
                            {instruction.name}
                          </p>
                          <p className="mt-1 break-all font-mono text-xs leading-5 text-slate-500">
                            {formatPathDisplay(instruction.path)}
                          </p>
                        </div>
                        {issueCount > 0 ? (
                          <Badge className="rounded-md border-amber-500/20 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-200">
                            {issueCount} issue{issueCount === 1 ? "" : "s"}
                          </Badge>
                        ) : null}
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        <Badge className="rounded-md border-slate-700 bg-slate-900 px-2 py-1 text-[11px] text-slate-300">
                          {scopeLabel(scope)}
                        </Badge>
                        <Badge className="rounded-md border-slate-700 bg-slate-900 px-2 py-1 text-[11px] text-slate-300">
                          {modeLabel(mode)}
                        </Badge>
                        {instruction.priority !== undefined ? (
                          <Badge className="rounded-md border-slate-700 bg-slate-900 px-2 py-1 text-[11px] text-slate-300">
                            Priority {instruction.priority}
                          </Badge>
                        ) : null}
                      </div>
                    </button>
                  );
                })
              ) : (
                <p className="rounded-lg border border-slate-800 bg-slate-950 px-3 py-3 text-sm text-slate-400">
                  No instruction files match the current filters.
                </p>
              )}
            </div>

            <div className="grid content-start gap-3 rounded-lg border border-slate-800 bg-slate-950/70 p-4">
              {selectedInstruction ? (
                <>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <FileText className="h-4 w-4 text-sky-300" />
                        <h4 className="break-words text-sm font-semibold text-slate-100">
                          {selectedInstruction.name}
                        </h4>
                      </div>
                      <p className="mt-1 break-all font-mono text-xs leading-5 text-slate-500">
                        {formatPathDisplay(selectedInstruction.path)}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {getInstructionScope(selectedInstruction) === "compatibility" ||
                      getInstructionScope(selectedInstruction) === "ralph-flow" ? (
                        <>
                          <Button
                            type="button"
                            variant="outline"
                            disabled={setup.saving || !workspaceAvailable}
                            onClick={() => copyInstruction(selectedInstruction, "workspace")}
                            className="h-8 rounded-lg border-slate-800 bg-slate-950 px-3 text-xs text-slate-200 hover:bg-slate-900"
                          >
                            <Copy className="h-3.5 w-3.5" />
                            Copy to workspace
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            disabled={setup.saving}
                            onClick={() => copyInstruction(selectedInstruction, "user")}
                            className="h-8 rounded-lg border-slate-800 bg-slate-950 px-3 text-xs text-slate-200 hover:bg-slate-900"
                          >
                            <Copy className="h-3.5 w-3.5" />
                            Copy global
                          </Button>
                        </>
                      ) : (
                        <Button
                          type="button"
                          variant="outline"
                          disabled={setup.saving}
                          onClick={() => loadInstructionForEditing(selectedInstruction)}
                          className="h-8 rounded-lg border-slate-800 bg-slate-950 px-3 text-xs text-slate-200 hover:bg-slate-900"
                        >
                          <FileText className="h-3.5 w-3.5" />
                          Edit selected
                        </Button>
                      )}
                      <Button
                        type="button"
                        variant="outline"
                        disabled={setup.saving}
                        onClick={() => generateFromInstruction(selectedInstruction)}
                        className="h-8 rounded-lg border-slate-800 bg-slate-950 px-3 text-xs text-slate-200 hover:bg-slate-900"
                      >
                        <WandSparkles className="h-3.5 w-3.5" />
                        AI update
                      </Button>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-1.5">
                    <Badge className="rounded-md border-slate-700 bg-slate-900 px-2 py-1 text-[11px] text-slate-300">
                      {scopeLabel(getInstructionScope(selectedInstruction))}
                    </Badge>
                    <Badge className="rounded-md border-slate-700 bg-slate-900 px-2 py-1 text-[11px] text-slate-300">
                      {modeLabel(getInstructionMode(selectedInstruction))}
                    </Badge>
                    <Badge className="rounded-md border-slate-700 bg-slate-900 px-2 py-1 text-[11px] text-slate-300">
                      {audienceLabel(selectedInstruction.audience)}
                    </Badge>
                    {selectedInstruction.priority !== undefined ? (
                      <Badge className="rounded-md border-slate-700 bg-slate-900 px-2 py-1 text-[11px] text-slate-300">
                        Priority {selectedInstruction.priority}
                      </Badge>
                    ) : null}
                  </div>

                  {selectedDiagnostics.length > 0 ? (
                    <div className="grid gap-2">
                      {selectedDiagnostics.map((diagnostic, index) => (
                        <p
                          key={`${diagnostic.code}:${diagnostic.path ?? index}`}
                          className={cn(
                            "rounded-lg border px-3 py-2 text-xs leading-5",
                            diagnostic.level === "error"
                              ? "border-rose-500/20 bg-rose-500/10 text-rose-200"
                              : "border-amber-500/20 bg-amber-500/10 text-amber-200",
                          )}
                        >
                          {diagnostic.code}: {diagnostic.message}
                        </p>
                      ))}
                    </div>
                  ) : null}

                  <div className="grid gap-2 text-xs leading-5 text-slate-400">
                    {getApplyToPatterns(selectedInstruction).length > 0 ? (
                      <p>
                        <span className="font-medium text-slate-300">Matching file globs:</span>{" "}
                        {getApplyToPatterns(selectedInstruction).join(", ")}
                      </p>
                    ) : null}
                    {selectedInstruction.excludePatterns &&
                    selectedInstruction.excludePatterns.length > 0 ? (
                      <p>
                        <span className="font-medium text-slate-300">Ignored file globs:</span>{" "}
                        {selectedInstruction.excludePatterns.join(", ")}
                      </p>
                    ) : null}
                    {selectedInstruction.keywords.length > 0 ? (
                      <p>
                        <span className="font-medium text-slate-300">Task keywords:</span>{" "}
                        {selectedInstruction.keywords.join(", ")}
                      </p>
                    ) : null}
                  </div>

                  <div className="max-h-40 overflow-y-auto rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 [scrollbar-width:thin]">
                    <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-5 text-slate-300">
                      {selectedInstruction.body}
                    </pre>
                  </div>
                </>
              ) : (
                <p className="text-sm text-slate-400">
                  Select an instruction file to inspect it.
                </p>
              )}
            </div>
          </div>

          <div className="grid gap-3 rounded-lg border border-slate-800 bg-slate-950/50 p-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h4 className="text-sm font-semibold text-slate-100">
                  Applicability tester
                </h4>
                <p className="mt-1 text-sm leading-5 text-slate-400">
                  Check which instructions would attach for a task, optional file path, and audience.
                </p>
              </div>
              <ChoiceButtons
                value={tester.audience}
                options={TEST_AUDIENCE_OPTIONS}
                onChange={(audience) =>
                  setTester((current) => ({ ...current, audience }))
                }
              />
            </div>
            <div className="grid gap-2 md:grid-cols-[minmax(0,1.4fr)_minmax(0,0.9fr)]">
              <Input
                value={tester.task}
                onChange={(event) =>
                  setTester((current) => ({
                    ...current,
                    task: event.target.value,
                  }))
                }
                className={INPUT_CLASS}
                placeholder='Task text, e.g. "review src/App.tsx"'
              />
              <Input
                value={tester.path}
                onChange={(event) =>
                  setTester((current) => ({
                    ...current,
                    path: event.target.value,
                  }))
                }
                className={MONO_INPUT_CLASS}
                placeholder="Optional file path"
              />
            </div>
            {tester.task.trim() || tester.path.trim() ? (
              applicabilityMatches.length > 0 ? (
                <div className="grid gap-2">
                  {applicabilityMatches.map((match) => (
                    <div
                      key={getInstructionKey(match.instruction)}
                      className="rounded-lg border border-slate-800 bg-slate-950 px-3 py-2"
                    >
                      <p className="text-sm font-medium text-slate-100">
                        {match.instruction.name}
                      </p>
                      <p className="mt-1 text-xs leading-5 text-slate-400">
                        {match.reason}
                      </p>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-400">
                  No instructions match this test input.
                </p>
              )
            ) : null}
          </div>
        </div>
      </SettingsCard>

      {editingActive ? (
        <SettingsCard
          title={getWorkflowTitle(draft)}
          description={getWorkflowDescription(draft)}
        >
          <form onSubmit={handleSubmit} className="grid gap-0">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 py-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge className="rounded-md border-sky-500/20 bg-sky-500/10 px-2 py-1 text-xs text-sky-100">
                  {draft.editorMode === "manual" ? "Manual" : "AI generation"}
                </Badge>
                <Badge className="rounded-md border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-300">
                  {draft.path ? "Existing file" : "New file"}
                </Badge>
              </div>
              <Button
                type="button"
                variant="outline"
                disabled={setup.saving}
                onClick={clearEditor}
                className="h-8 rounded-lg border-slate-800 bg-slate-950 px-3 text-xs text-slate-200 hover:bg-slate-900"
              >
                Close editor
              </Button>
            </div>

            <SettingPanel label="Name">
              <Input
                value={draft.name}
                onChange={(event) => {
                  setDraft((current) => ({
                    ...current,
                    name: event.target.value,
                  }));
                }}
                className={INPUT_CLASS}
                placeholder="Code review rules"
              />
            </SettingPanel>

            {draft.path.trim() ? (
              <SettingPanel label="Target file">
                <p className="break-all rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 font-mono text-xs leading-5 text-slate-400">
                  {formatPathDisplay(draft.path)}
                </p>
              </SettingPanel>
            ) : null}

            <SettingPanel label="Scope">
              <ChoiceButtons
                value={draft.scope}
                options={INSTRUCTION_SCOPE_OPTIONS.map((option) => ({
                  ...option,
                  disabled: option.value === "workspace" && !workspaceAvailable,
                }))}
                disabled={setup.saving || Boolean(draft.path)}
                onChange={(scope) => {
                  setDraft((current) => ({
                    ...current,
                    scope,
                  }));
                }}
              />
            </SettingPanel>

            <SettingPanel
              label={
                draft.editorMode === "manual"
                  ? "Instruction body"
                  : "Generation request"
              }
            >
              <Textarea
                value={draft.prompt}
                rows={draft.editorMode === "manual" ? 8 : 5}
                onChange={(event) => {
                  setDraft((current) => ({
                    ...current,
                    prompt: event.target.value,
                  }));
                }}
                className="min-h-36 rounded-lg border-slate-800 bg-slate-950 font-mono text-sm text-slate-100"
                placeholder={
                  draft.editorMode === "manual"
                    ? "Prefer strict TypeScript and include targeted tests."
                    : "Create instruction rules for React accessibility checks."
                }
              />
            </SettingPanel>

            <div className="border-b border-slate-800 py-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => setAdvancedOpen((open) => !open)}
                className="h-8 rounded-lg border-slate-800 bg-slate-950 px-3 text-xs text-slate-200 hover:bg-slate-900"
              >
                {advancedOpen ? "Hide advanced metadata" : "Show advanced metadata"}
              </Button>
            </div>

            {advancedOpen ? (
              <>
                <SettingPanel label="Activation">
                  <ChoiceButtons
                    value={draft.activationMode}
                    options={INSTRUCTION_MODE_OPTIONS}
                    disabled={setup.saving}
                    onChange={(activationMode) => {
                      setDraft((current) => ({
                        ...current,
                        activationMode,
                      }));
                    }}
                  />
                </SettingPanel>

                <SettingPanel label="Audience">
                  <ChoiceButtons
                    value={draft.audience}
                    options={INSTRUCTION_AUDIENCE_OPTIONS}
                    disabled={setup.saving}
                    onChange={(audience) => {
                      setDraft((current) => ({
                        ...current,
                        audience,
                      }));
                    }}
                  />
                </SettingPanel>

                <SettingPanel
                  label="Activation rules"
                  contentClassName="grid gap-3 md:grid-cols-3"
                >
                  <label className="grid gap-1 text-xs font-medium text-slate-400">
                    <span>Matching file globs</span>
                    <Textarea
                      value={draft.applyTo}
                      rows={3}
                      onChange={(event) => {
                        setDraft((current) => ({
                          ...current,
                          applyTo: event.target.value,
                        }));
                      }}
                      className={TEXTAREA_CLASS}
                      placeholder="src/**/*.ts"
                    />
                  </label>
                  <label className="grid gap-1 text-xs font-medium text-slate-400">
                    <span>Ignored file globs</span>
                    <Textarea
                      value={draft.exclude}
                      rows={3}
                      onChange={(event) => {
                        setDraft((current) => ({
                          ...current,
                          exclude: event.target.value,
                        }));
                      }}
                      className={TEXTAREA_CLASS}
                      placeholder="dist/**"
                    />
                  </label>
                  <label className="grid gap-1 text-xs font-medium text-slate-400">
                    <span>Task keywords</span>
                    <Textarea
                      value={draft.keywords}
                      rows={3}
                      onChange={(event) => {
                        setDraft((current) => ({
                          ...current,
                          keywords: event.target.value,
                        }));
                      }}
                      className={TEXTAREA_CLASS}
                      placeholder="review"
                    />
                  </label>
                </SettingPanel>

                <SettingPanel label="Priority">
                  <Input
                    type="number"
                    value={draft.priority}
                    onChange={(event) => {
                      setDraft((current) => ({
                        ...current,
                        priority: event.target.value,
                      }));
                    }}
                    className={`${MONO_INPUT_CLASS} max-w-32`}
                    placeholder="0"
                  />
                </SettingPanel>

                {draft.editorMode === "ai" ? (
                  <SettingPanel label="AI revision rounds">
                    <Input
                      type="number"
                      min={1}
                      max={4}
                      value={draft.maxRounds}
                      onChange={(event) => {
                        setDraft((current) => ({
                          ...current,
                          maxRounds: event.target.value,
                        }));
                      }}
                      className={`${MONO_INPUT_CLASS} max-w-32`}
                    />
                  </SettingPanel>
                ) : null}
              </>
            ) : null}

            <div className="flex flex-wrap items-center justify-between gap-3 pt-4">
              <p className="text-sm leading-6 text-slate-400">
                {scopeBlocked
                  ? "Workspace scope needs an active workspace."
                  : setup.saving
                    ? "Saving instruction..."
                    : draft.editorMode === "ai"
                      ? "AI generation will validate before saving."
                      : "Manual changes are ready to save."}
              </p>
              <Button
                type="submit"
                disabled={submitDisabled}
                className="h-9 rounded-lg bg-sky-500 px-4 text-sm font-medium text-white hover:bg-sky-400 disabled:opacity-50"
              >
                {draft.editorMode === "manual" ? (
                  <Save className="h-4 w-4" />
                ) : (
                  <WandSparkles className="h-4 w-4" />
                )}
                {draft.editorMode === "manual" ? "Save instruction" : "Generate instruction"}
              </Button>
            </div>

            <SettingsStatus message={setup.message} />
          </form>
        </SettingsCard>
      ) : (
        <SettingsStatus message={setup.message} />
      )}
    </div>
  );
};
