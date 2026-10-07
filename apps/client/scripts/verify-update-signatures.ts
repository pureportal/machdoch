import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { verifyUpdateSignature } from "../src/update/signature.js";
import { UPDATE_PUBLIC_KEY } from "../src/update/public-key.js";

const directory = process.argv[2];
if (!directory) throw new Error("An update asset directory is required.");
const configuration = JSON.parse(
  await readFile(
    new URL("../src-tauri/tauri.conf.json", import.meta.url),
    "utf8",
  ),
);
if (configuration.plugins.updater.pubkey !== UPDATE_PUBLIC_KEY)
  throw new Error("Desktop and CLI update signing keys differ.");
let verified = 0;
for (const name of await readdir(directory)) {
  if (!name.endsWith(".sig")) continue;
  const digest = createHash("blake2b512");
  for await (const chunk of createReadStream(
    join(directory, name.slice(0, -4)),
  ))
    digest.update(chunk);
  verifyUpdateSignature(
    digest.digest(),
    await readFile(join(directory, name), "utf8"),
    UPDATE_PUBLIC_KEY,
    configuration.version,
  );
  verified += 1;
}
if (!verified) throw new Error("No update signatures were found.");
console.log(
  `Verified ${verified} update signatures for ${configuration.version}.`,
);
