import { z } from "zod";
import { cloudId } from "./cloud-contract";

export const requestChannels = ["email", "slack", "teams", "webhook"] as const;
export type RequestChannel = (typeof requestChannels)[number];

export const requestChannelLabels: Record<RequestChannel, string> = {
  email: "Email",
  slack: "Slack",
  teams: "Teams",
  webhook: "Webhook",
};

export interface RequestChannelState {
  channel: RequestChannel;
  enabled: boolean;
  configured: boolean;
  rotatedAt: string | null;
}

export interface RequestIntakeSettings {
  teamId: string | null;
  channels: RequestChannelState[];
}

export interface RequestChannelSecret {
  channel: RequestChannel;
  url: string;
  secret: string;
}

export interface CloudCustomer {
  id: string;
  name: string;
  domain: string | null;
  requestCount: number;
}

export interface CustomerRequest {
  id: string;
  issueId: string;
  customerId: string | null;
  customerName: string | null;
  channel: RequestChannel;
  requester: string;
  title: string;
  body: string;
  mentions: number;
  createdAt: string;
  lastReceivedAt: string;
}

export interface RequestIntakeResult extends Record<string, unknown> {
  issueId: string;
  requestId: string;
  created: boolean;
}

export const customerDomainPattern =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export const requestIntakeUpdateSchema = z.strictObject({ teamId: cloudId });
export const requestChannelUpdateSchema = z.strictObject({
  enabled: z.boolean(),
});
export const customerInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  domain: z
    .string()
    .trim()
    .toLowerCase()
    .max(253)
    .regex(customerDomainPattern, "Enter a domain like example.com.")
    .nullable()
    .default(null),
});
export type CustomerInput = z.infer<typeof customerInputSchema>;
export const customerRequestUpdateSchema = z.strictObject({
  customerId: cloudId.nullable(),
});
