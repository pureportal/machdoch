import { mkdir, writeFile } from "node:fs/promises";

const repositories = [
  "circlestone-labs/Anima-Base-v1.0-Diffusers",
  "circlestone-labs/Anima",
  "OnomaAIResearch/Illustrious-xl-early-release-v0",
  "Laxhar/noobai-XL-1.0",
  "RunDiffusion/Juggernaut-XL-v9",
  "SG161222/RealVisXL_V5.0",
  "Lykon/dreamshaper-xl-1-0",
  "stabilityai/sd-turbo",
  "stabilityai/sdxl-turbo",
  "stabilityai/stable-diffusion-3.5-large-turbo",
];
const directory = "docs/validation/image-engines/research-2026-10-13";
await mkdir(directory, { recursive: true });
for (const repository of repositories) {
  try {
    const response = await fetch(`https://huggingface.co/api/models/${repository}`, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const metadata = await response.json();
    const documents = {};
    for (const file of ["README.md", "model_index.json", "modular_model_index.json", "scheduler/scheduler_config.json", "guider/guider_config.json", "LICENSE.md", "LICENSE", "LICENSE.txt"]) {
      if (!metadata.siblings.some(item => item.rfilename === file)) continue;
      const resource = await fetch(`https://huggingface.co/${repository}/resolve/${metadata.sha}/${file}`, { signal: AbortSignal.timeout(30000) });
      documents[file] = { status: resource.status, content: await resource.text() };
    }
    await writeFile(`${directory}/${repository.replaceAll("/", "--")}.json`, JSON.stringify({ repository, revision: metadata.sha, gated: metadata.gated, card: metadata.cardData, files: metadata.siblings, documents }, null, 2));
    console.log(JSON.stringify({ repository, revision: metadata.sha, gated: metadata.gated, index: documents["model_index.json"]?.content ?? documents["modular_model_index.json"]?.content, scheduler: documents["scheduler/scheduler_config.json"]?.content }));
  } catch (error) {
    console.log(JSON.stringify({ repository, error: error.message }));
  }
}
