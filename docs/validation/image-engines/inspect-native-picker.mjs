import { chromium } from 'playwright-core';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9228');
const page = browser.contexts()[0].pages().find(page => page.url().includes('tauri'));
await page.getByLabel('Search models', { exact: true }).fill('Anima');
console.log(JSON.stringify({ items: await page.locator('[cmdk-item]').allTextContents(), text: (await page.locator('body').innerText()).slice(-1600) }));
await page.getByLabel('Search models', { exact: true }).fill('');
console.log(JSON.stringify({ items: await page.locator('[cmdk-item]').allTextContents() }));
await page.keyboard.press('Escape');
await browser.close();
