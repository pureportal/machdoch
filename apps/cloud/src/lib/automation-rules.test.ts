import { describe, expect, it } from "vitest";
import { nextScheduledRun } from "./automation-schedule";
import { renderAutomationText } from "./automation-text";
import { issueChangeEvents, triggerMatchesEvent } from "./automation-triggers";
import {
  automationTemplates,
  type AutomationTemplateContext,
} from "./automation-templates";
import {
  automationInputSchema,
  type AutomationTrigger,
} from "./cloud-automation-contract";

const ids = {
  team: "00000000-0000-4000-8000-000000000001",
  triage: "00000000-0000-4000-8000-000000000002",
  active: "00000000-0000-4000-8000-000000000003",
  done: "00000000-0000-4000-8000-000000000004",
  label: "00000000-0000-4000-8000-000000000005",
  provider: "00000000-0000-4000-8000-000000000006",
  profile: "00000000-0000-4000-8000-000000000007",
  ready: "00000000-0000-4000-8000-000000000008",
  backlog: "00000000-0000-4000-8000-000000000009",
  review: "00000000-0000-4000-8000-00000000000a",
  canceled: "00000000-0000-4000-8000-00000000000b",
};

function schedule(
  frequency: "hourly" | "daily" | "weekdays" | "weekly",
  time: string,
  timeZone = "UTC",
  weekday = 1,
): Extract<AutomationTrigger, { kind: "schedule" }> {
  return {
    kind: "schedule",
    frequency,
    time,
    weekday,
    timeZone,
    forEachIssue: false,
  };
}

describe("nextScheduledRun", () => {
  it("runs later the same day when the time has not passed", () => {
    expect(
      new Date(
        nextScheduledRun(
          schedule("daily", "09:30"),
          Date.parse("2026-11-12T08:00:00Z"),
        ),
      ).toISOString(),
    ).toBe("2026-11-12T09:30:00.000Z");
  });

  it("moves to the next day once the time has passed", () => {
    expect(
      new Date(
        nextScheduledRun(
          schedule("daily", "09:30"),
          Date.parse("2026-11-12T09:30:00Z"),
        ),
      ).toISOString(),
    ).toBe("2026-11-13T09:30:00.000Z");
  });

  it("skips weekends for weekday schedules", () => {
    expect(
      new Date(
        nextScheduledRun(
          schedule("weekdays", "09:00"),
          Date.parse("2026-11-13T10:00:00Z"),
        ),
      ).toISOString(),
    ).toBe("2026-11-16T09:00:00.000Z");
  });

  it("uses the chosen weekday for weekly schedules", () => {
    expect(
      new Date(
        nextScheduledRun(
          schedule("weekly", "16:00", "UTC", 5),
          Date.parse("2026-11-13T16:00:00Z"),
        ),
      ).toISOString(),
    ).toBe("2026-11-20T16:00:00.000Z");
  });

  it("applies the time zone and its daylight saving offset", () => {
    expect(
      new Date(
        nextScheduledRun(
          schedule("daily", "09:00", "Europe/Berlin"),
          Date.parse("2026-07-01T00:00:00Z"),
        ),
      ).toISOString(),
    ).toBe("2026-07-01T07:00:00.000Z");
    expect(
      new Date(
        nextScheduledRun(
          schedule("daily", "09:00", "Europe/Berlin"),
          Date.parse("2026-12-01T00:00:00Z"),
        ),
      ).toISOString(),
    ).toBe("2026-12-01T08:00:00.000Z");
  });

  it("runs hourly at the chosen minute", () => {
    expect(
      new Date(
        nextScheduledRun(
          schedule("hourly", "00:15"),
          Date.parse("2026-11-12T08:20:10Z"),
        ),
      ).toISOString(),
    ).toBe("2026-11-12T09:15:00.000Z");
    expect(
      new Date(
        nextScheduledRun(
          schedule("hourly", "00:15", "Asia/Kolkata"),
          Date.parse("2026-11-12T08:20:00Z"),
        ),
      ).toISOString(),
    ).toBe("2026-11-12T08:45:00.000Z");
  });
});

describe("renderAutomationText", () => {
  it("replaces nested variables and serializes objects", () => {
    expect(
      renderAutomationText(
        "{{ issue.identifier }}: {{payload.alert.name}} {{missing}}\n{{payload.alert}}",
        {
          issue: { identifier: "PLAT-1" },
          payload: { alert: { name: "CPU" } },
        },
        200,
      ),
    ).toBe('PLAT-1: CPU \n{\n  "name": "CPU"\n}');
  });

  it("ignores inherited properties and truncates long output", () => {
    expect(
      renderAutomationText("{{issue.constructor}}x", { issue: {} }, 100),
    ).toBe("x");
    expect(renderAutomationText("abcdef", {}, 4)).toBe("abc…");
  });
});

describe("automation triggers", () => {
  const issue = {
    status: { id: ids.triage, revision: 1 },
    priority: "none" as const,
    assigneeId: null,
  };

  it("derives change events from issue snapshots", () => {
    expect(issueChangeEvents(null, issue)).toEqual([{ kind: "issue_created" }]);
    expect(
      issueChangeEvents(issue, {
        status: { id: ids.active, revision: 1 },
        priority: "urgent",
        assigneeId: ids.profile,
      }),
    ).toEqual([
      {
        kind: "status_changed",
        fromStatusId: ids.triage,
        toStatusId: ids.active,
      },
      { kind: "priority_changed", from: "none", to: "urgent" },
      { kind: "assignee_changed", from: null, to: ids.profile },
    ]);
    expect(issueChangeEvents(issue, issue)).toEqual([]);
  });

  it("matches trigger options", () => {
    const moved = {
      kind: "status_changed" as const,
      fromStatusId: ids.triage,
      toStatusId: ids.active,
    };
    expect(
      triggerMatchesEvent({ kind: "status_changed", statusIds: [] }, moved),
    ).toBe(true);
    expect(
      triggerMatchesEvent(
        { kind: "status_changed", statusIds: [ids.done] },
        moved,
      ),
    ).toBe(false);
    expect(triggerMatchesEvent({ kind: "issue_created" }, moved)).toBe(false);
    expect(
      triggerMatchesEvent(
        { kind: "comment_created", contains: "@Agent" },
        { kind: "comment_created", commentId: ids.label, body: "Hi @agent" },
      ),
    ).toBe(true);
    expect(
      triggerMatchesEvent(
        { kind: "label_added", labelIds: [ids.label] },
        { kind: "label_added", labelIds: [ids.done] },
      ),
    ).toBe(false);
    expect(
      triggerMatchesEvent(
        { kind: "pull_request_changed", stages: ["attention"] },
        {
          kind: "pull_request_changed",
          pullRequestId: ids.label,
          stage: "attention",
          title: "Fix",
          url: "https://github.com/o/r/pull/1",
        },
      ),
    ).toBe(true);
  });
});

describe("automation templates", () => {
  const context: AutomationTemplateContext = {
    teamId: ids.team,
    statuses: [
      { id: ids.triage, name: "Triage", category: "triage" },
      { id: ids.active, name: "In Progress", category: "active" },
      { id: ids.done, name: "Done", category: "complete" },
      { id: ids.ready, name: "Todo", category: "ready" },
      { id: ids.backlog, name: "Backlog", category: "backlog" },
      { id: ids.review, name: "In Review", category: "review" },
      { id: ids.canceled, name: "Canceled", category: "canceled" },
    ],
    labels: [{ id: ids.label, name: "Agent" }],
    agent: { providerId: ids.provider, model: "model" },
    profileId: ids.profile,
    productId: ids.provider,
    client: { instanceId: "instance-1", workspace: "/projects/example" },
    timeZone: "Europe/Berlin",
  };

  it("builds valid automations for a configured team", () => {
    for (const template of automationTemplates) {
      const draft = template.build(context);
      const result = automationInputSchema.safeParse(draft);
      expect(result.error?.issues ?? [], template.id).toEqual([]);
    }
  });

  it("uses matching team statuses and labels", () => {
    const delegate = automationTemplates
      .find((template) => template.id === "delegate-label")!
      .build(context);
    expect(delegate.trigger).toEqual({
      kind: "label_added",
      labelIds: [ids.label],
    });
    const assign = automationTemplates
      .find((template) => template.id === "assign-on-start")!
      .build(context);
    expect(assign.trigger).toEqual({
      kind: "status_changed",
      statusIds: [ids.active],
    });
  });

  it("rejects issue actions on schedules without issues", () => {
    const result = automationInputSchema.safeParse({
      name: "Digest",
      teamId: ids.team,
      trigger: schedule("daily", "09:00"),
      actions: [{ kind: "comment", body: "Hi" }],
    });
    expect(result.success).toBe(false);
  });
});

describe("release automations", () => {
  const writePosts = {
    kind: "write_release_posts",
    channelKinds: ["linkedin"],
    providerId: ids.provider,
    model: "model",
    minimumChanges: 5,
  };
  const parse = (input: Record<string, unknown>) =>
    automationInputSchema.safeParse({
      name: "Announce",
      teamId: ids.team,
      ...input,
    });

  it("writes posts for new releases without issue filters or issue actions", () => {
    expect(
      parse({
        trigger: { kind: "release_created" },
        actions: [writePosts],
      }).data,
    ).toMatchObject({
      trigger: { kind: "release_created", productIds: [] },
      actions: [{ measure: "issues", minimumChanges: 5, instructions: "" }],
    });
    expect(
      parse({
        trigger: { kind: "release_created" },
        conditions: [{ field: "priority", negated: false, values: ["high"] }],
        actions: [writePosts],
      }).success,
    ).toBe(false);
    expect(
      parse({
        trigger: { kind: "release_created" },
        actions: [{ kind: "comment", body: "Shipped" }],
      }).success,
    ).toBe(false);
  });

  it("needs a release before writing posts", () => {
    expect(
      parse({ trigger: { kind: "manual" }, actions: [writePosts] }).success,
    ).toBe(false);
    const prepare = {
      kind: "prepare_release",
      productId: ids.provider,
      version: "{{date}}",
    };
    expect(
      parse({ trigger: { kind: "manual" }, actions: [prepare, writePosts] })
        .success,
    ).toBe(true);
    expect(
      parse({
        trigger: { kind: "manual" },
        actions: [
          { ...prepare, providerId: ids.provider, model: "model" },
          writePosts,
        ],
      }).success,
    ).toBe(false);
  });
});
