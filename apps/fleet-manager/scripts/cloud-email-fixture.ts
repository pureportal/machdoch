import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getCACertificates, setDefaultCACertificates } from "node:tls";

const argument = process.argv.indexOf("--config");
if (argument < 0 || !process.argv[argument + 1])
  throw new Error("The email fixture requires its configuration path.");
setDefaultCACertificates([
  ...getCACertificates("default"),
  readFileSync(join(dirname(process.argv[argument + 1]!), "tls.crt"), "utf8"),
]);
await import("../src/server.ts");
