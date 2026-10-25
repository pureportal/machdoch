import { z } from "zod";
import {
  getCloudRuntime,
  closeCloudRuntime,
} from "../src/server/cloud/runtime";

const input = z
  .strictObject({
    organization: z.string().trim().min(1).max(120),
    email: z
      .email()
      .max(254)
      .transform((value) => value.toLowerCase()),
    name: z.string().trim().min(1).max(120),
    password: z.string().min(12).max(1024),
  })
  .parse({
    organization: process.env.MACHDOCH_CLOUD_ORGANIZATION,
    email: process.env.MACHDOCH_CLOUD_OWNER_EMAIL,
    name: process.env.MACHDOCH_CLOUD_OWNER_NAME,
    password: process.env.MACHDOCH_CLOUD_OWNER_PASSWORD,
  });
try {
  const runtime = await getCloudRuntime();
  await runtime.identity.bootstrap(input);
  process.stdout.write("Cloud organization initialized.\n");
} finally {
  await closeCloudRuntime();
}
