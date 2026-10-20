import {build} from "vite";
import react from "@vitejs/plugin-react";
import {chromium} from "playwright-core";
import {readFile,mkdir,writeFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {createRequire} from "node:module";
import assert from "node:assert/strict";

const root=fileURLToPath(new URL("./ui",import.meta.url));const workspace=path.resolve(root,"../../../..");const output="D:/Models/machdoch/speech/verification/playback-retention-ui";
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
  await page.clock.install();await page.goto("https://speech.test/");await page.getByLabel("Project name",{exact:true}).fill("Playback retention");await page.getByRole("button",{name:"Create project",exact:true}).click();await page.getByRole("button",{name:"Voices",exact:true}).click();
  for(const name of ["Comparison voice 1","Comparison voice 2"])await page.locator("article.tts-voice").filter({has:page.getByRole("heading",{name,exact:true})}).getByRole("button",{name:"Compare voice",exact:true}).click();
  const comparison=page.locator("details").filter({has:page.locator("summary",{hasText:/^Voice comparison$/u})});await comparison.locator("summary").first().click();await comparison.getByLabel("Comparison passage",{exact:true}).fill("Synthetic playback retention fixture.");await comparison.getByLabel("Allow comparison passage in Fish Cloud",{exact:true}).check();await comparison.getByRole("button",{name:"Render voices",exact:true}).click();await comparison.getByRole("button",{name:"Play voice A",exact:true}).waitFor();
  await comparison.getByRole("button",{name:"Play voice A",exact:true}).click();await page.waitForFunction(()=>window.speechFixture.playback.status==="playing");await page.getByRole("button",{name:"Pause audio",exact:true}).click();await page.waitForFunction(()=>window.speechFixture.playback.status==="paused");
  const lease=await page.evaluate(()=>window.speechFixture.calls.find(call=>call.operation==="retainPlayback").input);assert.equal(lease.owner,"text-to-speech:voice-comparison");assert.equal(lease.assetIds.length,1);assert.deepEqual(lease.jobIds,[]);
  await page.clock.fastForward(61_000);await page.waitForFunction(id=>window.speechFixture.calls.some(call=>call.operation==="retainPlayback"&&call.input.id===id&&call.input.assetIds.length===0),lease.id);assert.equal(await page.evaluate(()=>window.speechFixture.playback.status),"paused");
  await page.getByRole("button",{name:"Stop audio",exact:true}).click();await page.waitForFunction(id=>window.speechFixture.calls.some(call=>call.operation==="releasePlayback"&&call.input.id===id),lease.id);const count=await page.evaluate(()=>window.speechFixture.calls.filter(call=>call.operation==="retainPlayback").length);await page.clock.fastForward(61_000);assert.equal(await page.evaluate(()=>window.speechFixture.calls.filter(call=>call.operation==="retainPlayback").length),count);
  await comparison.getByRole("button",{name:"Play voice A",exact:true}).click();await page.waitForFunction(()=>window.speechFixture.playback.status==="playing");await page.getByRole("button",{name:"Stop audio",exact:true}).click();assert.equal(await page.evaluate(()=>window.speechFixture.calls.filter(call=>call.operation==="compareVoices").length),1);assert.equal(await page.evaluate(()=>window.speechFixture.calls.filter(call=>["render","beginLive"].includes(call.operation)).length),0);assert.deepEqual(errors,[]);
  await writeFile(path.join(workspace,"docs/validation/text-to-speech/playback-retention-ui-result-2026-10-20.json"),JSON.stringify({browser:"Microsoft Edge Chromium",serverStarted:false,syntheticProvider:true,checks:["explicit asset lease before comparison playback","renewal while paused","release on stop","no renewal after stop","deliberate cached replay without regeneration"],errors},null,2));process.stdout.write("Playback retention UI checks passed.\n");
}catch(error){await writeFile("D:/Models/machdoch/speech/verification/playback-retention-ui-failure.json",JSON.stringify({error:String(error).split("\n")[0],errors},null,2));throw new Error(String(error).split("\n")[0]);}finally{await browser.close();}
