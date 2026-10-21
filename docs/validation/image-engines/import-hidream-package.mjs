import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { prepareWindowsNativeToolchain } from '../../../apps/client/scripts/windows-native-toolchain.mjs';
import { prepareWindowsVulkanToolchain } from '../../../apps/client/scripts/windows-vulkan-toolchain.mjs';
const directory = 'docs/validation/image-engines/research-2026-10-13';
const fixture = path.resolve(`${directory}/hidream-folder-import.json`);
await writeFile(fixture, JSON.stringify({ sourcePath: 'D:/Models/machdoch/downloads/hidream-nf4-prepared', architecture: 'hidream-i1-full', displayName: 'HiDream-I1 Full NF4 · HiDream.ai / hykilpikonna', sourceUrl: 'https://civitai.com/models/1457126?modelVersionId=1647676', commercialUse: 'review-required', licenseName: null, reviewToken: '' }, null, 2));
const env = prepareWindowsVulkanToolchain(prepareWindowsNativeToolchain({ ...process.env,
  VULKAN_SDK: 'C:/Development/machdoch/apps/client/src-tauri/target/refmod-vulkan-sdk/1.4.363.0',
  MACHDOCH_IMAGE_MODEL_STORE: 'D:/Models/machdoch', MACHDOCH_IMAGE_MODEL_IMPORT_REQUEST: fixture,
}));
const binary = path.resolve('.cache/rust/debug/deps/machdoch_lib-e0177dcc54ca68bc.exe');
const started = Date.now();
const result = spawnSync(binary, ['media::model_package_import::tests::external_image_model_package_import', '--ignored', '--exact', '--nocapture', '--test-threads=1'], { cwd: 'apps/client/src-tauri', env, encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
await writeFile(`${directory}/hidream-folder-import.log`, `${result.stdout ?? ''}\n${result.stderr ?? ''}`);
console.log(JSON.stringify({ exitCode: result.status, seconds: (Date.now() - started) / 1000 }));
if (result.status !== 0) throw new Error('HiDream native folder import failed');
