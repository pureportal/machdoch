import { describe, expect, it } from "vitest";
import { automationInputSchema } from "./cloud-automation-contract";
import {
  loopConfigSchema,
  type LoopTemplateInstall,
} from "./cloud-loop-contract";
import { dryRunDetail } from "./loop-outputs";
import { loopTemplateProblem, loopTemplates } from "./loop-templates";

const ids = {
  team: "00000000-0000-4000-8000-000000000001",
  provider: "00000000-0000-4000-8000-000000000002",
  profile: "00000000-0000-4000-8000-000000000003",
  document: "00000000-0000-4000-8000-000000000004",
};

const install: LoopTemplateInstall = {
  templateId: "",
  teamId: ids.team,
  executor: {
    placement: "sandbox",
    targetId: ids.profile,
    harness: "codex",
    model: "gpt-5",
    capabilities: ["repository", "shell"],
  },
  providerId: ids.provider,
  model: "fixture",
  documentId: ids.document,
  timeZone: "UTC",
};

const fixtureVariables = {
  issue: { identifier: "AU-1", title: "Checkout fails", description: "" },
  source: { name: "grafana", title: "High error rate", body: "5xx > 2%" },
  deployment: { version: "1.4.0", environment: "production" },
  agent: { answer: "Report body" },
  context: "Project Cloud: on track",
  date: "2026-01-01",
};

describe("loop templates", () => {
  it("offers the eight required templates", () => {
    expect(loopTemplates.map((template) => template.id)).toEqual([
      "monthly-project-updates",
      "refresh-project-descriptions",
      "agentic-bug-resolving",
      "quarterly-team-report",
      "monthly-security-report",
      "grafana-reconciliation",
      "maintain-changelog",
      "role-architecture-documents",
    ]);
  });

  it.each(loopTemplates)(
    "$id builds a valid loop that passes a dry-run against fixtures",
    (template) => {
      const built = template.build({
        ...install,
        templateId: template.id,
        timeZone: "Europe/Berlin",
      });
      const automation = automationInputSchema.parse(built.automation);
      const config = loopConfigSchema.parse(built.config);
      expect(automation.teamId).toBe(ids.team);
      expect(config.executor).toEqual(install.executor);
      const details = automation.actions.map((action) =>
        dryRunDetail(action, fixtureVariables),
      );
      expect(details.length).toBeGreaterThan(0);
      for (const detail of details) expect(detail).toMatch(/^Would /);
    },
  );

  it("asks for a document or a sandbox when the template needs one", () => {
    const byId = new Map(
      loopTemplates.map((template) => [template.id, template]),
    );
    const report = byId.get("quarterly-team-report")!;
    const bugs = byId.get("agentic-bug-resolving")!;
    expect(loopTemplateProblem(report, { ...install, documentId: null })).toBe(
      "Choose a document.",
    );
    expect(loopTemplateProblem(report, install)).toBeNull();
    expect(
      loopTemplateProblem(bugs, {
        ...install,
        executor: {
          ...install.executor,
          placement: "automatic",
          targetId: null,
        },
      }),
    ).toBe("Choose a cloud sandbox profile.");
  });

  it("wires the trigger sources each template depends on", () => {
    const built = Object.fromEntries(
      loopTemplates.map((template) => [template.id, template.build(install)]),
    );
    expect(built["agentic-bug-resolving"]!.automation.trigger.kind).toBe(
      "issue_triaged",
    );
    expect(built["agentic-bug-resolving"]!.config.trustedSources).toEqual([
      "sentry",
    ]);
    expect(built["grafana-reconciliation"]!.config.trustedSources).toEqual([
      "grafana",
    ]);
    expect(built["maintain-changelog"]!.automation.trigger.kind).toBe(
      "release_event",
    );
    expect(built["quarterly-team-report"]!.automation.trigger).toMatchObject({
      kind: "schedule",
      frequency: "quarterly",
    });
  });
});
