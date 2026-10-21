import { chromium } from 'playwright-core';
import { writeFile } from 'node:fs/promises';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9228');
const page = browser.contexts()[0].pages().find(page => page.url().includes('tauri'));
const result = await page.evaluate(() => window.__TAURI__.core.invoke('media_refresh_local_diffusers_runtime'));
await writeFile('docs/validation/image-engines/research-2026-10-13/native-runtime-final.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify({ ready: result.ready, version: result.workerVersion, diagnostic: result.diagnostic }));
await page.reload();
await browser.close();
