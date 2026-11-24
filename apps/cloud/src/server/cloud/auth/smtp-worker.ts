import { parentPort, workerData } from "node:worker_threads";
import nodemailer from "nodemailer";
import type { SmtpConnection } from "./email-settings";
import type { OutgoingMail } from "./smtp";
import type { MailFailureCode } from "../../../lib/cloud-email-contract";

const input = workerData as
  | { kind: "verify"; connection: SmtpConnection; ca: string[] }
  | { kind: "send"; mail: OutgoingMail; ca: string[] };
const connection =
  input.kind === "send" ? input.mail.connection : input.connection;
const transport = nodemailer.createTransport({
  host: connection.host,
  port: connection.port,
  secure: connection.security === "tls",
  requireTLS: connection.security === "starttls",
  tls: {
    servername: connection.tlsName ?? connection.host,
    ca: input.ca,
    minVersion: "TLSv1.2",
    rejectUnauthorized: true,
  },
  ...(connection.username && connection.password
    ? { auth: { user: connection.username, pass: connection.password } }
    : {}),
  connectionTimeout: 10000,
  greetingTimeout: 5000,
  socketTimeout: 10000,
  dnsTimeout: 5000,
  disableFileAccess: true,
  disableUrlAccess: true,
  logger: false,
  debug: false,
});
try {
  if (input.kind === "verify") await transport.verify();
  else {
    const mail = input.mail;
    const result = await transport.sendMail({
      from: { address: connection.from, name: mail.senderName },
      to: mail.recipient,
      messageId: mail.messageId,
      subject: mail.subject,
      text: mail.text,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    if (result.rejected.length || result.accepted.length !== 1)
      throw Object.assign(new Error("Recipient rejected"), {
        code: "EENVELOPE",
      });
  }
  parentPort!.postMessage({ ok: true });
} catch (error) {
  const code =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "";
  const failure: MailFailureCode =
    code === "EAUTH"
      ? "authentication"
      : code === "ETIMEDOUT"
        ? "timeout"
        : ["ECONNECTION", "ESOCKET", "EDNS"].includes(code)
          ? "connection"
          : code === "EENVELOPE"
            ? "recipient"
            : "failed";
  parentPort!.postMessage({ ok: false, code: failure });
} finally {
  transport.close();
}
