import { cloudId, type CloudActor } from "../../../lib/cloud-contract";
import {
  pulseInstructionsInputSchema,
  pulseWriteInputSchema,
} from "../../../lib/cloud-pulse-contract";
import { CloudError } from "../access";
import { readBody } from "../request-body";
import type { CloudRuntime } from "../runtime";

export async function handlePulseApi(
  runtime: CloudRuntime,
  request: Request,
  actor: CloudActor,
): Promise<Response> {
  const route = `${request.method} ${new URL(request.url).pathname.slice("/api/v1/pulse/".length)}`;
  const pulse = runtime.pulse.writer;
  if (route === "GET instructions")
    return Response.json(await pulse.instructions(actor));
  if (route === "PUT instructions")
    return Response.json(
      await pulse.setInstructions(
        actor,
        (await readBody(request, pulseInstructionsInputSchema)).instructions,
      ),
    );
  if (route === "GET jobs")
    return Response.json({ jobs: await pulse.jobs(actor) });
  if (route === "POST jobs")
    return Response.json(
      await pulse.start(
        actor,
        cloudId.parse(request.headers.get("idempotency-key")),
        await readBody(request, pulseWriteInputSchema),
      ),
      { status: 201 },
    );
  throw new CloudError(404, "not_found", "This Pulse endpoint does not exist.");
}
