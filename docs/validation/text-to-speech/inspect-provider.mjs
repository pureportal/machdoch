import { readFile } from "node:fs/promises";
const schema = JSON.parse(await readFile("D:/Models/machdoch/speech/research/fish-openapi-2026-10-18.json", "utf8"));
for (const [name, value] of Object.entries(schema.components.schemas)) if (/pronunciation|dictionary|voice.?design|servetts/iu.test(name)) console.log(name, JSON.stringify(value));
for (const route of ["/model", "/v1/voice-design"]) console.log(route, JSON.stringify(schema.paths[route]));
