import { PROJECTS } from "../../packages/analytics/src/catalog.ts";
import { swetrixRequest } from "./swetrix-api.mjs";

const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
const query = new URLSearchParams({
  from: "1970-01-01T00:00:00.000Z",
  to: cutoff.toISOString(),
});
for (const [app, id] of Object.entries(PROJECTS)) {
  const project = await swetrixRequest(`/project/${id}`);
  if (!project.name.startsWith("Machdoch "))
    throw new Error(`Unexpected project at ${id}; refusing to erase data.`);
  await swetrixRequest(`/project/partially/${id}?${query}`, {
    method: "DELETE",
  });
  process.stdout.write(
    `${app}: erased analytics before ${cutoff.toISOString()}\n`,
  );
}
