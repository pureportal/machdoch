import { PROJECTS } from "../../packages/analytics/src/catalog.ts";
import { swetrixRequest } from "./swetrix-api.mjs";

const metric = (event, key, type = "integer", filterKey, filterValue) => ({
  customEventName: event,
  metricKey: key,
  metaValueType: type,
  ...(filterKey ? { metaKey: filterKey, metaValue: filterValue } : {}),
});
const views = [
  {
    name: "Feature adoption",
    type: "traffic",
    customEvents: [
      metric("feature.exposed", "feature", "string"),
      metric("feature.used", "feature", "string"),
      metric("feature.summary", "used", "string"),
    ],
  },
  { name: "Page performance", type: "performance" },
  {
    name: "Web vitals",
    type: "traffic",
    customEvents: [
      metric("web-vital", "value", "float", "metric", "LCP"),
      metric("web-vital", "value", "float", "metric", "INP"),
      metric("web-vital", "value", "float", "metric", "CLS"),
    ],
  },
  {
    name: "Load and engagement",
    type: "traffic",
    customEvents: [
      metric("web-vital", "value", "float", "metric", "FCP"),
      metric("web-vital", "value", "float", "metric", "TTFB"),
      metric("engagement", "duration_ms"),
    ],
  },
  {
    name: "Operation latency",
    type: "traffic",
    customEvents: [
      metric("operation.completed", "duration_ms"),
      metric("operation.failed", "duration_ms"),
      metric("operation.started", "operation", "string"),
    ],
  },
  {
    name: "Job outcomes",
    type: "traffic",
    customEvents: [
      metric("job.completed", "duration_ms"),
      metric("job.failed", "duration_ms"),
      metric("job.cancelled", "duration_ms"),
    ],
  },
];
const funnels = {
  landing: [{ name: "Download", steps: ["/", "landing.download.clicked"] }],
  fleet: [
    { name: "Open a device", steps: ["/instances", "/instances/:instance"] },
  ],
  software: [
    { name: "Chat to automation", steps: ["/app/chat", "/app/ralph"] },
    {
      name: "Media workflow",
      steps: ["/app/media/generate", "/app/media/workflows"],
    },
  ],
};
const report = [];
for (const [app, id] of Object.entries(PROJECTS)) {
  const project = await swetrixRequest(`/project/${id}`);
  if (!project.name.startsWith("Machdoch "))
    throw new Error(`Unexpected project at ${id}; refusing to modify it.`);
  await swetrixRequest(`/project/${id}`, {
    method: "PUT",
    body: {
      active: true,
      public: false,
      botsProtectionLevel: "basic",
      ...(app === "software"
        ? { origins: ["tauri.localhost", "localhost", "127.0.0.1"] }
        : {}),
    },
  });
  const existingViews = await swetrixRequest(`/project/${id}/views`);
  for (const view of views) {
    const existing = existingViews.find(
      (candidate) => candidate.name === view.name,
    );
    await swetrixRequest(
      `/project/${id}/views${existing ? `/${existing.id}` : ""}`,
      { method: existing ? "PATCH" : "POST", body: view },
    );
  }
  const existingFunnels = await swetrixRequest(`/project/funnels/${id}`);
  for (const funnel of funnels[app]) {
    if (!existingFunnels.some((candidate) => candidate.name === funnel.name))
      await swetrixRequest("/project/funnel", {
        method: "POST",
        body: { ...funnel, pid: id },
      });
  }
  const verifiedProject = await swetrixRequest(`/project/${id}`);
  const verifiedViews = await swetrixRequest(`/project/${id}/views`);
  const verifiedFunnels = await swetrixRequest(`/project/funnels/${id}`);
  if (
    !verifiedProject.active ||
    verifiedProject.public ||
    verifiedViews.length < views.length ||
    verifiedFunnels.length < funnels[app].length
  )
    throw new Error(`Configuration verification failed for ${app}.`);
  report.push({
    app,
    id,
    private: !verifiedProject.public,
    views: verifiedViews.length,
    funnels: verifiedFunnels.length,
  });
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
