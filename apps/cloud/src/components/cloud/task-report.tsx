import {
  FileText,
  Lightbulb,
  ListChecks,
  ShieldCheck,
  Target,
  TriangleAlert,
} from "lucide-react";
import type { RunDetail } from "@machdoch/fleet-protocol/cloud-execution";
import { MarkdownContent } from "@machdoch/client-ui/conversation/markdown-content";
import { taskReport } from "@/lib/task-progress";

export function TaskReport({ run }: { run: RunDetail }) {
  const report = taskReport(run.summary);
  const objective =
    run.manifest.objective === run.title
      ? ""
      : run.manifest.objective.startsWith(run.title + "\n")
        ? run.manifest.objective.slice(run.title.length).trimStart()
        : run.manifest.objective;
  const summary = report.changed ?? report.other;
  return (
    <div className="cloud-task-report">
      {report.verdict && (
        <section
          className="cloud-card cloud-task-result"
          data-state={run.state}
        >
          <h2>
            <ShieldCheck size={17} aria-hidden="true" />
            Verdict
          </h2>
          <MarkdownContent content={report.verdict} />
        </section>
      )}
      {report.problems && (
        <section className="cloud-card cloud-task-decisions">
          <h2>
            <TriangleAlert size={17} aria-hidden="true" />
            Problems found
          </h2>
          <MarkdownContent content={report.problems} />
        </section>
      )}
      {summary && (
        <section
          className="cloud-card cloud-task-result"
          data-state={run.state}
        >
          <h2>
            <FileText size={17} aria-hidden="true" />
            What changed
          </h2>
          <MarkdownContent content={summary} />
          {report.changed && report.other && (
            <MarkdownContent content={report.other} />
          )}
        </section>
      )}
      {report.decisions && (
        <section className="cloud-card cloud-task-decisions">
          <h2>
            <Lightbulb size={17} aria-hidden="true" />
            Decisions the AI made
          </h2>
          <MarkdownContent content={report.decisions} />
        </section>
      )}
      {report.checks && (
        <section className="cloud-card">
          <h2>
            <ListChecks size={17} aria-hidden="true" />
            Checks the AI ran
          </h2>
          <MarkdownContent content={report.checks} />
        </section>
      )}
      <section className="cloud-card cloud-task-brief">
        {objective && (
          <div>
            <h2>
              <Target size={17} aria-hidden="true" />
              Objective
            </h2>
            <MarkdownContent content={objective} />
          </div>
        )}
        <div>
          <h2>
            <ListChecks size={17} aria-hidden="true" />
            Acceptance criteria
          </h2>
          <MarkdownContent content={run.manifest.acceptanceCriteria} />
        </div>
      </section>
    </div>
  );
}
