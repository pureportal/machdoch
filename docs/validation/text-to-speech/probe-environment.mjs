import { mkdir, readFile, writeFile, readdir, stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";

const modelRoot = process.platform === "win32" ? "D:\\Models\\machdoch" : "/mnt/d/Models/machdoch";
const researchRoot = path.join(modelRoot, "speech", "research");
const captureDate=new Date().toISOString().slice(0,10);
await mkdir(researchRoot, { recursive: true });
const url = "https://docs.fish.audio/api-reference/openapi.json";
const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
if (!response.ok) throw new Error(`Fish schema fetch failed: ${response.status}`);
const raw = await response.text();
const schema = JSON.parse(raw);
await writeFile(path.join(researchRoot, `fish-openapi-${captureDate}.json`), raw);
const endpoints = Object.fromEntries(Object.entries(schema.paths).filter(([route]) => /(?:\/v1\/tts|\/v1\/voice-design|^\/model)/u.test(route)).map(([route, methods]) => [route, Object.fromEntries(Object.entries(methods).filter(([, method]) => typeof method === "object" && method !== null && "responses" in method).map(([name, method]) => [name, { operationId: method.operationId, parameters: method.parameters, requestBody: method.requestBody, responseStatuses: Object.keys(method.responses) }]))]));
let gpu;
try { gpu = execFileSync("nvidia-smi", ["--query-gpu=name,memory.total,driver_version", "--format=csv,noheader"], { encoding: "utf8", timeout: 15000, windowsHide: true }).trim(); }
catch (error) { gpu = { available: false, reason: error.code ?? error.status ?? "unavailable" }; }
let models = [];
for (const entry of await readdir(modelRoot, { withFileTypes: true })) if (/fish|speech|drama|codec/iu.test(entry.name)) models.push({ name: entry.name, directory: entry.isDirectory() });
const result = { capturedAt: new Date().toISOString(), modelRoot, schema: { url, sha256: createHash("sha256").update(raw).digest("hex"), info: schema.info, endpoints }, gpu, existingSpeechAssets: models, environmentCredentials: Object.fromEntries(["FISH_API_KEY", "FISH_AUDIO_API_KEY", "OPENAI_API_KEY", "GOOGLE_API_KEY"].map(key => [key, Boolean(process.env[key]?.trim())])) };
await writeFile(new URL(`./environment-${captureDate}.json`, import.meta.url), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ ...result, schema: { url, sha256: result.schema.sha256, routes: Object.keys(endpoints) } }, null, 2));
