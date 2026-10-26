import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getCACertificates, setDefaultCACertificates } from "node:tls";

const configurationPath = process.env.MACHDOCH_CLOUD_IMPORT_CONFIG;
if (!configurationPath) throw new Error("The email fixture requires its configuration path.");
setDefaultCACertificates([
  ...getCACertificates("default"),
  readFileSync(join(dirname(configurationPath), "tls.crt"), "utf8"),
]);
await import("../src/server.ts");
