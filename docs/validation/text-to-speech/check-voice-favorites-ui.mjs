import {build} from "vite";
import react from "@vitejs/plugin-react";
import {chromium} from "playwright-core";
import {readFile,mkdir,writeFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {createRequire} from "node:module";
import assert from "node:assert/strict";

const root=fileURLToPath(new URL("./ui",import.meta.url));const workspace=path.resolve(root,"../../../..");const output="D:/Models/machdoch/speech/verification/voice-favorites-ui";
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
let stage="favorite across catalog pages";
try{
  await page.goto("https://speech.test/");await page.getByRole("button",{name:"Voices",exact:true}).click();const catalog=page.locator('.tts-voice-list');const first=catalog.locator('article').filter({has:page.getByRole("heading",{name:"Comparison voice 1",exact:true})});await first.getByRole("button",{name:"Favorite voice",exact:true}).click();await first.getByRole("button",{name:"Remove favorite voice",exact:true}).waitFor();
  await page.getByRole("button",{name:"Next",exact:true}).click();const last=catalog.locator('article').filter({has:page.getByRole("heading",{name:"Comparison voice 21",exact:true})});await last.getByRole("button",{name:"Favorite voice",exact:true}).click();await last.getByRole("button",{name:"Remove favorite voice",exact:true}).waitFor();
  const remoteReads=await page.evaluate(()=>window.speechFixture.calls.filter(call=>call.operation==="listVoices"||call.operation==="getVoice").length);await page.evaluate(()=>window.speechFixture.clearVoiceCatalog());
  stage="local favorites survive empty remote ranking";const search=page.locator('form').filter({has:page.getByLabel("Search voices",{exact:true})});await page.getByLabel("Favorites",{exact:true}).check();await search.getByRole("button",{name:"Search",exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.tts-voice-list article').length===2);assert.deepEqual((await catalog.getByRole("heading").allTextContents()).sort(),["Comparison voice 1","Comparison voice 21"]);assert.equal(await page.evaluate(()=>window.speechFixture.calls.filter(call=>call.operation==="listVoices"||call.operation==="getVoice").length),remoteReads);
  await page.getByLabel("Search voices",{exact:true}).fill("voice 21");await search.getByRole("button",{name:"Search",exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.tts-voice-list article').length===1);assert.equal(await catalog.getByRole("heading").innerText(),"Comparison voice 21");
  stage="persistence and local removal";await page.reload();await page.getByRole("button",{name:"Voices",exact:true}).click();await page.getByLabel("Favorites",{exact:true}).check();await search.getByRole("button",{name:"Search",exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.tts-voice-list article').length===2);await catalog.locator('article').filter({has:page.getByRole("heading",{name:"Comparison voice 1",exact:true})}).getByRole("button",{name:"Remove favorite voice",exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.tts-voice-list article').length===1);assert.equal(await catalog.getByRole("heading").innerText(),"Comparison voice 21");
  const axe=createRequire(path.join(workspace,"apps/client/package.json"))("axe-core");await page.addScriptTag({content:axe.source});const accessibility=await page.evaluate(async()=>window.axe.run(document.querySelector('.tts-panel:not([hidden])'),{runOnly:{type:"tag",values:["wcag2a","wcag2aa","wcag21aa"]}}));assert.deepEqual(accessibility.violations.map(item=>({id:item.id,impact:item.impact})),[]);
  const calls=await page.evaluate(()=>window.speechFixture.calls);assert.ok(calls.filter(call=>call.operation==="listFavoriteVoices").every(call=>call.input.limit===20));assert.ok(calls.every(call=>!["render","beginLive","compareVoices","designVoice","createVoice","deleteVoice"].includes(call.operation)));assert.deepEqual(errors,[]);
  await writeFile(path.join(workspace,"docs/validation/text-to-speech/voice-favorites-ui-result-2026-10-20.json"),JSON.stringify({browser:"Microsoft Edge Chromium",serverStarted:false,syntheticStorage:true,checks:["favorite voices across catalog pages","local favorite discovery without provider ranking or lookup","local search","favorite persistence after reload","remove local favorite without remote deletion","bounded favorite pages","zero tested axe A/AA violations","no generation or remote voice mutation"],errors},null,2));process.stdout.write("Voice favorites UI checks passed.\n");
}catch(error){await writeFile("D:/Models/machdoch/speech/verification/voice-favorites-ui-failure.json",JSON.stringify({stage,error:String(error).slice(0,4096),errors,operations:await page.evaluate(()=>window.speechFixture.calls.slice(-20).map(call=>call.operation)),alerts:await page.getByRole("alert").allTextContents()},null,2));throw new Error(stage+": "+String(error).split("\n")[0]);}finally{await browser.close();}
