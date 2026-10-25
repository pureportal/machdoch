import {
  readFile,
  writeFile,
  listFiles,
  describeArtifact,
  writeArtifact,
} from "./files.ts";

if (process.platform !== "linux" || process.getuid?.() !== 1000)
  throw new Error("File tools require the agent account");
const chunks: Buffer[] = [];
let size = 0;
for await (const part of process.stdin) {
  const bytes = Buffer.from(part);
  size += bytes.length;
  if (size > 1024 * 1024) throw new Error("File request exceeds its limit");
  chunks.push(bytes);
}
const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
  string,
  unknown
>;
const tool = process.argv[2];
try {
  let result: unknown;
  if (tool === "read_file") result = await readFile(input);
  else if (tool === "write_file") result = await writeFile(input);
  else if (tool === "list_files") result = await listFiles(input);
  else if (tool === "export_artifact")
    result = await readFile(
      { ...input, encoding: "base64" },
      "/tmp/machdoch-artifacts",
    );
  else if (tool === "describe_artifact") result = await describeArtifact(input);
  else if (tool === "write_artifact") result = await writeArtifact(input);
  else throw new Error("Unknown file tool");
  process.stdout.write(JSON.stringify({ ok: true, result }));
} catch (error) {
  process.stdout.write(
    JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : "File operation failed",
    }),
  );
}
