import type { IntakeSource } from "./cloud-automation-contract";

export interface SourceEventContent {
  title: string;
  body: string;
}

type Path = readonly (string | number)[];

function textAt(payload: unknown, path: Path): string | null {
  let value: unknown = payload;
  for (const key of path) {
    if (value === null || typeof value !== "object") return null;
    value = (value as Record<string | number, unknown>)[key];
  }
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function firstText(payload: unknown, paths: readonly Path[]): string {
  for (const path of paths) {
    const text = textAt(payload, path);
    if (text) return text;
  }
  return "";
}

const sourcePaths: Record<
  IntakeSource,
  { title: readonly Path[]; body: readonly Path[] }
> = {
  email: {
    title: [["subject"]],
    body: [["text"], ["body"], ["html"]],
  },
  sentry: {
    title: [
      ["data", "issue", "title"],
      ["data", "event", "title"],
      ["message"],
    ],
    body: [["data", "issue", "culprit"], ["data", "event", "culprit"], ["url"]],
  },
  grafana: {
    title: [["title"], ["alerts", 0, "labels", "alertname"]],
    body: [["message"], ["alerts", 0, "annotations", "summary"]],
  },
  teams: {
    title: [
      ["from", "user", "displayName"],
      ["from", "name"],
    ],
    body: [["text"], ["body", "content"]],
  },
  slack: {
    title: [["event", "user"], ["user_name"]],
    body: [["event", "text"], ["text"]],
  },
};

export function sourceEventContent(
  source: IntakeSource,
  payload: unknown,
): SourceEventContent {
  const paths = sourcePaths[source];
  const body = firstText(payload, paths.body).slice(0, 10_000);
  const title =
    firstText(payload, paths.title) || body.split("\n", 1)[0] || source;
  return { title: title.slice(0, 300), body };
}
