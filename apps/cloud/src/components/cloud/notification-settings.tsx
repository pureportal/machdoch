"use client";

import { BellRing, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { Field } from "@/components/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  notificationChannelLabels,
  notificationChannels,
  notificationEventGroups,
  notificationEventLabels,
  type NotificationDevice,
  type NotificationSchedule,
  type NotificationSettings,
} from "@/lib/notification-preferences";
import { cloudRequest } from "./api-client";
import { useToast } from "./toast";

const snoozeOptions = [
  { minutes: 60, label: "1 hour" },
  { minutes: 240, label: "4 hours" },
  { minutes: 1440, label: "1 day" },
  { minutes: 10080, label: "1 week" },
];

function useAction() {
  const router = useRouter();
  const toast = useToast();
  const [pending, setPending] = useState("");
  async function run(key: string, action: () => Promise<unknown>) {
    setPending(key);
    try {
      await action();
      router.refresh();
      return true;
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "Try again.", "error");
      return false;
    } finally {
      setPending("");
    }
  }
  return { pending, run };
}

function clockTime(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function clockMinutes(value: string): number {
  const [hours, minutes] = value.split(":").map(Number);
  return hours! * 60 + minutes!;
}

function deviceLabel(): string {
  const agent = navigator.userAgent;
  const browser = /Edg\//.test(agent)
    ? "Edge"
    : /Firefox\//.test(agent)
      ? "Firefox"
      : /Chrome\//.test(agent)
        ? "Chrome"
        : "Safari";
  const system = /Android/.test(agent)
    ? "Android"
    : /iPhone|iPad/.test(agent)
      ? "iOS"
      : /Windows/.test(agent)
        ? "Windows"
        : /Mac OS/.test(agent)
          ? "macOS"
          : "Linux";
  return `${browser} on ${system}`;
}

export function NotificationSettingsPanel({
  settings,
  timeZones,
}: {
  settings: NotificationSettings;
  timeZones: string[];
}) {
  return (
    <div className="cloud-settings">
      <PreferenceMatrix settings={settings} />
      <ScheduleSettings schedule={settings.schedule} timeZones={timeZones} />
      <ChatTarget host={settings.chatHost} />
      <Devices devices={settings.devices} />
    </div>
  );
}

function PreferenceMatrix({ settings }: { settings: NotificationSettings }) {
  const { pending, run } = useAction();
  return (
    <section
      className="cloud-settings-section"
      aria-labelledby="notification-events"
    >
      <header>
        <h2 id="notification-events">Events</h2>
      </header>
      <table className="cloud-notification-matrix">
        <thead>
          <tr>
            <th scope="col">Event</th>
            {notificationChannels.map((channel) => (
              <th key={channel} scope="col">
                {notificationChannelLabels[channel]}
              </th>
            ))}
          </tr>
        </thead>
        {notificationEventGroups.map((group) => (
          <tbody key={group.label}>
            <tr className="cloud-notification-group">
              <th scope="colgroup" colSpan={notificationChannels.length + 1}>
                {group.label}
              </th>
            </tr>
            {group.kinds.map((kind) => (
              <tr key={kind}>
                <th scope="row">{notificationEventLabels[kind]}</th>
                {notificationChannels.map((channel) => {
                  const key = `${kind}:${channel}`;
                  const unavailable =
                    channel === "email" && !settings.emailAvailable;
                  return (
                    <td key={channel}>
                      <input
                        type="checkbox"
                        aria-label={`${notificationEventLabels[kind]} by ${notificationChannelLabels[channel]}`}
                        title={
                          unavailable
                            ? "Email is not set up for this workspace"
                            : undefined
                        }
                        checked={
                          !unavailable && settings.preferences[kind][channel]
                        }
                        disabled={unavailable || pending === key}
                        onChange={(event) => {
                          const enabled = event.target.checked;
                          void run(key, () =>
                            cloudRequest("notification-settings/preferences", {
                              method: "PUT",
                              body: { kind, channel, enabled },
                            }),
                          );
                        }}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        ))}
      </table>
    </section>
  );
}

function ScheduleSettings({
  schedule,
  timeZones,
}: {
  schedule: NotificationSchedule;
  timeZones: string[];
}) {
  const { pending, run } = useAction();
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => setNow(Date.now()), []);
  const snoozed =
    now !== null &&
    schedule.snoozedUntil !== null &&
    Date.parse(schedule.snoozedUntil) > now;
  function save(next: NotificationSchedule) {
    void run("schedule", () =>
      cloudRequest("notification-settings/schedule", {
        method: "PUT",
        body: next,
      }),
    );
  }
  const quietHours = schedule.quietHours;
  return (
    <section
      className="cloud-settings-section"
      aria-labelledby="notification-schedule"
    >
      <header>
        <h2 id="notification-schedule">Schedule</h2>
      </header>
      <div className="cloud-notification-snooze">
        <Field label="Snooze" htmlFor="notification-snooze">
          <Select
            id="notification-snooze"
            value={snoozed ? "current" : ""}
            disabled={pending === "schedule"}
            onChange={(event) => {
              const minutes = Number(event.target.value);
              save({
                ...schedule,
                snoozedUntil: minutes
                  ? new Date(Date.now() + minutes * 60_000).toISOString()
                  : null,
              });
            }}
          >
            <option value="">Off</option>
            {snoozed && (
              <option value="current" disabled>
                {`Until ${new Date(schedule.snoozedUntil!).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}`}
              </option>
            )}
            {snoozeOptions.map((option) => (
              <option key={option.minutes} value={option.minutes}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="cloud-loop-switch-row">
        <span id="notification-quiet-hours">Quiet hours</span>
        <button
          type="button"
          role="switch"
          className="cloud-automation-switch"
          aria-checked={quietHours !== null}
          aria-labelledby="notification-quiet-hours"
          disabled={pending === "schedule"}
          onClick={() =>
            save({
              ...schedule,
              quietHours:
                quietHours === null ? { start: 22 * 60, end: 7 * 60 } : null,
              timeZone:
                quietHours === null
                  ? Intl.DateTimeFormat().resolvedOptions().timeZone
                  : schedule.timeZone,
            })
          }
        />
      </div>
      {quietHours && (
        <div className="cloud-notification-quiet-hours">
          <Field label="From" htmlFor="notification-quiet-start">
            <Input
              id="notification-quiet-start"
              type="time"
              required
              defaultValue={clockTime(quietHours.start)}
              disabled={pending === "schedule"}
              onBlur={(event) => {
                const start = clockMinutes(event.target.value);
                if (start !== quietHours.start)
                  save({ ...schedule, quietHours: { ...quietHours, start } });
              }}
            />
          </Field>
          <Field label="To" htmlFor="notification-quiet-end">
            <Input
              id="notification-quiet-end"
              type="time"
              required
              defaultValue={clockTime(quietHours.end)}
              disabled={pending === "schedule"}
              onBlur={(event) => {
                const end = clockMinutes(event.target.value);
                if (end !== quietHours.end)
                  save({ ...schedule, quietHours: { ...quietHours, end } });
              }}
            />
          </Field>
          <Field label="Time zone" htmlFor="notification-time-zone">
            <Select
              id="notification-time-zone"
              value={schedule.timeZone}
              disabled={pending === "schedule"}
              onChange={(event) =>
                save({ ...schedule, timeZone: event.target.value })
              }
            >
              {timeZones.map((zone) => (
                <option key={zone} value={zone}>
                  {zone}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      )}
    </section>
  );
}

function ChatTarget({ host }: { host: string | null }) {
  const { pending, run } = useAction();
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const url = String(new FormData(form).get("url") ?? "").trim();
    if (
      await run("chat", () =>
        cloudRequest("notification-settings/chat", {
          method: "PUT",
          body: { url },
        }),
      )
    )
      form.reset();
  }
  return (
    <section
      className="cloud-settings-section"
      aria-labelledby="notification-chat"
    >
      <header>
        <h2 id="notification-chat">Teams/Slack</h2>
        {host && (
          <Button
            variant="ghost"
            size="sm"
            disabled={pending === "chat"}
            onClick={() =>
              void run("chat", () =>
                cloudRequest("notification-settings/chat", {
                  method: "PUT",
                  body: { url: null },
                }),
              )
            }
          >
            <Trash2 />
            Remove {host}
          </Button>
        )}
      </header>
      <form
        className="cloud-customer-form cloud-notification-chat"
        onSubmit={(event) => void save(event)}
      >
        <Field label="Incoming webhook URL" htmlFor="notification-chat-url">
          <Input
            id="notification-chat-url"
            name="url"
            type="url"
            required
            maxLength={2000}
            placeholder="https://hooks.slack.com/services/…"
          />
        </Field>
        <Button type="submit" variant="outline" disabled={pending === "chat"}>
          Save
        </Button>
      </form>
    </section>
  );
}

function Devices({ devices }: { devices: NotificationDevice[] }) {
  const { pending, run } = useAction();
  const [permission, setPermission] = useState<
    NotificationPermission | "unsupported" | null
  >(null);
  useEffect(
    () =>
      setPermission(
        "serviceWorker" in navigator && "PushManager" in window
          ? Notification.permission
          : "unsupported",
      ),
    [],
  );
  async function enable() {
    const granted = await Notification.requestPermission();
    setPermission(granted);
    if (granted !== "granted")
      throw new Error("Allow notifications for this site to continue.");
    const registration = await navigator.serviceWorker.register(
      "/notification-worker.js",
    );
    await navigator.serviceWorker.ready;
    const { publicKey } = await cloudRequest<{ publicKey: string }>(
      "notification-settings/push-key",
    );
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: Uint8Array.from(
        atob(publicKey.replaceAll("-", "+").replaceAll("_", "/")),
        (character) => character.charCodeAt(0),
      ),
    });
    const { endpoint, keys } = subscription.toJSON();
    await cloudRequest("notification-settings/devices", {
      method: "POST",
      body: { endpoint, keys, label: deviceLabel() },
    });
  }
  return (
    <section
      className="cloud-settings-section"
      aria-labelledby="notification-devices"
    >
      <header>
        <h2 id="notification-devices">Devices</h2>
        {permission !== null && permission !== "unsupported" && (
          <Button
            variant="outline"
            size="sm"
            disabled={permission === "denied" || pending === "enable"}
            title={
              permission === "denied"
                ? "Notifications are blocked in this browser"
                : undefined
            }
            onClick={() => void run("enable", enable)}
          >
            <BellRing />
            Turn on for this device
          </Button>
        )}
      </header>
      {devices.length === 0 ? (
        <p className="cloud-settings-empty">No devices</p>
      ) : (
        <ul className="cloud-member-list">
          {devices.map((device) => (
            <li key={device.id}>
              <div>
                <strong>{device.label}</strong>
              </div>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Remove ${device.label}`}
                disabled={pending === device.id}
                onClick={() =>
                  void run(device.id, () =>
                    cloudRequest(`notification-settings/devices/${device.id}`, {
                      method: "DELETE",
                    }),
                  )
                }
              >
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
