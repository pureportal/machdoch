import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const root = 'D:/Models/machdoch/verification/2026-10-13/image-engines';
const output = path.resolve('docs/validation/image-engines/review-gallery-2026-10-13');
await mkdir(output, { recursive: true });
const references = [144655944, 144697438, 144594528, 145095967, 144599398, 145177887];
const batches = [];
for (const directory of await readdir(root, { withFileTypes: true })) {
  if (!directory.isDirectory()) continue;
  let results;
  try { results = JSON.parse(await readFile(path.join(root, directory.name, 'results.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') continue; throw error; }
  const images = references.map(reference => results.models.findLast(result => result.passed && result.referenceId === reference));
  if (images.some(Boolean)) batches.push({ name: directory.name, images });
}
const escaped = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const referencePath = reference => pathToFileURL(path.resolve(`docs/validation/image-engines/comparison/reference-${reference}-image.${reference === 144599398 ? 'jpeg' : 'png'}`)).href;
const data = batches.map(batch => ({ name: batch.name, pairs: references.map((reference, index) => ({ reference, source: referencePath(reference), image: batch.images[index] ? pathToFileURL(batch.images[index].image).href : null })) }));
const html = `<!doctype html><meta charset="utf-8"><title>Reference comparisons</title><style>body{margin:20px;background:#101318;color:#e4e8ee;font:14px system-ui}select{padding:8px;background:#202733;color:inherit;border:1px solid #536274;border-radius:6px}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-top:18px}article{background:#19202a;padding:12px;border-radius:8px}h2{font-size:13px;margin:0 0 8px}.pair{display:grid;grid-template-columns:1fr 1fr;gap:8px}img{width:100%;height:320px;object-fit:contain;background:#090c11}p{margin:0}</style><select aria-label="Batch">${data.map((batch,index)=>`<option value="${index}">${escaped(batch.name)}</option>`).join('')}</select><main class="grid"></main><script>const batches=${JSON.stringify(data).replaceAll('<','\\u003c')};function render(){const b=batches[Number(document.querySelector('select').value)];document.querySelector('main').innerHTML=b.pairs.map(p=>'<article><h2>'+p.reference+'</h2><div class="pair"><img alt="Reference '+p.reference+'" src="'+p.source+'">'+(p.image?'<img alt="Generated '+p.reference+'" src="'+p.image+'">':'<p>Pending</p>')+'</div></article>').join('')}document.querySelector('select').addEventListener('change',render);render()</script>`;
const gallery = path.join(output, 'index.html');
await writeFile(gallery, html);
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--allow-file-access-from-files'] });
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await page.goto(pathToFileURL(gallery).href);
for (let index = 0; index < data.length; index++) {
  await page.getByLabel('Batch').selectOption(String(index));
  await page.waitForFunction(() => [...document.images].every(image => image.complete));
  await page.screenshot({ path: path.join(output, data[index].name + '.png'), fullPage: true });
}
await browser.close();
await writeFile(path.join(output, 'playwright-results.json'), JSON.stringify({ batches: data.length, errors, technicalGalleryCheckOnly: true }, null, 2));
console.log(JSON.stringify({ batches: data.length, errors }));
