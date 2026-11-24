import {
  customerDomainPattern,
  type RequestChannel,
} from "./cloud-customer-request-contract";
import { firstText, type Path } from "./loop-source-events";

export interface ParsedCustomerRequest {
  title: string;
  body: string;
  requester: string;
  externalId: string | null;
  customer: { name: string; domain: string | null } | null;
}

const channelPaths: Record<
  RequestChannel,
  {
    title: readonly Path[];
    body: readonly Path[];
    requester: readonly Path[];
    externalId: readonly Path[];
  }
> = {
  email: {
    title: [["subject"]],
    body: [["text"], ["body"], ["html"]],
    requester: [["from", "address"], ["from", "email"], ["from"]],
    externalId: [["messageId"], ["message_id"], ["headers", "message-id"]],
  },
  slack: {
    title: [],
    body: [["event", "text"], ["text"]],
    requester: [["event", "user"], ["user_name"], ["user_id"]],
    externalId: [["event", "client_msg_id"], ["event_id"], ["event", "ts"]],
  },
  teams: {
    title: [],
    body: [["text"], ["body", "content"]],
    requester: [
      ["from", "user", "displayName"],
      ["from", "name"],
    ],
    externalId: [["id"]],
  },
  webhook: {
    title: [["title"]],
    body: [["body"], ["description"]],
    requester: [["requester"], ["email"]],
    externalId: [["externalId"], ["id"]],
  },
};

function plainText(text: string): string {
  return text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .trim();
}

function webhookCustomer(payload: unknown): ParsedCustomerRequest["customer"] {
  const name = firstText(payload, [["customer", "name"], ["customer"]]);
  if (!name) return null;
  const domain = firstText(payload, [["customer", "domain"]]).toLowerCase();
  return {
    name: name.slice(0, 120),
    domain: customerDomainPattern.test(domain) ? domain : null,
  };
}

export function parseCustomerRequest(
  channel: RequestChannel,
  payload: unknown,
): ParsedCustomerRequest | null {
  const paths = channelPaths[channel];
  const body = plainText(firstText(payload, paths.body)).slice(0, 10_000);
  const title = (
    firstText(payload, paths.title) ||
    body.split("\n", 1)[0] ||
    ""
  ).slice(0, 300);
  if (!title) return null;
  return {
    title,
    body,
    requester: firstText(payload, paths.requester).slice(0, 320),
    externalId: firstText(payload, paths.externalId).slice(0, 300) || null,
    customer: channel === "webhook" ? webhookCustomer(payload) : null,
  };
}

export function requestFingerprint(title: string): string {
  let text = title.toLowerCase().trim();
  for (;;) {
    const stripped = text.replace(/^(re|fwd?|aw|wg)\s*:\s*/, "");
    if (stripped === text) break;
    text = stripped;
  }
  return text
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .slice(0, 200);
}

export function requesterDomain(requester: string): string | null {
  const domain = /@([^\s@<>]+?)>?$/.exec(requester.trim())?.[1]?.toLowerCase();
  return domain && customerDomainPattern.test(domain) ? domain : null;
}
