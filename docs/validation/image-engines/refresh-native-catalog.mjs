import { chromium } from 'playwright-core';
import { writeFile } from 'node:fs/promises';


const browser = await chromium.connectOverCDP('http://127.0.0.1:9228');
try {
  const page = browser.contexts()[0].pages().find(page => page.url().includes('tauri'));
  await page.keyboard.press('Escape');
  const details = page.getByText('Technical details', { exact: true });
  if (await details.count()) await details.click();
  await writeFile('docs/validation/image-engines/research-2026-10-13/native-storage-before-refresh.txt', await page.locator('body').innerText());
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.getByText('Media Studio storage is temporarily unavailable.', { exact: true }).waitFor({ state: 'detached', timeout: 60_000 });
  await writeFile('docs/validation/image-engines/research-2026-10-13/native-storage-after-refresh.txt', await page.locator('body').innerText());
  console.log(JSON.stringify({ refreshed: true }));
} finally {
  await browser.close();
}
