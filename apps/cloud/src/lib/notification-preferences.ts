import { z } from "zod";
import { inboxKinds, type InboxKind } from "./cloud-inbox-contract";

export const notificationChannels = [
  "in_app",
  "email",
  "chat",
  "mobile",
] as const;
export type NotificationChannel = (typeof notificationChannels)[number];
export const deliveryChannels = ["email", "chat", "mobile"] as const;
export type DeliveryChannel = (typeof deliveryChannels)[number];

export const notificationChannelLabels: Record<NotificationChannel, string> = {
  in_app: "Inbox",
  email: "Email",
  chat: "Teams/Slack",
  mobile: "Mobile",
};

export const notificationEventLabels: Record<InboxKind, string> = {
  assigned: "Assigned to you",
  mentioned: "Mentions",
  commented: "Comments",
  status_changed: "Status changes",
  pull_request: "Pull requests",
  task_finished: "AI tasks",
  loop_input: "Loop input",
  loop_approval: "Loop approvals",
  loop_message: "Loop messages",
  sla_breached: "SLA breaches",
  project_update_due: "Project updates due",
  project_update_drafted: "Project update drafts",
};

const urgentKinds = new Set<InboxKind>([
  "assigned",
  "mentioned",
  "loop_input",
  "loop_approval",
  "sla_breached",
  "project_update_due",
]);

export function defaultNotificationPreference(
  kind: InboxKind,
  channel: NotificationChannel,
): boolean {
  if (channel === "in_app") return true;
  if (channel === "chat") return false;
  return urgentKinds.has(kind);
}

export interface NotificationPreferenceOverride {
  kind: InboxKind;
  channel: NotificationChannel;
  enabled: boolean;
}
export type NotificationPreferenceMatrix = Record<
  InboxKind,
  Record<NotificationChannel, boolean>
>;

export function notificationPreferenceMatrix(
  overrides: readonly NotificationPreferenceOverride[],
): NotificationPreferenceMatrix {
  const matrix = Object.fromEntries(
    inboxKinds.map((kind) => [
      kind,
      Object.fromEntries(
        notificationChannels.map((channel) => [
          channel,
          defaultNotificationPreference(kind, channel),
        ]),
      ),
    ]),
  ) as NotificationPreferenceMatrix;
  for (const override of overrides)
    matrix[override.kind][override.channel] = override.enabled;
  return matrix;
}

export interface QuietHours {
  start: number;
  end: number;
}
export interface NotificationSchedule {
  snoozedUntil: string | null;
  quietHours: QuietHours | null;
  timeZone: string;
}

export function validTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function localMinutes(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const value = (type: "hour" | "minute") =>
    Number(parts.find((part) => part.type === type)!.value);
  return value("hour") * 60 + value("minute");
}

function inQuietHours(minutes: number, { start, end }: QuietHours): boolean {
  return start < end
    ? minutes >= start && minutes < end
    : minutes >= start || minutes < end;
}

export function deliveryHold(
  at: Date,
  schedule: NotificationSchedule,
): Date | null {
  let release = at.getTime();
  if (schedule.snoozedUntil)
    release = Math.max(release, Date.parse(schedule.snoozedUntil));
  if (schedule.quietHours) {
    const minutes = localMinutes(new Date(release), schedule.timeZone);
    if (inQuietHours(minutes, schedule.quietHours)) {
      const wait = (schedule.quietHours.end - minutes + 1440) % 1440;
      release = Math.floor(release / 60_000) * 60_000 + wait * 60_000;
    }
  }
  return release > at.getTime() ? new Date(release) : null;
}

const chatWebhookHosts = [
  /^hooks\.slack\.com$/,
  /^[a-z0-9-]+\.webhook\.office\.com$/,
  /^[a-z0-9-]+\.[a-z0-9-]+\.logic\.azure\.com$/,
  /^[a-z0-9-]+\.[a-z0-9-]+\.environment\.api\.powerplatform\.com$/,
];
const pushServiceHosts = [
  /^fcm\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /^[a-z0-9-]+\.notify\.windows\.com$/,
  /^web\.push\.apple\.com$/,
];

function httpsHostMatches(value: string, hosts: readonly RegExp[]): boolean {
  const url = URL.parse(value);
  return (
    !!url &&
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    hosts.some((host) => host.test(url.hostname))
  );
}

export function chatWebhookAllowed(url: string): boolean {
  return httpsHostMatches(url, chatWebhookHosts);
}

export function pushEndpointAllowed(url: string): boolean {
  return httpsHostMatches(url, pushServiceHosts);
}

const minuteOfDay = z.number().int().min(0).max(1439);
const base64Url = (length: number) =>
  z
    .string()
    .length(length)
    .regex(/^[A-Za-z0-9_-]+$/);

export const notificationPreferenceUpdateSchema = z.strictObject({
  kind: z.enum(inboxKinds),
  channel: z.enum(notificationChannels),
  enabled: z.boolean(),
});
export const notificationScheduleSchema = z.strictObject({
  snoozedUntil: z.iso.datetime({ offset: true }).nullable(),
  quietHours: z
    .strictObject({ start: minuteOfDay, end: minuteOfDay })
    .refine((hours) => hours.start !== hours.end, {
      message: "Quiet hours must start and end at different times.",
    })
    .nullable(),
  timeZone: z
    .string()
    .min(1)
    .max(64)
    .refine(validTimeZone, { message: "Choose a valid time zone." }),
});
export const chatTargetSchema = z.strictObject({
  url: z
    .url()
    .max(2_000)
    .refine(chatWebhookAllowed, {
      message: "Use a Slack or Microsoft Teams incoming webhook address.",
    })
    .nullable(),
});
export const pushSubscriptionSchema = z.strictObject({
  endpoint: z.url().max(2_000).refine(pushEndpointAllowed, {
    message: "This browser's push service is not supported.",
  }),
  keys: z.strictObject({ p256dh: base64Url(87), auth: base64Url(22) }),
  label: z.string().trim().min(1).max(80),
});

export interface NotificationDevice {
  id: string;
  label: string;
  createdAt: string;
}

export interface NotificationSettings {
  preferences: NotificationPreferenceMatrix;
  schedule: NotificationSchedule;
  chatHost: string | null;
  emailAvailable: boolean;
  devices: NotificationDevice[];
}
