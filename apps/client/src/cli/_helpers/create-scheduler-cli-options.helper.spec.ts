import { createSchedulerCliOptions } from "./create-scheduler-cli-options.helper.ts";

describe("create scheduler CLI options", () => {
  it("builds scheduler create options with strings, arrays, numbers, and toggles", () => {
    expect(
      createSchedulerCliOptions({
        action: "create",
        rawSubject: " job-one ",
        rawSchedulerName: "daily review",
        rawSchedulerIntervalMs: "1000",
        rawSchedulerPrompt: "review changes",
        rawSchedulerTriggers: ["git.push"],
        rawSchedulerTriggerFilters: ["branch=main"],
        rawSchedulerTriggerRecoveryFilters: ["branch=release"],
        rawSchedulerTriggerFiringMode: "latest",
        rawSchedulerTriggerCooldownMs: "10",
        rawSchedulerTriggerRepeatMs: "20",
        rawSchedulerTriggerDebounceMs: "30",
        rawSchedulerTriggerDedupeKeyTemplate: "{{id}}",
        rawSchedulerTriggerMaxEvents: "5",
        rawSchedulerTriggerWindowMs: "60",
        rawSchedulerTimezone: "UTC",
        rawSchedulerContextPacks: ["repo"],
        rawSchedulerMacros: ["prepare"],
        rawSchedulerMissedRunPolicy: "run-latest",
        rawSchedulerMissedRunGraceMs: "40",
        rawSchedulerRetryAttempts: "2",
        rawSchedulerRetryMinMs: "50",
        rawSchedulerRetryMaxMs: "500",
        rawSchedulerRetryFactor: "0.5",
        rawSchedulerRetryRandomize: "on",
        rawSchedulerDedupeKey: "job-one",
        rawSchedulerTtlMs: "600",
        rawSchedulerMaxDurationMs: "700",
        rawSchedulerConcurrencyKey: "scheduler",
        rawSchedulerConcurrencyLimit: "1",
        rawSchedulerHistoryLimit: "25",
        rawSchedulerMaxCatchUpRuns: "3",
      }),
    ).toEqual({
      action: "create",
      subject: "job-one",
      name: "daily review",
      intervalMs: 1000,
      prompt: "review changes",
      triggers: ["git.push"],
      triggerFilters: ["branch=main"],
      triggerRecoveryFilters: ["branch=release"],
      triggerFiringMode: "latest",
      triggerCooldownMs: 10,
      triggerRepeatMs: 20,
      triggerDebounceMs: 30,
      triggerDedupeKeyTemplate: "{{id}}",
      triggerMaxEvents: 5,
      triggerWindowMs: 60,
      timezone: "UTC",
      contextPacks: ["repo"],
      macros: ["prepare"],
      missedRunPolicy: "run-latest",
      missedRunGraceMs: 40,
      retryAttempts: 2,
      retryMinMs: 50,
      retryMaxMs: 500,
      retryFactor: 0.5,
      retryRandomize: true,
      dedupeKey: "job-one",
      ttlMs: 600,
      maxDurationMs: 700,
      concurrencyKey: "scheduler",
      concurrencyLimit: 1,
      historyLimit: 25,
      maxCatchUpRuns: 3,
    });
  });

  it("omits empty arrays and undefined optional fields", () => {
    expect(
      createSchedulerCliOptions({
        action: "list",
        rawSchedulerTriggers: [],
        rawSchedulerTriggerFilters: [],
        rawSchedulerTriggerRecoveryFilters: [],
        rawSchedulerContextPacks: [],
        rawSchedulerMacros: [],
      }),
    ).toEqual({ action: "list" });
  });

  it("builds scheduler event payload options", () => {
    expect(
      createSchedulerCliOptions({
        action: "event",
        rawSchedulerEventType: "github",
        rawSchedulerEventKind: "push",
        rawSchedulerEventSource: "repo",
        rawSchedulerEventPayloadJson: "{}",
        rawSchedulerEventDedupeKey: "abc",
        rawSchedulerEventOccurredAt: "123",
      }),
    ).toEqual({
      action: "event",
      eventType: "github",
      eventKind: "push",
      eventSource: "repo",
      eventPayloadJson: "{}",
      eventDedupeKey: "abc",
      eventOccurredAt: 123,
    });
  });

  it("parses the unattended scheduled RALPH profile", () => {
    expect(
      createSchedulerCliOptions({
        action: "create",
        rawSchedulerIntervalMs: "1000",
        rawSchedulerTarget: "ralph-flow",
        rawScheduledRalphFlow: "autonomous-improvement",
        rawScheduledRalphProfile: "unattended",
        rawScheduledRalphResumePolicy: "recoverable",
      }),
    ).toEqual({
      action: "create",
      intervalMs: 1000,
      schedulerTarget: "ralph-flow",
      scheduledRalphFlow: "autonomous-improvement",
      scheduledRalphProfile: "unattended",
      scheduledRalphResumePolicy: "recoverable",
    });

    expect(() =>
      createSchedulerCliOptions({
        action: "create",
        rawSchedulerIntervalMs: "1000",
        rawSchedulerTarget: "ralph-flow",
        rawScheduledRalphFlow: "autonomous-improvement",
        rawScheduledRalphProfile: "unsafe",
      }),
    ).toThrow("Expected --scheduled-ralph-profile to be unattended.");

    expect(() =>
      createSchedulerCliOptions({
        action: "create",
        rawSchedulerIntervalMs: "1000",
        rawSchedulerTarget: "ralph-flow",
        rawScheduledRalphFlow: "autonomous-improvement",
        rawScheduledRalphResumePolicy: "always",
      }),
    ).toThrow(
      "Expected --scheduled-ralph-resume-policy to be never or recoverable.",
    );

    expect(
      createSchedulerCliOptions({
        action: "create",
        rawSchedulerIntervalMs: "1000",
        rawSchedulerTarget: "ralph-flow",
        rawScheduledRalphFlow: "autonomous-improvement",
        rawScheduledRalphProfile: "unattended",
        rawScheduledRalphResumePolicy: "never",
      }),
    ).toMatchObject({
      scheduledRalphProfile: "unattended",
      scheduledRalphResumePolicy: "never",
    });
  });

  it("rejects invalid create schedule combinations and missing prompt input", () => {
    expect(() =>
      createSchedulerCliOptions({
        action: "create",
        rawSchedulerCron: "* * * * *",
        rawSchedulerIntervalMs: "1000",
        rawSchedulerPrompt: "run",
      }),
    ).toThrow(
      "`machdoch scheduler create` expects at most one of --cron, --interval-ms, or --delay-ms/--run-at.",
    );

    expect(() =>
      createSchedulerCliOptions({
        action: "create",
        rawSchedulerPrompt: "run",
      }),
    ).toThrow(
      "`machdoch scheduler create` expects --cron, --interval-ms, --delay-ms/--run-at, or --trigger.",
    );

    expect(() =>
      createSchedulerCliOptions({
        action: "create",
        rawSchedulerIntervalMs: "1000",
      }),
    ).toThrow("`machdoch scheduler create` expects --prompt or --prompt-file.");
  });

  it("rejects missing event type and invalid numeric or toggle values", () => {
    expect(() =>
      createSchedulerCliOptions({
        action: "event",
      }),
    ).toThrow("`machdoch scheduler event` expects --event-type.");

    expect(() =>
      createSchedulerCliOptions({
        action: "list",
        rawSchedulerTtlMs: "0",
      }),
    ).toThrow("Expected --ttl-ms to be followed by a positive integer.");

    expect(() =>
      createSchedulerCliOptions({
        action: "list",
        rawSchedulerRetryFactor: "0",
      }),
    ).toThrow("Expected --retry-factor to be followed by a positive number.");

    expect(() =>
      createSchedulerCliOptions({
        action: "list",
        rawSchedulerRetryRandomize: "maybe",
      }),
    ).toThrow("Expected --retry-randomize to be followed by on or off.");
  });
});
