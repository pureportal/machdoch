import { randomUUID } from "node:crypto";
import type { ConfiguredModelProvider } from "../runtime-contract.generated.js";
import {
  canonicalDigest,
  deepFreeze,
  estimateConservativeTokensFromUtf8Bytes,
  INSTRUCTION_PROVIDER_RESERVE_TOKENS,
  MAX_INSTRUCTION_ENVELOPE_BYTES,
} from "./normalization.js";
import {
  INSTRUCTION_DELIVERY_SCHEMA_VERSION,
  InstructionSystemError,
  type FrozenInstructionSet,
  type InstructionCapabilityDescriptor,
  type InstructionDeliveryDimension,
  type InstructionDeliveryPlan,
  type InstructionDeliveryReceipt,
  type InstructionInvocationBudgetReport,
} from "./types.js";

const INSTRUCTION_ADAPTER_VERSION = "machdoch-instruction-adapter/1";

const API_CAPABILITIES: Record<
  Extract<
    ConfiguredModelProvider,
    "openai" | "anthropic" | "google" | "langdock"
  >,
  InstructionCapabilityDescriptor
> = {
  openai: {
    adapterVersion: INSTRUCTION_ADAPTER_VERSION,
    providerId: "openai",
    surface: "api",
    authority: "developer",
    contentFidelity: "exact",
    scopeFidelity: "declarative-envelope",
    acceptsArbitraryContent: true,
    nativeDiscovery: "isolated",
    acceptsTemporaryInstructionFile: false,
    conformance: "protocol-tested",
    receiptDigestVerification: true,
    lifecycle: {
      initial: "reattached",
      continuation: "reattached",
      retry: "reattached",
      roles: "reattached",
      subagents: "unsupported",
    },
    mechanism: "Responses API instructions",
    maxInstructionBytes: MAX_INSTRUCTION_ENVELOPE_BYTES,
    evidence: [
      "Machdoch supplies instructions on the initial Responses request.",
      "Machdoch reattaches the same instructions with previous_response_id continuations.",
    ],
  },
  anthropic: {
    adapterVersion: INSTRUCTION_ADAPTER_VERSION,
    providerId: "anthropic",
    surface: "api",
    authority: "system",
    contentFidelity: "exact",
    scopeFidelity: "declarative-envelope",
    acceptsArbitraryContent: true,
    nativeDiscovery: "isolated",
    acceptsTemporaryInstructionFile: false,
    conformance: "protocol-tested",
    receiptDigestVerification: true,
    lifecycle: {
      initial: "reattached",
      continuation: "reattached",
      retry: "reattached",
      roles: "reattached",
      subagents: "unsupported",
    },
    mechanism: "Messages API top-level system",
    maxInstructionBytes: MAX_INSTRUCTION_ENVELOPE_BYTES,
    evidence: [
      "Machdoch supplies the same top-level system content on every request.",
    ],
  },
  google: {
    adapterVersion: INSTRUCTION_ADAPTER_VERSION,
    providerId: "google",
    surface: "api",
    authority: "system",
    contentFidelity: "exact",
    scopeFidelity: "declarative-envelope",
    acceptsArbitraryContent: true,
    nativeDiscovery: "isolated",
    acceptsTemporaryInstructionFile: false,
    conformance: "protocol-tested",
    receiptDigestVerification: true,
    lifecycle: {
      initial: "reattached",
      continuation: "reattached",
      retry: "reattached",
      roles: "reattached",
      subagents: "unsupported",
    },
    mechanism: "Gemini systemInstruction",
    maxInstructionBytes: MAX_INSTRUCTION_ENVELOPE_BYTES,
    evidence: [
      "Machdoch supplies the same systemInstruction on every request.",
    ],
  },
  langdock: {
    adapterVersion: INSTRUCTION_ADAPTER_VERSION,
    providerId: "langdock",
    surface: "api",
    authority: "system",
    contentFidelity: "exact",
    scopeFidelity: "declarative-envelope",
    acceptsArbitraryContent: true,
    nativeDiscovery: "isolated",
    acceptsTemporaryInstructionFile: false,
    conformance: "provisional",
    receiptDigestVerification: true,
    lifecycle: {
      initial: "reattached",
      continuation: "unknown",
      retry: "reattached",
      roles: "reattached",
      subagents: "unsupported",
    },
    mechanism: "Langdock system message (provisional)",
    maxInstructionBytes: MAX_INSTRUCTION_ENVELOPE_BYTES,
    evidence: [
      "The authenticated Langdock contract has not been independently verified.",
      "Machdoch uses the existing adapter's system-message mapping without claiming stronger authority.",
    ],
  },
};

const CLI_CAPABILITIES: Record<
  Extract<ConfiguredModelProvider, "codex-cli" | "claude-cli" | "copilot-cli">,
  InstructionCapabilityDescriptor
> = {
  "codex-cli": {
    adapterVersion: INSTRUCTION_ADAPTER_VERSION,
    providerId: "codex-cli",
    surface: "cli",
    authority: "developer",
    contentFidelity: "exact",
    scopeFidelity: "declarative-envelope",
    acceptsArbitraryContent: true,
    nativeDiscovery: "accounted-extra",
    acceptsTemporaryInstructionFile: true,
    conformance: "unknown",
    receiptDigestVerification: true,
    lifecycle: {
      initial: "session",
      continuation: "session",
      retry: "reattached",
      roles: "reattached",
      subagents: "unknown",
    },
    mechanism:
      "temporary CODEX_HOME plus runtime developer_instructions override",
    maxInstructionBytes: MAX_INSTRUCTION_ENVELOPE_BYTES,
    evidence: [
      "Machdoch creates a run-scoped CODEX_HOME and repeats the canonical envelope through the documented runtime configuration override.",
      "Suppression of project AGENTS.md discovery is not asserted because no supported contract proves it.",
    ],
  },
  "claude-cli": {
    adapterVersion: INSTRUCTION_ADAPTER_VERSION,
    providerId: "claude-cli",
    surface: "cli",
    authority: "system",
    contentFidelity: "exact",
    scopeFidelity: "declarative-envelope",
    acceptsArbitraryContent: true,
    nativeDiscovery: "accounted-extra",
    acceptsTemporaryInstructionFile: true,
    conformance: "unknown",
    receiptDigestVerification: true,
    lifecycle: {
      initial: "session",
      continuation: "session",
      retry: "reattached",
      roles: "reattached",
      subagents: "unknown",
    },
    mechanism: "run-scoped system-prompt file",
    maxInstructionBytes: MAX_INSTRUCTION_ENVELOPE_BYTES,
    evidence: [
      "Machdoch uses the CLI's supported system-prompt file argument.",
      "Bare-mode and subagent inheritance are only enabled after a concrete version/help probe proves the exact flags.",
    ],
  },
  "copilot-cli": {
    adapterVersion: INSTRUCTION_ADAPTER_VERSION,
    providerId: "copilot-cli",
    surface: "cli",
    authority: "user",
    contentFidelity: "exact",
    scopeFidelity: "declarative-envelope",
    acceptsArbitraryContent: true,
    nativeDiscovery: "accounted-extra",
    acceptsTemporaryInstructionFile: true,
    conformance: "unknown",
    receiptDigestVerification: true,
    lifecycle: {
      initial: "session",
      continuation: "session",
      retry: "reattached",
      roles: "reattached",
      subagents: "unknown",
    },
    mechanism: "prompt delivery with --no-custom-instructions",
    maxInstructionBytes: MAX_INSTRUCTION_ENVELOPE_BYTES,
    evidence: [
      "Machdoch suppresses documented custom instruction files for the invocation, but repository custom agents and other provider configuration can remain active and are not claimed isolated.",
      "The CLI does not expose a verified higher-authority arbitrary instruction field.",
    ],
  },
};

export const getInstructionCapabilityDescriptor = (
  providerId: ConfiguredModelProvider,
  surface: "api" | "cli",
  probe?: { version?: string; evidence?: string },
): InstructionCapabilityDescriptor => {
  const base =
    surface === "api"
      ? API_CAPABILITIES[providerId as keyof typeof API_CAPABILITIES]
      : CLI_CAPABILITIES[providerId as keyof typeof CLI_CAPABILITIES];
  if (!base || base.surface !== surface) {
    return {
      adapterVersion: INSTRUCTION_ADAPTER_VERSION,
      providerId,
      surface,
      authority: "none",
      contentFidelity: "none",
      scopeFidelity: "none",
      acceptsArbitraryContent: false,
      nativeDiscovery: "uncontrolled",
      acceptsTemporaryInstructionFile: false,
      conformance: "unknown",
      receiptDigestVerification: false,
      lifecycle: {
        initial: "unsupported",
        continuation: "unsupported",
        retry: "unsupported",
        roles: "unsupported",
        subagents: "unsupported",
      },
      mechanism: "No supported instruction adapter",
      evidence: [
        "Provider and execution surface do not have a supported mapping.",
      ],
      ...(probe?.version === undefined ? {} : { version: probe.version }),
      ...(probe?.evidence === undefined
        ? {}
        : { versionEvidence: probe.evidence }),
    };
  }
  return {
    ...base,
    evidence: [...base.evidence],
    ...(probe?.version === undefined ? {} : { version: probe.version }),
    ...(probe?.evidence === undefined
      ? {}
      : { versionEvidence: probe.evidence }),
  };
};

const dimension = (
  name: InstructionDeliveryDimension["name"],
  status: InstructionDeliveryDimension["status"],
  detail: string,
): InstructionDeliveryDimension => ({ name, status, detail });

const nativeRecordAppliesToProvider = (
  providerId: ConfiguredModelProvider,
  conventions: readonly string[],
): boolean =>
  conventions.some((convention) => {
    if (providerId === "codex-cli") {
      return convention.includes("codex");
    }
    if (providerId === "claude-cli") {
      return convention.includes("claude");
    }
    if (providerId === "copilot-cli") {
      return (
        convention.includes("copilot") ||
        convention === "agents-md" ||
        convention === "claude-project-memory" ||
        convention === "gemini-context-file"
      );
    }
    return false;
  });

export const createInstructionDeliveryPlan = (
  resolution: FrozenInstructionSet,
  input: {
    capability?: InstructionCapabilityDescriptor;
    now?: Date;
  } = {},
): InstructionDeliveryPlan => {
  const capability = input.capability ?? {
    ...getInstructionCapabilityDescriptor(
      resolution.providerId,
      resolution.surface,
    ),
    ...(resolution.budget.providerLimitTokens === undefined
      ? {}
      : { maxInputTokens: resolution.budget.providerLimitTokens }),
  };
  const dimensions: InstructionDeliveryDimension[] = [];
  const relevantUnreadableNative = resolution.nativeInventory.filter(
    (record) =>
      record.status === "unreadable" &&
      nativeRecordAppliesToProvider(
        resolution.providerId,
        record.recognizingConventions ?? [record.convention],
      ),
  );
  const contentFailureEvidence =
    capability.contentFidelity === "none"
      ? capability.evidence.at(-1)
      : undefined;

  dimensions.push(
    dimension(
      "content",
      capability.contentFidelity === "exact" &&
        capability.acceptsArbitraryContent
        ? "satisfied"
        : capability.contentFidelity === "rewritten"
          ? "compatible"
          : "unsupported",
      capability.contentFidelity === "exact" &&
        capability.acceptsArbitraryContent
        ? `Every one of the ${resolution.bodyGroups.length} rendered body occurrence(s) is bound to the canonical digest with no adapter rewrite, omission, duplicate, or truncation.`
        : `Content fidelity is ${capability.contentFidelity}; complete exact delivery cannot be claimed.${
            contentFailureEvidence === undefined
              ? ""
              : ` ${contentFailureEvidence}`
          }`,
    ),
    dimension(
      "scope",
      capability.scopeFidelity === "none" ? "unsupported" : "satisfied",
      capability.scopeFidelity === "native-structural"
        ? "The surface preserves native structural scope."
        : capability.scopeFidelity === "declarative-envelope"
          ? "The collision-safe canonical envelope carries exact scope and precedence metadata."
          : "The surface cannot preserve instruction scope.",
    ),
    dimension(
      "authority",
      capability.authority === "none"
        ? "unsupported"
        : capability.authority === "system" ||
            capability.authority === "developer"
          ? "satisfied"
          : "compatible",
      `Delivered with ${capability.authority} authority through ${capability.mechanism}.`,
    ),
    dimension(
      "native-isolation",
      relevantUnreadableNative.length > 0 &&
        capability.nativeDiscovery !== "isolated" &&
        capability.nativeDiscovery !== "suppressed"
        ? "unsupported"
        : capability.nativeDiscovery === "isolated" ||
            capability.nativeDiscovery === "suppressed"
          ? "satisfied"
          : capability.nativeDiscovery === "accounted-extra" ||
              capability.nativeDiscovery === "unknown"
            ? "compatible"
            : "unsupported",
      relevantUnreadableNative.length > 0 &&
        capability.nativeDiscovery !== "isolated" &&
        capability.nativeDiscovery !== "suppressed"
        ? `${relevantUnreadableNative.length} active provider-native instruction path(s) could not be inventoried, and this adapter cannot prove they are suppressed.`
        : capability.nativeDiscovery === "isolated"
          ? "No independent provider-native repository discovery applies on this surface."
          : capability.nativeDiscovery === "suppressed"
            ? "The invocation suppresses documented native instruction discovery."
            : capability.nativeDiscovery === "accounted-extra"
              ? "Provider-native extras are inventoried, but exact non-duplicating isolation is not proven."
              : capability.nativeDiscovery === "unknown"
                ? "Additional provider-native discovery cannot be proven absent."
                : "Provider-native discovery is uncontrolled.",
    ),
  );
  for (const name of [
    "initial",
    "continuation",
    "retry",
    "roles",
    "subagents",
  ] as const) {
    const support = capability.lifecycle[name];
    const apiSubagentNotApplicable =
      name === "subagents" &&
      capability.surface === "api" &&
      support === "unsupported";
    dimensions.push(
      dimension(
        name,
        apiSubagentNotApplicable ||
          support === "reattached" ||
          support === "session"
          ? "satisfied"
          : support === "unknown"
            ? "compatible"
            : "unsupported",
        apiSubagentNotApplicable
          ? "Machdoch does not invoke provider-native subagents on this API surface."
          : `${name} instruction behavior is ${support}.`,
      ),
    );
  }
  dimensions.push(
    dimension(
      "budget",
      resolution.budget.blockingErrors.length === 0
        ? resolution.budget.providerLimitTokens === undefined
          ? "compatible"
          : "satisfied"
        : "unsupported",
      resolution.budget.blockingErrors.length > 0
        ? resolution.budget.blockingErrors.join(" ")
        : resolution.budget.providerLimitTokens === undefined
          ? `Envelope is ${resolution.budget.envelopeBytes} bytes with ${resolution.budget.runtimeSupplementBytes ?? 0} bytes of frozen runtime instruction supplements; neither will be truncated, but ${
              resolution.model
                ? `model ${resolution.model}`
                : "the unresolved model"
            } has no verified input-capacity record.`
          : `Envelope is ${resolution.budget.envelopeBytes} bytes with ${resolution.budget.runtimeSupplementBytes ?? 0} bytes of frozen runtime instruction supplements; neither will be truncated${
              resolution.budget.availableInstructionTokens === undefined
                ? "."
                : `; ${resolution.budget.availableInstructionTokens} conservatively reserved instruction-input tokens are available.`
            }`,
    ),
    dimension(
      "conformance",
      capability.conformance === "protocol-tested" ? "satisfied" : "compatible",
      capability.conformance === "protocol-tested"
        ? `Adapter ${capability.adapterVersion} has request/continuation protocol fixture evidence for this route.`
        : capability.conformance === "provisional"
          ? `Adapter ${capability.adapterVersion} is provisional and cannot claim full route/version conformance.`
          : `Adapter ${capability.adapterVersion} has no exact runtime conformance record for this surface/version.`,
    ),
    dimension(
      "receipt",
      capability.receiptDigestVerification ? "satisfied" : "unsupported",
      capability.receiptDigestVerification
        ? "Every model request produces a body-free receipt binding the canonical and assembled-request digests."
        : "The surface cannot verify a delivery receipt digest.",
    ),
  );

  let grade: InstructionDeliveryPlan["grade"] = "full";
  if (dimensions.some((entry) => entry.status === "unsupported")) {
    grade = "unsupported";
  } else if (dimensions.some((entry) => entry.status === "compatible")) {
    grade = "compatible";
  }
  const blockingReasons = dimensions
    .filter((entry) => entry.status === "unsupported")
    .map((entry) => entry.detail);
  const requiresAcknowledgement = false;

  const createdAt = (input.now ?? new Date()).toISOString();
  const planIdentity = {
    resolutionId: resolution.resolutionId,
    canonicalDigest: resolution.canonicalDigest,
    environmentDigest: resolution.environmentDigest,
    providerId: resolution.providerId,
    surface: resolution.surface,
    grade,
    route: capability.mechanism,
    dimensions,
    capability,
  };
  return deepFreeze({
    schemaVersion: INSTRUCTION_DELIVERY_SCHEMA_VERSION,
    planId: `instruction-plan:${canonicalDigest(planIdentity)}`,
    resolutionId: resolution.resolutionId,
    canonicalDigest: resolution.canonicalDigest,
    environmentDigest: resolution.environmentDigest,
    providerId: resolution.providerId,
    surface: resolution.surface,
    grade,
    route: capability.mechanism,
    requiresAcknowledgement,
    blockingReasons,
    dimensions,
    capability,
    createdAt,
  }) as InstructionDeliveryPlan;
};

export const assertInstructionDeliveryAllowed = (
  _plan: InstructionDeliveryPlan,
): void => {
  // Delivery grades are informational. The frozen Machdoch envelope is the
  // source of truth and never requires user approval before execution.
};

export const assertInstructionInvocationBudget = (
  resolution: FrozenInstructionSet,
  input: {
    phase: InstructionDeliveryReceipt["phase"];
    assembledRequestBytes: number;
  },
): InstructionInvocationBudgetReport => {
  if (
    !Number.isSafeInteger(input.assembledRequestBytes) ||
    input.assembledRequestBytes < 0
  ) {
    throw new InstructionSystemError(
      "INSTRUCTION_INPUT_BUDGET_INVALID",
      "Instruction request preflight requires a non-negative assembled request byte count.",
    );
  }
  const estimatedEnvelopeTokens =
    resolution.budget.estimatedTokens ??
    estimateConservativeTokensFromUtf8Bytes(resolution.budget.envelopeBytes);
  const estimatedRuntimeSupplementTokens =
    resolution.budget.estimatedRuntimeSupplementTokens ??
    estimateConservativeTokensFromUtf8Bytes(
      resolution.budget.runtimeSupplementBytes ?? 0,
    );
  const estimatedInstructionTokens =
    estimatedEnvelopeTokens + estimatedRuntimeSupplementTokens;
  const estimatedAssembledTokens = estimateConservativeTokensFromUtf8Bytes(
    input.assembledRequestBytes,
  );
  const estimatedNonInstructionTokens = Math.max(
    0,
    estimatedAssembledTokens - estimatedInstructionTokens,
  );
  const estimatedRequiredInputTokens =
    estimatedInstructionTokens +
    estimatedNonInstructionTokens +
    INSTRUCTION_PROVIDER_RESERVE_TOKENS;
  const providerLimitTokens = resolution.budget.providerLimitTokens;
  if (
    providerLimitTokens !== undefined &&
    estimatedRequiredInputTokens > providerLimitTokens
  ) {
    throw new InstructionSystemError(
      "INSTRUCTION_INPUT_BUDGET_EXCEEDED",
      `The ${input.phase} request needs an estimated ${estimatedRequiredInputTokens} input tokens after retaining the complete instruction envelope and non-instruction context, but model ${resolution.model ?? "unknown"} exposes ${providerLimitTokens}. The provider was not invoked and instruction content was not truncated.`,
      [
        {
          code: "INSTRUCTION_INPUT_BUDGET_EXCEEDED",
          severity: "error",
          message:
            "Actual task, tool, conversation, or retry context outgrew the preflighted provider input capacity.",
          details: {
            phase: input.phase,
            assembledRequestBytes: input.assembledRequestBytes,
            estimatedEnvelopeTokens,
            estimatedRuntimeSupplementTokens,
            estimatedNonInstructionTokens,
            minimumReservedNonInstructionTokens:
              INSTRUCTION_PROVIDER_RESERVE_TOKENS,
            estimatedRequiredInputTokens,
            providerLimitTokens,
            canonicalDigest: resolution.canonicalDigest,
            truncation: "none",
          },
        },
      ],
    );
  }
  return {
    phase: input.phase,
    assembledRequestBytes: input.assembledRequestBytes,
    estimatedEnvelopeTokens,
    estimatedRuntimeSupplementTokens,
    estimatedNonInstructionTokens,
    minimumReservedNonInstructionTokens: INSTRUCTION_PROVIDER_RESERVE_TOKENS,
    estimatedRequiredInputTokens,
    ...(providerLimitTokens === undefined ? {} : { providerLimitTokens }),
  };
};

export const createInstructionDeliveryReceipt = (input: {
  plan: InstructionDeliveryPlan;
  phase: InstructionDeliveryReceipt["phase"];
  evidence: InstructionDeliveryReceipt["evidence"];
  observedCanonicalDigest?: string;
  assembledRequestDigest: string;
  indeterminateReason?: string;
  deliveredBytes?: number;
  estimatedTokens?: number;
  requestId?: string;
  now?: Date;
}): InstructionDeliveryReceipt => {
  const digestPattern = /^[0-9a-f]{64}$/u;
  const deliveredBytes = input.deliveredBytes ?? 0;
  const observedCanonicalDigest =
    input.observedCanonicalDigest ?? input.plan.canonicalDigest;
  const deliveredAt = input.now ?? new Date();
  const evidenceKinds = new Set([
    "request-field",
    "argument",
    "environment",
    "temporary-file",
  ]);
  if (
    input.evidence.length === 0 ||
    input.evidence.some(
      (entry) =>
        !evidenceKinds.has(entry.kind) ||
        entry.detail.trim().length === 0 ||
        (entry.digest !== undefined && !digestPattern.test(entry.digest)),
    )
  ) {
    throw new InstructionSystemError(
      "INSTRUCTION_DELIVERY_EVIDENCE_REQUIRED",
      "Instruction delivery receipts require at least one valid body-free transport evidence record.",
    );
  }
  if (
    !digestPattern.test(input.plan.canonicalDigest) ||
    !digestPattern.test(observedCanonicalDigest) ||
    !digestPattern.test(input.assembledRequestDigest) ||
    !Number.isSafeInteger(deliveredBytes) ||
    deliveredBytes < 0 ||
    (input.estimatedTokens !== undefined &&
      (!Number.isSafeInteger(input.estimatedTokens) ||
        input.estimatedTokens < 0)) ||
    (input.requestId !== undefined && input.requestId.trim().length === 0) ||
    (input.indeterminateReason !== undefined &&
      input.indeterminateReason.trim().length === 0) ||
    !Number.isFinite(deliveredAt.getTime())
  ) {
    throw new InstructionSystemError(
      "INSTRUCTION_DELIVERY_RECEIPT_INVALID",
      "Instruction delivery receipt metadata is malformed or outside its supported bounds.",
    );
  }
  const status =
    input.indeterminateReason === undefined &&
    observedCanonicalDigest === input.plan.canonicalDigest
      ? "delivered"
      : "indeterminate";
  const receipt = {
    schemaVersion: INSTRUCTION_DELIVERY_SCHEMA_VERSION,
    receiptId: randomUUID(),
    planId: input.plan.planId,
    resolutionId: input.plan.resolutionId,
    canonicalDigest: input.plan.canonicalDigest,
    providerId: input.plan.providerId,
    surface: input.plan.surface,
    phase: input.phase,
    route: input.plan.route,
    deliveredAt: deliveredAt.toISOString(),
    status,
    observedCanonicalDigest,
    assembledRequestDigest: input.assembledRequestDigest,
    deliveredBytes,
    ...(input.estimatedTokens === undefined
      ? {}
      : { estimatedTokens: input.estimatedTokens }),
    ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    truncation: "none",
    ...(status === "delivered"
      ? {}
      : {
          error:
            input.indeterminateReason ??
            "The adapter-reported canonical digest did not match the frozen delivery plan. The request may have been accepted; automatic replay is prohibited.",
        }),
    evidence: input.evidence.map((entry) => ({ ...entry })),
    bodyStored: false,
  };
  return deepFreeze(receipt) as InstructionDeliveryReceipt;
};

export const assertInstructionDeliveryReceiptCertain = (
  receipt: InstructionDeliveryReceipt,
  cause?: unknown,
): void => {
  if (receipt.status === "delivered") return;
  const causeMessage =
    cause instanceof Error
      ? cause.message
      : typeof cause === "string"
        ? cause
        : undefined;
  const deliveryMessage = `${receipt.error ?? "Instruction delivery could not be verified."} Do not automatically repeat a potentially mutating model or tool step.`;
  throw new InstructionSystemError(
    "DELIVERY_INDETERMINATE",
    causeMessage ? `${causeMessage} ${deliveryMessage}` : deliveryMessage,
    [],
    cause instanceof Error ? { cause } : undefined,
  );
};
