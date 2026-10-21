import { writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { prepareWindowsNativeToolchain } from "../../../apps/client/scripts/windows-native-toolchain.mjs";
import { prepareWindowsVulkanToolchain } from "../../../apps/client/scripts/windows-vulkan-toolchain.mjs";

const digest = "33e58e86686f6b386c526682b5da9228ead4f91d994abd4b053442dc5b42719e";
const directory = "docs/validation/image-engines/research-2026-10-13";
const fixture = path.resolve(`${directory}/juggernaut-profile-import.json`);
await writeFile(fixture, JSON.stringify({ request: {
  sourcePath: `D:/Models/machdoch/models/packages/user-${digest.slice(0, 32)}/revisions/${digest}/checkpoint.safetensors`,
  architecture: "juggernaut-xl", displayName: "Juggernaut XI · KandooAI / RunDiffusion",
  sourceUrl: "https://huggingface.co/RunDiffusion/Juggernaut-XI-v11", commercialUse: "review-required", licenseName: null, reviewToken: "",
}, expectedDigest: digest }, null, 2));
const env = prepareWindowsVulkanToolchain(prepareWindowsNativeToolchain({ ...process.env,
  VULKAN_SDK: "C:/Development/machdoch/apps/client/src-tauri/target/refmod-vulkan-sdk/1.4.363.0",
  CARGO_TARGET_DIR: "C:/Development/machdoch/.cache/rust", MACHDOCH_IMAGE_MODEL_STORE: "D:/Models/machdoch", MACHDOCH_IMAGE_MODEL_IMPORT_FIXTURE: fixture,
}));
const result = spawnSync("cargo", ["test", "--lib", "media::model_import::tests::external_image_checkpoint_import", "--", "--ignored", "--exact", "--nocapture", "--test-threads=1"], { cwd: "apps/client/src-tauri", env, encoding: "utf8", windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
await writeFile(`${directory}/juggernaut-profile-import.log`, `${result.stdout ?? ""}\n${result.stderr ?? ""}`);
console.log(JSON.stringify({ exitCode: result.status }));
if (result.status !== 0) throw new Error("Juggernaut profile import failed");
