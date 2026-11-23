import { describe, expect, it } from "vitest";
import { automationActionSchema } from "./cloud-automation-contract";
import {
  dryRunDetail,
  goalEvaluatorPrompt,
  goalWorkerPrompt,
  parseGoalVerdict,
} from "./loop-outputs";

const id = "00000000-0000-4000-8000-000000000001";
const variables = {
  issue: { title: "Crash on start" },
  project: { name: "Atlas" },
};

function detail(action: Record<string, unknown>): string {
  return dryRunDetail(automationActionSchema.parse(action), variables);
}

describe("loop outputs", () => {
  it("describes every typed output in a dry run without side effects", () => {
    expect(
      detail({ kind: "create_issue", title: "Fix {{issue.title}}" }),
    ).toBe("Would create issue: Fix Crash on start");
    expect(detail({ kind: "set_status", statusId: id })).toBe(
      "Would change the status",
    );
    expect(detail({ kind: "set_priority", priority: "high" })).toBe(
      "Would set priority to high",
    );
    expect(detail({ kind: "comment", body: "Seen in {{project.name}}" })).toBe(
      "Would comment: Seen in Atlas",
    );
    expect(detail({ kind: "add_labels", labelIds: [id] })).toBe(
      "Would add 1 label",
    );
    expect(
      detail({
        kind: "append_document_section",
        documentId: id,
        heading: "{{project.name}} Q1",
        body: "Report",
      }),
    ).toBe("Would append section: Atlas Q1");
    expect(
      detail({
        kind: "write_project_updates",
        providerId: id,
        model: "m",
      }),
    ).toBe("Would post updates for active projects");
    expect(detail({ kind: "delegate", profileId: id })).toBe(
      "Would open a pull request to fix",
    );
    expect(
      detail({ kind: "prepare_release", productId: id, version: "1.2.0" }),
    ).toBe("Would write release notes for 1.2.0");
    expect(
      detail({
        kind: "notify",
        channel: "slack",
        target: "#ops",
        body: "{{issue.title}}",
      }),
    ).toBe("Would notify #ops via slack: Crash on start");
    expect(
      detail({ kind: "send_webhook", url: "https://hooks.example.com/x" }),
    ).toBe("Would send webhook to hooks.example.com");
  });

  it("parses goal evaluator verdicts and feeds failures back to the worker", () => {
    expect(parseGoalVerdict("PASS\nall good")).toEqual({
      passed: true,
      feedback: "all good",
    });
    expect(parseGoalVerdict("**FAIL**\nmissing tests")).toEqual({
      passed: false,
      feedback: "missing tests",
    });
    expect(parseGoalVerdict("unclear")).toEqual({
      passed: false,
      feedback: "unclear",
    });
    const worker = goalWorkerPrompt({
      objective: "Fix it",
      successCriteria: "Tests pass",
      iteration: 2,
      feedback: "missing tests",
    });
    expect(worker).toContain("Attempt 2");
    expect(worker).toContain("missing tests");
    expect(
      goalEvaluatorPrompt({
        objective: "Fix it",
        successCriteria: "Tests pass",
        result: "Done",
      }),
    ).toContain("PASS or FAIL");
  });
});
