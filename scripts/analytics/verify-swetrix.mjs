import assert from "node:assert/strict";
import { PROJECTS } from "../../packages/analytics/src/catalog.ts";
import { swetrixRequest } from "./swetrix-api.mjs";

const report = [];
for (const [app, id] of Object.entries(PROJECTS)) {
  const project = await swetrixRequest(`/project/${id}`);
  assert.equal(project.active, true);
  assert.equal(project.public, false);
  const views = await swetrixRequest(`/project/${id}/views`);
  const funnels = await swetrixRequest(`/project/funnels/${id}`);
  const checks = [];
  for (const view of views) {
    const query = new URLSearchParams({
      pid: id,
      period: "1d",
      timeBucket: "hour",
    });
    if (view.customEvents?.length)
      query.set("metrics", JSON.stringify(view.customEvents));
    try {
      await swetrixRequest(
        `/log${view.type === "performance" ? "/performance" : ""}?${query}`,
      );
      checks.push({ name: view.name, statistics: "passed" });
    } catch (error) {
      if (
        view.type !== "performance" ||
        error.status !== 400 ||
        error.detail !== "There are no parameters for the specified time frames"
      )
        throw error;
      checks.push({ name: view.name, statistics: "awaiting performance data" });
    }
  }
  const query = new URLSearchParams({
    pid: id,
    period: "1d",
    timeBucket: "hour",
    customEvents: JSON.stringify([
      "feature.used",
      "feature.exposed",
      "feature.summary",
      "operation.completed",
      "job.completed",
    ]),
  });
  await swetrixRequest(`/log/custom-events?${query}`);
  report.push({
    app,
    id,
    views: checks,
    funnels: funnels.map((funnel) => funnel.name),
    statistics: "passed",
  });
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
