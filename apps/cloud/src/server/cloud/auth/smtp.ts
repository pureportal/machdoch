import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getCACertificates } from "node:tls";
import type { MailFailureCode } from "../../../lib/cloud-email-contract";
import type { SignInMail } from "./mail-store";
import type { SmtpConnection } from "./email-settings";

const NativeWorker = (
  process.getBuiltinModule(
    "worker_threads",
  ) as typeof import("node:worker_threads")
).Worker;
export class MailDeliveryError extends Error {
  constructor(readonly code: MailFailureCode) {
    super("Email delivery failed.");
  }
}
export type MailSender = (
  mail: SignInMail,
  signal: AbortSignal,
) => Promise<void>;

function run(
  input:
    | { kind: "send"; mail: SignInMail }
    | { kind: "verify"; connection: SmtpConnection },
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((done, reject) => {
    const worker = new NativeWorker(
      resolve(
        dirname(fileURLToPath(import.meta.url)),
        "../../../../dist/cloud-smtp-worker.mjs",
      ),
      {
        workerData: { ...input, ca: getCACertificates("default") },
        execArgv: [],
        env: process.env.SystemRoot
          ? { SystemRoot: process.env.SystemRoot }
          : {},
        resourceLimits: {
          maxOldGenerationSizeMb: 64,
          maxYoungGenerationSizeMb: 16,
          stackSizeMb: 4,
        },
        stdout: true,
        stderr: true,
      },
    );
    worker.stdout.resume();
    worker.stderr.resume();
    let settled = false;
    const timer = setTimeout(
      () => finish(new MailDeliveryError("timeout")),
      timeoutMs,
    );
    const aborted = () =>
      finish(
        signal?.reason instanceof Error
          ? signal.reason
          : new MailDeliveryError("failed"),
      );
    function finish(error?: Error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      void worker.terminate().then(
        () => (error ? reject(error) : done()),
        () => reject(new MailDeliveryError("failed")),
      );
    }
    worker.on("message", (value: unknown) => {
      if (
        value &&
        typeof value === "object" &&
        "ok" in value &&
        value.ok === true
      )
        finish();
      else {
        const code =
          value &&
          typeof value === "object" &&
          "code" in value &&
          [
            "authentication",
            "connection",
            "timeout",
            "recipient",
            "failed",
          ].includes(String(value.code))
            ? (value.code as MailFailureCode)
            : "failed";
        finish(new MailDeliveryError(code));
      }
    });
    worker.once("error", () => finish(new MailDeliveryError("failed")));
    worker.once("exit", () => {
      if (!settled) finish(new MailDeliveryError("failed"));
    });
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) aborted();
  });
}

export const sendSignInMail: MailSender = (mail, signal) =>
  run(
    { kind: "send", mail },
    Math.max(1, Math.min(20000, mail.remainingMs)),
    signal,
  );
export const verifySmtpConnection = (
  connection: SmtpConnection,
  signal?: AbortSignal,
): Promise<void> => run({ kind: "verify", connection }, 20000, signal);
