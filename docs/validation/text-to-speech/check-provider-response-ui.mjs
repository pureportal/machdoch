import {build} from "vite";
import react from "@vitejs/plugin-react";
import {chromium} from "playwright-core";
import {readFile,mkdir,writeFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {createRequire} from "node:module";
import assert from "node:assert/strict";

const root=fileURLToPath(new URL("./ui",import.meta.url));const workspace=path.resolve(root,"../../../..");const output="D:/Models/machdoch/speech/verification/provider-response-ui";
await mkdir(output,{recursive:true});
await build({configFile:false,root,plugins:[react()],logLevel:"error",resolve:{dedupe:["react","react-dom"],alias:[{find:/^@machdoch\/text-to-speech$/,replacement:path.join(workspace,"packages/text-to-speech/src/index.ts")},{find:/^@machdoch\/speech$/,replacement:path.join(workspace,"packages/speech/src/index.ts")}]},build:{outDir:output,emptyOutDir:true,minify:false}});
const browserTemporary=path.join(output,"browser-temporary");await mkdir(browserTemporary,{recursive:true});process.env.TEMP=browserTemporary;process.env.TMP=browserTemporary;
const browser=await chromium.launch({channel:"msedge",headless:true});const page=await browser.newPage({viewport:{width:1365,height:900}});const errors=[];page.on("pageerror",error=>errors.push(error.message));
await page.route("https://speech.test/**",async route=>{
  const pathname=decodeURIComponent(new URL(route.request().url()).pathname);const target=path.resolve(output,pathname==="/"?"index.html":`.${pathname}`);
  if(!target.startsWith(path.resolve(output)+path.sep)){await route.abort();return;}
  const contentType={".html":"text/html",".js":"text/javascript",".css":"text/css"}[path.extname(target)]??"application/octet-stream";
  try{await route.fulfill({body:await readFile(target),contentType});}catch{await route.fulfill({status:404,body:"Missing verification asset"});}
});
try{
  await page.goto("https://speech.test/");await page.getByLabel("Project name",{exact:true}).fill("Provider response verification");await page.getByRole("button",{name:"Create project",exact:true}).click();await page.evaluate(()=>window.speechFixture.prepareProviderResponses());await page.getByRole("button",{name:"Takes",exact:true}).click();
  const google=page.locator('[data-take-id="provider-google"]'),openai=page.locator('[data-take-id="provider-openai"]');await google.waitFor();await google.locator("summary",{hasText:/^Provenance$/u}).click();await openai.locator("summary",{hasText:/^Provenance$/u}).click();
  assert.match(await google.innerText(),/Returned model version/u);assert.match(await google.innerText(),/gemini-3.1-flash-tts-preview-fixture/u);assert.match(await google.innerText(),/google-fixture-response/u);assert.equal(await google.locator("dt").filter({hasText:/^Output tokens$/u}).locator("xpath=following-sibling::dd[1]").innerText(),"0");assert.equal(await google.locator("dt").filter({hasText:/^Prompt tokens$/u}).locator("xpath=following-sibling::dd[1]").innerText(),"3");assert.equal(await google.locator("dt").filter({hasText:/^Thinking tokens$/u}).count(),0);
  assert.match(await openai.innerText(),/req-fixture/u);assert.match(await openai.innerText(),/12[.,]5 ms/u);assert.equal(await openai.locator("dt").filter({hasText:/^Total tokens$/u}).count(),0);
  const source=page.locator('[data-take-id="voice-source"]');await source.locator("summary",{hasText:/^Provenance$/u}).click();assert.equal(await source.getByRole("link",{name:"Observed voice · observed-voice",exact:true}).getAttribute("href"),"https://api.fish.audio/model/observed-voice");assert.match(await source.innerText(),/Original author/u);assert.match(await source.innerText(),/private/u);assert.match(await source.innerText(),new RegExp("b".repeat(64),"u"));assert.equal(await source.locator("dt").filter({hasText:/^Voice rights$/u}).count(),0);assert.equal(await source.locator("dt").filter({hasText:/^Returned model version$/u}).count(),0);
  const axe=createRequire(path.join(workspace,"apps/client/package.json"))("axe-core");await page.addScriptTag({content:axe.source});const accessibility=await page.evaluate(async()=>window.axe.run(document.querySelector('.tts-panel:not([hidden])'),{runOnly:{type:"tag",values:["wcag2a","wcag2aa","wcag21aa"]}}));assert.deepEqual(accessibility.violations.map(item=>({id:item.id,impact:item.impact})),[]);
  assert.equal(await page.evaluate(()=>window.speechFixture.calls.filter(call=>["render","takeRequest","designVoice","createVoice"].includes(call.operation)).length),0);assert.deepEqual(errors,[]);
  await writeFile(path.join(workspace,"docs/validation/text-to-speech/provider-response-ui-result-2026-10-20.json"),JSON.stringify({browser:"Microsoft Edge Chromium",serverStarted:false,syntheticProviders:true,checks:["returned Google model version and response ID","actual zero token count","absent usage stays omitted","OpenAI request ID and reported processing time","pinned voice source, author, visibility and metadata hash","absent voice rights and model attestation remain omitted","no generation or full-request lookup","zero tested axe A/AA violations"],errors},null,2));process.stdout.write("Provider response and voice source provenance UI checks passed.\n");
}catch(error){await writeFile("D:/Models/machdoch/speech/verification/provider-response-ui-failure.json",JSON.stringify({error:String(error).split("\n")[0],errors},null,2));throw new Error(String(error).split("\n")[0]);}finally{await browser.close();}
