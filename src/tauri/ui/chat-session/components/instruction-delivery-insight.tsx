import type { JSX } from "react";

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const records = (value: unknown): UnknownRecord[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];

const text = (value: unknown, fallback = "unknown"): string =>
  typeof value === "string" && value.trim().length > 0 ? value : fallback;

const number = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const shortDigest = (value: unknown): string => {
  const digest = text(value);
  return digest.length > 18 ? `${digest.slice(0, 18)}…` : digest;
};

const sourceOrigin = (source: UnknownRecord): string =>
  typeof source.relativePath === "string"
    ? source.relativePath
    : typeof source.profileId === "string"
      ? `profile:${source.profileId}`
      : text(source.id);

const sourceAssignment = (source: UnknownRecord): string =>
  typeof source.assignmentPath === "string"
    ? source.assignmentPath
    : typeof source.inheritedFrom === "string"
      ? `inherited from ${source.inheritedFrom}`
      : "direct";

const statusClassName = (status: string): string => {
  switch (status) {
    case "delivered":
    case "satisfied":
    case "full":
      return "text-emerald-300";
    case "indeterminate":
    case "compatible":
      return "text-amber-300";
    case "unsupported":
      return "text-rose-300";
    default:
      return "text-slate-300";
  }
};

export interface InstructionDeliveryInsightProps {
  metadata: Record<string, unknown> | undefined;
}

export const InstructionDeliveryInsight = ({
  metadata,
}: InstructionDeliveryInsightProps): JSX.Element | null => {
  if (!metadata || typeof metadata.instructionResolutionId !== "string") {
    return null;
  }

  const sources = records(metadata.instructionSources);
  const nativeInventory = records(metadata.instructionNativeInventory);
  const mcpInitializationInstructions = records(
    metadata.instructionMcpInitializationInstructions,
  );
  const diagnostics = records(metadata.instructionDiagnostics);
  const plans = records(metadata.instructionDeliveryPlans);
  const receipts = records(metadata.instructionDeliveryReceipts);
  const deliveryGrade = text(metadata.instructionDeliveryGrade);
  const indeterminateCount = receipts.filter(
    (receipt) => receipt.status === "indeterminate",
  ).length;

  return (
    <details className="app-instruction-delivery-insight basis-full rounded-lg border border-cyan-400/20 bg-slate-950/75 px-3 py-2 text-xs text-slate-300">
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 font-semibold text-cyan-100 outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/50 [&::-webkit-details-marker]:hidden">
        <span>Delivered instructions</span>
        <span className={statusClassName(deliveryGrade)}>{deliveryGrade}</span>
        <span className="font-normal text-slate-500">
          {sources.length} source{sources.length === 1 ? "" : "s"} ·{" "}
          {receipts.length} receipt{receipts.length === 1 ? "" : "s"}
        </span>
        {indeterminateCount > 0 ? (
          <span className="font-normal text-amber-300">
            {indeterminateCount} indeterminate · automatic replay prohibited
          </span>
        ) : null}
      </summary>

      <div className="mt-3 grid gap-3 border-t border-slate-800 pt-3">
        <div className="grid gap-1 font-mono text-[10px] text-slate-400">
          <span>
            Immutable resolution: {text(metadata.instructionResolutionId)}
          </span>
          <span>
            Canonical digest:{" "}
            {text(metadata.instructionCanonicalDigest)}
          </span>
          <span>
            Environment digest:{" "}
            {text(metadata.instructionEnvironmentDigest)}
          </span>
          <span className="font-sans text-slate-500">
            Bodies are intentionally omitted from run metadata.
          </span>
        </div>

        <section className="grid gap-1.5">
          <h4 className="font-semibold text-slate-200">
            Effective source order
          </h4>
          {sources.length > 0 ? (
            <ol className="grid list-decimal gap-1 pl-5">
              {sources.map((source, index) => (
                <li
                  key={`${text(source.id, "source")}:${index}`}
                  className="pl-1 text-slate-400"
                >
                  <span className="text-slate-200">
                    {text(source.name, text(source.kind))}
                  </span>
                  {" · "}
                  {text(source.kind)}
                  {" · "}
                  scope {text(source.scopePath, ".")}
                  {" · "}
                  precedence {number(source.precedence) ?? "unknown"}
                  {" · "}
                  {source.trusted === true ? "trusted profile" : "repository-controlled"}
                  {" · "}
                  {number(source.byteLength) ?? 0} bytes
                  {" · "}
                  <span className="font-mono">
                    {shortDigest(source.digest)}
                  </span>
                  <span className="block text-[10px] text-slate-500">
                    origin {sourceOrigin(source)} · assignment{" "}
                    {sourceAssignment(source)}
                    {typeof source.reason === "string"
                      ? ` · ${source.reason}`
                      : ""}
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-slate-500">No persistent sources selected.</p>
          )}
        </section>

        <section className="grid gap-1.5">
          <h4 className="font-semibold text-slate-200">Provider plans</h4>
          {plans.map((plan, planIndex) => {
            const dimensions = records(plan.dimensions);
            const blockingReasons = Array.isArray(plan.blockingReasons)
              ? plan.blockingReasons.filter(
                  (value): value is string => typeof value === "string",
                )
              : [];
            return (
              <div
                key={`${text(plan.planId, "plan")}:${planIndex}`}
                className="rounded border border-slate-800 bg-slate-900/45 p-2"
              >
                <p>
                  <span className={statusClassName(text(plan.grade))}>
                    {text(plan.grade)}
                  </span>
                  {" · "}
                  {text(plan.providerId)}/{text(plan.surface)}
                  {" · "}
                  {text(plan.route)}
                </p>
                <ul className="mt-1 grid gap-0.5 text-[10px] text-slate-400">
                  {dimensions.map((dimension, dimensionIndex) => (
                    <li
                      key={`${text(dimension.name, "dimension")}:${dimensionIndex}`}
                    >
                      <span
                        className={statusClassName(text(dimension.status))}
                      >
                        {text(dimension.name)}: {text(dimension.status)}
                      </span>
                      {" — "}
                      {text(dimension.detail)}
                    </li>
                  ))}
                  {blockingReasons.map((reason) => (
                    <li key={reason} className="text-rose-300">
                      Blocked: {reason}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </section>

        {nativeInventory.length > 0 ? (
          <section className="grid gap-1.5">
            <h4 className="font-semibold text-slate-200">
              Provider-native inventory
            </h4>
            <ul className="grid gap-1 text-[10px] text-slate-400">
              {nativeInventory.map((record, index) => (
                <li
                  key={`${text(record.path, "native")}:${text(record.convention)}:${index}`}
                >
                  <span className={statusClassName(text(record.status))}>
                    {text(record.status)}
                  </span>
                  {" · "}
                  {text(record.convention)}
                  {" · "}
                  {text(record.path)}
                  {typeof record.note === "string" ? ` — ${record.note}` : ""}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {mcpInitializationInstructions.length > 0 ? (
          <section className="grid gap-1.5">
            <h4 className="font-semibold text-slate-200">
              MCP initialization hints
            </h4>
            <ul className="grid gap-1 text-[10px] text-slate-400">
              {mcpInitializationInstructions.map((record, index) => (
                <li key={`${text(record.digest, "mcp-hint")}:${index}`}>
                  servers{" "}
                  {Array.isArray(record.serverIds)
                    ? record.serverIds.filter(
                        (value): value is string =>
                          typeof value === "string",
                      ).join(", ")
                    : "unknown"}
                  {" · "}
                  {number(record.byteLength) ?? 0} bytes
                  {" · "}
                  <span className="font-mono">
                    {shortDigest(record.digest)}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section className="grid gap-1.5">
          <h4 className="font-semibold text-slate-200">Delivery receipts</h4>
          {receipts.length > 0 ? (
            <div className="grid gap-1.5">
              {receipts.map((receipt, receiptIndex) => (
                <div
                  key={`${text(receipt.receiptId, "receipt")}:${receiptIndex}`}
                  className="rounded border border-slate-800 bg-slate-900/45 p-2"
                >
                  <p>
                    <span className={statusClassName(text(receipt.status))}>
                      {text(receipt.status)}
                    </span>
                    {" · "}
                    {text(receipt.phase)}
                    {" · "}
                    {text(receipt.route)}
                    {" · "}
                    truncation {text(receipt.truncation)}
                  </p>
                  <p className="mt-1 font-mono text-[10px] text-slate-500">
                    canonical {shortDigest(receipt.canonicalDigest)} · request{" "}
                    {shortDigest(receipt.assembledRequestDigest)}
                  </p>
                  {typeof receipt.requestId === "string" ? (
                    <p className="mt-1 text-[10px] text-slate-400">
                      Provider request ID: {receipt.requestId}
                    </p>
                  ) : null}
                  {typeof receipt.error === "string" ? (
                    <p className="mt-1 text-[10px] text-amber-300">
                      {receipt.error}
                    </p>
                  ) : null}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-slate-500">
              No provider call was made, so no receipt exists.
            </p>
          )}
        </section>

        {diagnostics.length > 0 ? (
          <section className="grid gap-1.5">
            <h4 className="font-semibold text-slate-200">
              Resolution diagnostics
            </h4>
            <ul className="grid gap-1 text-[10px] text-slate-400">
              {diagnostics.map((diagnostic, index) => (
                <li key={`${text(diagnostic.code, "diagnostic")}:${index}`}>
                  [{text(diagnostic.severity)}] {text(diagnostic.code)} —{" "}
                  {text(diagnostic.message)}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </details>
  );
};
