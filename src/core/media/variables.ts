import type {
  MediaFlow,
  MediaFlowPreset,
  MediaFlowVariable,
  MediaFlowVariableType,
  MediaFlowVariableValue,
} from "./contracts.js";

const MAX_VARIABLES = 32;
const MAX_PRESETS = 32;
const VARIABLE_TOKEN = /\{\{([a-z][a-z0-9_-]{0,63})\}\}/gu;
const EXACT_VARIABLE_TOKEN = /^\{\{([a-z][a-z0-9_-]{0,63})\}\}$/u;

export type MediaFlowVariableIssueCode =
  | "VARIABLE_SCHEMA_INVALID"
  | "VARIABLE_REQUIRED"
  | "VARIABLE_REFERENCE_UNKNOWN"
  | "VARIABLE_VALUE_INVALID";

export interface MediaFlowVariableIssue {
  code: MediaFlowVariableIssueCode;
  message: string;
  variableId: string | null;
  nodeId: string | null;
}

export interface MediaResolvedFlowVariable {
  id: string;
  name: string;
  type: MediaFlowVariableType;
  value: MediaFlowVariableValue | null;
  source: "binding" | "default" | "unresolved";
}

export interface ResolveMediaFlowVariablesResult {
  flow: MediaFlow;
  variables: MediaResolvedFlowVariable[];
  issues: MediaFlowVariableIssue[];
}

export interface AddMediaFlowVariableResult {
  flow: MediaFlow;
  variableId: string;
}

export interface CreateMediaFlowPresetResult {
  flow: MediaFlow;
  presetId: string;
}

const isTrimmedBoundedText = (
  value: string,
  maxLength: number,
  multiline = false,
): boolean =>
  value === value.trim() &&
  [...value].length <= maxLength &&
  [...value].every((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint === 127) return false;
    return multiline
      ? codePoint >= 32 || codePoint === 9 || codePoint === 10 || codePoint === 13
      : codePoint >= 32;
  });

const validateVariableValue = (
  variable: MediaFlowVariable,
  value: unknown,
): string | null => {
  switch (variable.type) {
    case "text":
      return typeof value === "string" &&
        [...value].length <= variable.constraints.maxLength
        ? null
        : `${variable.name} must be text no longer than ${variable.constraints.maxLength} characters.`;
    case "number": {
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < variable.constraints.min ||
        value > variable.constraints.max
      ) {
        return `${variable.name} must be between ${variable.constraints.min} and ${variable.constraints.max}.`;
      }
      const steps = (value - variable.constraints.min) / variable.constraints.step;
      return Math.abs(steps - Math.round(steps)) <= 1e-8
        ? null
        : `${variable.name} must align to a ${variable.constraints.step} step.`;
    }
    case "boolean":
      return typeof value === "boolean" ? null : `${variable.name} must be true or false.`;
    case "choice":
      return typeof value === "string" && variable.constraints.options.includes(value)
        ? null
        : `${variable.name} must use one of its declared options.`;
  }
};

const schemaIssue = (
  message: string,
  variableId: string | null = null,
): MediaFlowVariableIssue => ({
  code: "VARIABLE_SCHEMA_INVALID",
  message,
  variableId,
  nodeId: null,
});

export const validateMediaFlowVariableDocument = (
  flow: MediaFlow,
): readonly MediaFlowVariableIssue[] => {
  const issues: MediaFlowVariableIssue[] = [];
  if (flow.variables.length > MAX_VARIABLES) {
    issues.push(schemaIssue(`Media flows support at most ${MAX_VARIABLES} variables.`));
  }
  if (flow.presets.length > MAX_PRESETS) {
    issues.push(schemaIssue(`Media flows support at most ${MAX_PRESETS} presets.`));
  }

  const variablesById = new Map<string, MediaFlowVariable>();
  for (const variable of flow.variables) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(variable.id)) {
      issues.push(schemaIssue("Variable ids must be lowercase, bounded, and token-safe.", variable.id));
    }
    if (variablesById.has(variable.id)) {
      issues.push(schemaIssue(`Variable id ${variable.id} is duplicated.`, variable.id));
    }
    variablesById.set(variable.id, variable);
    if (!isTrimmedBoundedText(variable.name, 80) || variable.name.length === 0) {
      issues.push(schemaIssue(`Variable ${variable.id} requires a bounded display name.`, variable.id));
    }
    if (!isTrimmedBoundedText(variable.description, 500, true)) {
      issues.push(schemaIssue(`Variable ${variable.id} has an invalid description.`, variable.id));
    }

    switch (variable.type) {
      case "text":
        if (
          !Number.isInteger(variable.constraints.maxLength) ||
          variable.constraints.maxLength < 1 ||
          variable.constraints.maxLength > 8_000
        ) {
          issues.push(schemaIssue(`${variable.name} has an invalid text length limit.`, variable.id));
        }
        break;
      case "number":
        if (
          !Number.isFinite(variable.constraints.min) ||
          !Number.isFinite(variable.constraints.max) ||
          variable.constraints.min > variable.constraints.max ||
          !Number.isFinite(variable.constraints.step) ||
          variable.constraints.step <= 0
        ) {
          issues.push(schemaIssue(`${variable.name} has invalid numeric constraints.`, variable.id));
        }
        break;
      case "boolean":
        if (Object.keys(variable.constraints).length > 0) {
          issues.push(schemaIssue(`${variable.name} has unsupported boolean constraints.`, variable.id));
        }
        break;
      case "choice": {
        const options = variable.constraints.options;
        if (
          options.length === 0 ||
          options.length > 64 ||
          new Set(options).size !== options.length ||
          options.some(
            (option) =>
              option.length === 0 || !isTrimmedBoundedText(option, 80),
          )
        ) {
          issues.push(schemaIssue(`${variable.name} requires 1–64 unique bounded options.`, variable.id));
        }
        break;
      }
    }

    if (variable.defaultValue !== null) {
      const reason = validateVariableValue(variable, variable.defaultValue);
      if (reason) issues.push(schemaIssue(`Invalid default: ${reason}`, variable.id));
    }
  }

  for (const [variableId, value] of Object.entries(flow.variableBindings)) {
    const variable = variablesById.get(variableId);
    if (!variable) {
      issues.push(schemaIssue(`Binding ${variableId} does not reference a declared variable.`, variableId));
      continue;
    }
    const reason = validateVariableValue(variable, value);
    if (reason) {
      issues.push({
        code: "VARIABLE_VALUE_INVALID",
        message: reason,
        variableId,
        nodeId: null,
      });
    }
  }

  const presetIds = new Set<string>();
  for (const preset of flow.presets) {
    if (
      !/^[a-z][a-z0-9_-]{0,63}$/u.test(preset.id) ||
      presetIds.has(preset.id)
    ) {
      issues.push(schemaIssue(`Preset id ${preset.id} is invalid or duplicated.`));
    }
    presetIds.add(preset.id);
    if (!isTrimmedBoundedText(preset.name, 80) || preset.name.length === 0) {
      issues.push(schemaIssue(`Preset ${preset.id} requires a bounded display name.`));
    }
    if (!isTrimmedBoundedText(preset.description, 500, true)) {
      issues.push(schemaIssue(`Preset ${preset.id} has an invalid description.`));
    }
    for (const [variableId, value] of Object.entries(preset.values)) {
      const variable = variablesById.get(variableId);
      if (!variable) {
        issues.push(schemaIssue(`Preset ${preset.name} references unknown variable ${variableId}.`));
        continue;
      }
      const reason = validateVariableValue(variable, value);
      if (reason) issues.push(schemaIssue(`Preset ${preset.name}: ${reason}`, variableId));
    }
  }
  if (flow.activePresetId !== null && !presetIds.has(flow.activePresetId)) {
    issues.push(schemaIssue(`Active preset ${flow.activePresetId} does not exist.`));
  }
  return issues;
};

export const getMediaFlowVariableValue = (
  flow: MediaFlow,
  variable: MediaFlowVariable,
): { value: MediaFlowVariableValue | null; source: "binding" | "default" | "unresolved" } => {
  if (Object.hasOwn(flow.variableBindings, variable.id)) {
    return { value: flow.variableBindings[variable.id] ?? null, source: "binding" };
  }
  return variable.defaultValue === null
    ? { value: null, source: "unresolved" }
    : { value: variable.defaultValue, source: "default" };
};

export const resolveMediaFlowVariables = (
  flow: MediaFlow,
): ResolveMediaFlowVariablesResult => {
  const issues = [...validateMediaFlowVariableDocument(flow)];
  const resolvedVariables = flow.variables.map((variable) => {
    const resolved = getMediaFlowVariableValue(flow, variable);
    if (variable.required && (
      resolved.value === null ||
      (typeof resolved.value === "string" && resolved.value.trim().length === 0)
    )) {
      issues.push({
        code: "VARIABLE_REQUIRED",
        message: `${variable.name} requires a value before this flow can run.`,
        variableId: variable.id,
        nodeId: null,
      });
      return { ...variable, ...resolved, value: null } satisfies MediaResolvedFlowVariable;
    }
    return { ...variable, ...resolved } satisfies MediaResolvedFlowVariable;
  });
  const values = new Map(resolvedVariables.map((variable) => [variable.id, variable.value]));
  const issueIdentities = new Set(
    issues.map((issue) => `${issue.code}\u001f${issue.variableId ?? ""}\u001f${issue.nodeId ?? ""}`),
  );
  const addReferenceIssue = (
    code: "VARIABLE_REQUIRED" | "VARIABLE_REFERENCE_UNKNOWN",
    variableId: string,
    nodeId: string,
    message: string,
  ): void => {
    const identity = `${code}\u001f${variableId}\u001f${nodeId}`;
    if (issueIdentities.has(identity)) return;
    issueIdentities.add(identity);
    issues.push({ code, message, variableId, nodeId });
  };

  const resolveValue = (value: unknown, nodeId: string): unknown => {
    if (typeof value === "string") {
      const exact = value.match(EXACT_VARIABLE_TOKEN);
      if (exact) {
        const variableId = exact[1] ?? "";
        if (!values.has(variableId)) {
          addReferenceIssue(
            "VARIABLE_REFERENCE_UNKNOWN",
            variableId,
            nodeId,
            `Node ${nodeId} references undeclared variable ${variableId}.`,
          );
          return value;
        }
        const resolved = values.get(variableId) ?? null;
        if (resolved === null) {
          addReferenceIssue(
            "VARIABLE_REQUIRED",
            variableId,
            nodeId,
            `Node ${nodeId} requires a value for ${variableId}.`,
          );
          return value;
        }
        return resolved;
      }
      return value.replace(VARIABLE_TOKEN, (token, variableId: string) => {
        if (!values.has(variableId)) {
          addReferenceIssue(
            "VARIABLE_REFERENCE_UNKNOWN",
            variableId,
            nodeId,
            `Node ${nodeId} references undeclared variable ${variableId}.`,
          );
          return token;
        }
        const resolved = values.get(variableId) ?? null;
        if (resolved === null) {
          addReferenceIssue(
            "VARIABLE_REQUIRED",
            variableId,
            nodeId,
            `Node ${nodeId} requires a value for ${variableId}.`,
          );
          return token;
        }
        return String(resolved);
      });
    }
    if (Array.isArray(value)) return value.map((entry) => resolveValue(entry, nodeId));
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, resolveValue(entry, nodeId)]),
      );
    }
    return value;
  };

  return {
    flow: {
      ...flow,
      nodes: flow.nodes.map((node) => ({
        ...node,
        config: resolveValue(node.config, node.id) as Record<string, unknown>,
      })),
    },
    variables: resolvedVariables,
    issues,
  };
};

const createIndexedId = (prefix: string, ids: ReadonlySet<string>): string => {
  let index = 1;
  while (ids.has(`${prefix}-${index}`)) index += 1;
  return `${prefix}-${index}`;
};

const createVariable = (
  type: MediaFlowVariableType,
  id: string,
  index: number,
): MediaFlowVariable => {
  const base = {
    id,
    name: `${type[0]?.toLocaleUpperCase()}${type.slice(1)} variable ${index}`,
    description: "",
    required: true,
  };
  switch (type) {
    case "text":
      return { ...base, type, defaultValue: "", constraints: { maxLength: 500 } };
    case "number":
      return { ...base, type, defaultValue: 1, constraints: { min: 0, max: 100, step: 1 } };
    case "boolean":
      return { ...base, type, defaultValue: false, constraints: {} };
    case "choice":
      return {
        ...base,
        type,
        defaultValue: "Option A",
        constraints: { options: ["Option A", "Option B"] },
      };
  }
};

export const addMediaFlowVariable = ({
  flow,
  type,
  updatedAt,
}: {
  flow: MediaFlow;
  type: MediaFlowVariableType;
  updatedAt: string;
}): AddMediaFlowVariableResult => {
  if (flow.variables.length >= MAX_VARIABLES) {
    throw new Error(`Media flows support at most ${MAX_VARIABLES} variables.`);
  }
  const variableId = createIndexedId(
    "variable",
    new Set(flow.variables.map((variable) => variable.id)),
  );
  return {
    variableId,
    flow: {
      ...flow,
      updatedAt,
      activePresetId: null,
      variables: [
        ...flow.variables,
        createVariable(type, variableId, flow.variables.length + 1),
      ],
    },
  };
};

export const replaceMediaFlowVariable = ({
  flow,
  variable,
  updatedAt,
}: {
  flow: MediaFlow;
  variable: MediaFlowVariable;
  updatedAt: string;
}): MediaFlow => {
  if (!flow.variables.some((entry) => entry.id === variable.id)) {
    throw new Error(`Media flow variable ${variable.id} was not found.`);
  }
  const variableBindings = { ...flow.variableBindings };
  if (
    Object.hasOwn(variableBindings, variable.id) &&
    validateVariableValue(variable, variableBindings[variable.id])
  ) {
    delete variableBindings[variable.id];
  }
  const presets = flow.presets.map((preset) => {
    if (!Object.hasOwn(preset.values, variable.id)) {
      return preset;
    }
    const reason = validateVariableValue(variable, preset.values[variable.id]);
    if (!reason) return preset;
    const values = { ...preset.values };
    delete values[variable.id];
    return { ...preset, values };
  });
  const nextFlow = {
    ...flow,
    updatedAt,
    variables: flow.variables.map((entry) => entry.id === variable.id ? variable : entry),
    variableBindings,
    presets,
  };
  const issue = validateMediaFlowVariableDocument(nextFlow)[0];
  if (issue) throw new Error(issue.message);
  return nextFlow;
};

export const removeMediaFlowVariable = ({
  flow,
  variableId,
  updatedAt,
}: {
  flow: MediaFlow;
  variableId: string;
  updatedAt: string;
}): MediaFlow => {
  if (!flow.variables.some((variable) => variable.id === variableId)) {
    throw new Error(`Media flow variable ${variableId} was not found.`);
  }
  const variableBindings = { ...flow.variableBindings };
  delete variableBindings[variableId];
  return {
    ...flow,
    updatedAt,
    activePresetId: null,
    variables: flow.variables.filter((variable) => variable.id !== variableId),
    variableBindings,
    presets: flow.presets.map((preset) => {
      const values = { ...preset.values };
      delete values[variableId];
      return { ...preset, values };
    }),
  };
};

export const setMediaFlowVariableBinding = ({
  flow,
  variableId,
  value,
  updatedAt,
}: {
  flow: MediaFlow;
  variableId: string;
  value: MediaFlowVariableValue | null;
  updatedAt: string;
}): MediaFlow => {
  const variable = flow.variables.find((entry) => entry.id === variableId);
  if (!variable) throw new Error(`Media flow variable ${variableId} was not found.`);
  if (value !== null) {
    const reason = validateVariableValue(variable, value);
    if (reason) throw new Error(reason);
  }
  const variableBindings = { ...flow.variableBindings };
  if (value === null) delete variableBindings[variableId];
  else variableBindings[variableId] = value;
  return { ...flow, updatedAt, variableBindings, activePresetId: null };
};

export const createMediaFlowPreset = ({
  flow,
  name,
  description = "",
  updatedAt,
}: {
  flow: MediaFlow;
  name: string;
  description?: string;
  updatedAt: string;
}): CreateMediaFlowPresetResult => {
  if (flow.presets.length >= MAX_PRESETS) {
    throw new Error(`Media flows support at most ${MAX_PRESETS} presets.`);
  }
  const normalizedName = name.trim().slice(0, 80);
  if (!normalizedName) throw new Error("Preset names cannot be empty.");
  const unresolved = resolveMediaFlowVariables(flow).variables.find(
    (variable) => variable.value === null &&
      flow.variables.find((declaration) => declaration.id === variable.id)?.required,
  );
  if (unresolved) {
    throw new Error(`Resolve ${unresolved.name} before saving a preset.`);
  }
  const presetId = createIndexedId(
    "preset",
    new Set(flow.presets.map((preset) => preset.id)),
  );
  const values = Object.fromEntries(
    flow.variables.flatMap((variable) => {
      const resolved = getMediaFlowVariableValue(flow, variable).value;
      return resolved === null ? [] : [[variable.id, resolved] as const];
    }),
  );
  const preset: MediaFlowPreset = {
    id: presetId,
    name: normalizedName,
    description: description.trim().slice(0, 500),
    values,
  };
  return {
    presetId,
    flow: {
      ...flow,
      updatedAt,
      presets: [...flow.presets, preset],
      activePresetId: presetId,
      variableBindings: { ...values },
    },
  };
};

export const updateMediaFlowPreset = ({
  flow,
  presetId,
  updatedAt,
}: {
  flow: MediaFlow;
  presetId: string;
  updatedAt: string;
}): MediaFlow => {
  if (!flow.presets.some((preset) => preset.id === presetId)) {
    throw new Error(`Media flow preset ${presetId} was not found.`);
  }
  const resolution = resolveMediaFlowVariables(flow);
  const unresolved = resolution.variables.find((variable) => variable.value === null &&
    flow.variables.find((declaration) => declaration.id === variable.id)?.required);
  if (unresolved) throw new Error(`Resolve ${unresolved.name} before updating a preset.`);
  const values = Object.fromEntries(
    resolution.variables.flatMap((variable) => variable.value === null
      ? []
      : [[variable.id, variable.value] as const]),
  );
  return {
    ...flow,
    updatedAt,
    activePresetId: presetId,
    variableBindings: { ...values },
    presets: flow.presets.map((preset) =>
      preset.id === presetId ? { ...preset, values: { ...values } } : preset,
    ),
  };
};

export const applyMediaFlowPreset = ({
  flow,
  presetId,
  updatedAt,
}: {
  flow: MediaFlow;
  presetId: string;
  updatedAt: string;
}): MediaFlow => {
  const preset = flow.presets.find((entry) => entry.id === presetId);
  if (!preset) throw new Error(`Media flow preset ${presetId} was not found.`);
  return {
    ...flow,
    updatedAt,
    activePresetId: presetId,
    variableBindings: { ...preset.values },
  };
};

export const removeMediaFlowPreset = ({
  flow,
  presetId,
  updatedAt,
}: {
  flow: MediaFlow;
  presetId: string;
  updatedAt: string;
}): MediaFlow => {
  if (!flow.presets.some((preset) => preset.id === presetId)) {
    throw new Error(`Media flow preset ${presetId} was not found.`);
  }
  return {
    ...flow,
    updatedAt,
    activePresetId: flow.activePresetId === presetId ? null : flow.activePresetId,
    presets: flow.presets.filter((preset) => preset.id !== presetId),
  };
};
