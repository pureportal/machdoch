import {build} from "vite";
import react from "@vitejs/plugin-react";
import {chromium} from "playwright-core";
import {readFile,mkdir,writeFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {createRequire} from "node:module";
import assert from "node:assert/strict";

const root=fileURLToPath(new URL("./ui",import.meta.url));const workspace=path.resolve(root,"../../../..");const output="D:/Models/machdoch/speech/verification/editor-book-ui";
await mkdir(output,{recursive:true});
await build({configFile:false,root,plugins:[react()],logLevel:"error",resolve:{dedupe:["react","react-dom"],alias:[{find:/^@machdoch\/text-to-speech$/,replacement:path.join(workspace,"packages/text-to-speech/src/index.ts")},{find:/^@machdoch\/speech$/,replacement:path.join(workspace,"packages/speech/src/index.ts")}]},build:{outDir:output,emptyOutDir:true,minify:false}});
const browser=await chromium.launch({channel:"msedge",headless:true});const page=await browser.newPage({viewport:{width:1365,height:900}});const errors=[];page.on("pageerror",error=>errors.push(error.message));
await page.route("https://speech.test/**",async route=>{
  const pathname=decodeURIComponent(new URL(route.request().url()).pathname);const target=path.resolve(output,pathname==="/"?"index.html":`.${pathname}`);
  if(!target.startsWith(path.resolve(output)+path.sep)){await route.abort();return;}
  const contentType={".html":"text/html",".js":"text/javascript",".css":"text/css"}[path.extname(target)]??"application/octet-stream";
  try{await route.fulfill({body:await readFile(target),contentType});}catch{await route.fulfill({status:404,body:"Missing verification asset"});}
});
try{
  await page.goto("https://speech.test/");await page.getByLabel("Project name",{exact:true}).fill("Book editing verification");await page.getByRole("button",{name:"Create project",exact:true}).click();
  await page.evaluate(()=>{
    window.editorMeasurements={longTasks:[],ticks:[],last:performance.now()};
    const values=window.editorMeasurements;new PerformanceObserver(list=>values.longTasks.push(...list.getEntries().map(entry=>entry.duration))).observe({type:"longtask",buffered:false});
    values.timer=setInterval(()=>{const now=performance.now();values.ticks.push(now-values.last);values.last=now;},20);
  });
  const paragraph="Die Straße bleibt ruhig. 東京の扉が開きます。 مرحبًا بالعالم. The station clock shows 10:30. Numbers and technical terms remain authored text.\n\n";
  const source=Array.from({length:48},(_,index)=>`# Chapter ${index+1}\n## Scene ${index+1}\n${paragraph.repeat(50)}`).join("\n");
  const editor=page.locator('.cm-content[contenteditable="true"]');const started=performance.now();const importer=page.locator(".speech-creative-tools > details").filter({has:page.locator("summary",{hasText:/^Import$/u})});await importer.locator("summary").first().click();await importer.getByLabel("File",{exact:true}).setInputFiles({name:"book.txt",mimeType:"text/plain",buffer:Buffer.from(source)});await importer.getByRole("button",{name:"Apply import",exact:true}).click();await importer.locator("summary").first().click();await page.getByRole("button",{name:"Save",exact:true}).click();await page.waitForFunction(value=>window.speechFixture.projects[0]?.source===value,source);await page.getByLabel("Chapter and scene outline",{exact:true}).selectOption({label:"Chapter 48"});const initialMs=performance.now()-started;
  await page.getByRole("status").filter({hasText:/^Saved$/u}).waitFor();
  await page.evaluate(()=>{window.speechFixture.holdDrafts();const values=window.editorMeasurements;values.typingStarted=performance.now();values.typingTasks=values.longTasks.length;values.typingTicks=values.ticks.length;});
  await editor.press("Control+End");let suffix="";for(const text of ["追加 ","🚀 ","مرحبًا ","Straße ","東京 ","Grüße ","中文 ","العالم ","sentence ","final "]){suffix+=text;await page.keyboard.insertText(text);}
  const cdp=await page.context().newCDPSession(page);await cdp.send("Input.imeSetComposition",{text:"にほん",selectionStart:3,selectionEnd:3});await cdp.send("Input.imeSetComposition",{text:"日本語",selectionStart:3,selectionEnd:3});await cdp.send("Input.insertText",{text:"日本語"});await cdp.detach();
  const expected=source+suffix+"日本語";await page.evaluate(()=>window.speechFixture.releaseDrafts());await page.waitForFunction(()=>window.speechFixture.completedDraftWrites>=2);const draftWrites=await page.evaluate(()=>window.speechFixture.draftWrites);assert.equal(draftWrites.length,2);assert.equal(draftWrites.at(-1).tail,expected.slice(-100));
  await page.getByRole("button",{name:"Save",exact:true}).click();await page.waitForFunction(value=>window.speechFixture.projects[0]?.source===value,expected);await page.getByLabel("Chapter and scene outline",{exact:true}).selectOption({label:"Chapter 48"});
  const observations=await page.evaluate(()=>{const values=window.editorMeasurements;clearInterval(values.timer);return {longTasks:values.longTasks,ticks:values.ticks,heap:performance.memory?.usedJSHeapSize??null,typingTasks:values.longTasks.slice(values.typingTasks),typingTicks:values.ticks.slice(values.typingTicks)};});
  await page.reload();await page.getByRole("button",{name:"Book editing verification",exact:true}).click();await page.getByLabel("Chapter and scene outline",{exact:true}).selectOption({label:"Chapter 48"});assert.equal(await page.evaluate(()=>window.speechFixture.projects[0].source),expected);assert.deepEqual(errors,[]);
  const sorted=observations.ticks.toSorted((a,b)=>a-b),quantile=q=>sorted[Math.min(sorted.length-1,Math.ceil(sorted.length*q)-1)]??null;
  const typing=observations.typingTicks.toSorted((a,b)=>a-b),typingQuantile=q=>typing[Math.min(typing.length-1,Math.ceil(typing.length*q)-1)]??null;
  const result={browser:"Microsoft Edge Chromium",serverStarted:false,utf8Bytes:Buffer.byteLength(source),characters:[...source].length,chapters:48,initialLoadAndSaveMs:initialMs,mainThread:{tickP50Ms:quantile(0.5),tickP95Ms:quantile(0.95),maximumTickMs:Math.max(...observations.ticks),longTaskCount:observations.longTasks.length,maximumLongTaskMs:Math.max(0,...observations.longTasks),observedHeapBytes:observations.heap},typing:{tickP50Ms:typingQuantile(0.5),tickP95Ms:typingQuantile(0.95),maximumLongTaskMs:Math.max(0,...observations.typingTasks),persistedRecoveryWrites:draftWrites.length},checks:["bounded recovery writes retain the final edit under storage backpressure","large file import, editing and worker-produced chapter outline","Unicode and RTL source preservation","trusted browser IME composition replacement and commit","exact persistence and reopen without temporary composition text"],errors};
  await writeFile(path.join(workspace,"docs/validation/text-to-speech/editor-book-ui-result-2026-10-20.json"),JSON.stringify(result,null,2));process.stdout.write(JSON.stringify(result)+"\n");
}catch(error){await writeFile("D:/Models/machdoch/speech/verification/editor-book-ui-failure.json",JSON.stringify({error:String(error).split("\n")[0],errors},null,2));throw new Error(String(error).split("\n")[0]);}finally{await browser.close();}
