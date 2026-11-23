import { describe, expect, it } from "vitest";
import { sourceEventContent } from "./loop-source-events";

describe("loop source events", () => {
  it("reads the title and body each intake source sends", () => {
    expect(
      sourceEventContent("email", {
        subject: " Invoice overdue ",
        text: "Please pay.",
      }),
    ).toEqual({ title: "Invoice overdue", body: "Please pay." });
    expect(
      sourceEventContent("sentry", {
        data: {
          issue: { title: "TypeError: x is undefined", culprit: "app.ts" },
        },
      }),
    ).toEqual({ title: "TypeError: x is undefined", body: "app.ts" });
    expect(
      sourceEventContent("grafana", {
        alerts: [
          {
            labels: { alertname: "HighLatency" },
            annotations: { summary: "p95 above 2s" },
          },
        ],
      }),
    ).toEqual({ title: "HighLatency", body: "p95 above 2s" });
    expect(
      sourceEventContent("teams", {
        from: { user: { displayName: "Ada" } },
        body: { content: "Deploy is stuck" },
      }),
    ).toEqual({ title: "Ada", body: "Deploy is stuck" });
    expect(
      sourceEventContent("slack", {
        event: { user: "U1", text: "Build failed" },
      }),
    ).toEqual({ title: "U1", body: "Build failed" });
  });

  it("falls back to the first body line or the source name and limits length", () => {
    expect(
      sourceEventContent("email", { text: "First line\nSecond line" }),
    ).toEqual({ title: "First line", body: "First line\nSecond line" });
    expect(sourceEventContent("grafana", null)).toEqual({
      title: "grafana",
      body: "",
    });
    const long = sourceEventContent("email", {
      subject: "s".repeat(400),
      text: "b".repeat(12_000),
    });
    expect(long.title).toHaveLength(300);
    expect(long.body).toHaveLength(10_000);
  });
});
