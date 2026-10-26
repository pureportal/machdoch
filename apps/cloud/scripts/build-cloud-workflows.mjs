import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { bundleWorkflowCode } from "@temporalio/worker";

const bundle = await bundleWorkflowCode({
  workflowsPath: fileURLToPath(
    new URL("../src/server/cloud/automation/workflows.ts", import.meta.url),
  ),
});
await writeFile(
  new URL("../dist/cloud-workflows.cjs", import.meta.url),
  bundle.code,
);
