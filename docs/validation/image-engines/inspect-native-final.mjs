import { chromium } from 'playwright-core';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9228');
const page = browser.contexts()[0].pages().find(page => page.url().includes('tauri'));
console.log(JSON.stringify({ url: page.url(), buttons: await page.getByRole('button').allTextContents(), body: (await page.locator('body').innerText()).slice(0, 1600) }));
if (await page.getByRole('button', { name: 'Skip setup', exact: true }).count()) await page.getByRole('button', { name: 'Skip setup', exact: true }).click();
await browser.close();
