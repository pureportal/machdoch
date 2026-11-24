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
export interface OutgoingMail {
  connection: SmtpConnection;
  senderName: string;
  recipient: string;
  messageId: string;
  subject: string;
  text: string;
}

function run(
  input:
    | { kind: "send"; mail: OutgoingMail }
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
    {
      kind: "send",
      mail: {
        connection: mail.connection,
        senderName: mail.organization,
        recipient: mail.recipient,
        messageId: mail.messageId,
        subject: `Sign in to ${mail.organization}`,
        text: `Open this link to review and confirm your sign-in:\n\n${mail.url}\n\n${mail.connectionFlow ? "To finish connecting the app, open this link on the device where you started.\n\n" : ""}This link is valid for 10 minutes after it was requested. If you did not request it, ignore this email.`,
      },
    },
    Math.max(1, Math.min(20000, mail.remainingMs)),
    signal,
  );
export const sendMail = (
  mail: OutgoingMail,
  signal: AbortSignal,
): Promise<void> => run({ kind: "send", mail }, 20000, signal);
export const verifySmtpConnection = (
  connection: SmtpConnection,
  signal?: AbortSignal,
): Promise<void> => run({ kind: "verify", connection }, 20000, signal);
