import {build} from "vite";
import react from "@vitejs/plugin-react";
import {chromium} from "playwright-core";
import {readFile,mkdir,writeFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import assert from "node:assert/strict";
import {createRequire} from "node:module";

const workspace=path.resolve(fileURLToPath(new URL("../../..",import.meta.url)));
const require=createRequire(path.join(workspace,"apps/client/package.json"));const axe=require("axe-core");
const root=path.join(workspace,"docs/validation/text-to-speech/ui");
const output="D:/Models/machdoch/speech/verification/project-copy-ui";
await mkdir(output,{recursive:true});
await build({configFile:false,root,plugins:[react()],logLevel:"error",resolve:{dedupe:["react","react-dom"],alias:[{find:/^@machdoch\/text-to-speech$/,replacement:path.join(workspace,"packages/text-to-speech/src/index.ts")},{find:/^@machdoch\/speech$/,replacement:path.join(workspace,"packages/speech/src/index.ts")}]},build:{outDir:output,emptyOutDir:true,minify:false}});
const temporary=path.join(output,"browser");await mkdir(temporary,{recursive:true});process.env.TEMP=temporary;process.env.TMP=temporary;
const browser=await chromium.launch({channel:"msedge",headless:true});const page=await browser.newPage();const errors=[];page.on("pageerror",error=>errors.push(error.message));
await page.route("https://speech.test/**",async route=>{
  const pathname=decodeURIComponent(new URL(route.request().url()).pathname);const target=path.resolve(output,pathname==="/"?"index.html":`.${pathname}`);
  if(!target.startsWith(path.resolve(output)+path.sep)){await route.abort();return;}
  const contentType={".html":"text/html",".js":"text/javascript",".css":"text/css"}[path.extname(target)]??"application/octet-stream";
  try{await route.fulfill({body:await readFile(target),contentType});}catch{await route.fulfill({status:404,body:"Missing verification asset"});}
});
let stage="open";
const accessibility=[];
async function inspectAccessibility(state){const result=await page.evaluate(()=>window.axe.run(document.querySelector(".tts-studio"),{runOnly:{type:"tag",values:["wcag2a","wcag2aa"]}}));const violations=result.violations.map(value=>({id:value.id,impact:value.impact,targets:value.nodes.map(node=>node.target)}));accessibility.push({state,violations});assert.deepEqual(violations,[]);}
try{
  await page.goto("https://speech.test/");await page.getByLabel("Project name",{exact:true}).fill("Source narration");await page.getByRole("button",{name:"Create project",exact:true}).click();
  const source="# Opening\nGrüße 世界 مرحبًا. Unsaved narration.";await page.locator('.cm-content[contenteditable="true"]').fill(source);
  await page.addScriptTag({content:axe.source});await inspectAccessibility("collapsed");
  stage="save latest edits before duplicating";await page.getByRole("button",{name:"Duplicate",exact:true}).click();const name=page.getByLabel("Copy name",{exact:true});assert.equal(await name.evaluate(element=>element===document.activeElement),true);await name.fill("Copied narration");await inspectAccessibility("expanded");await page.getByRole("button",{name:"Create copy",exact:true}).click();await page.waitForFunction(()=>window.speechFixture.projects.length===2);await page.waitForFunction(()=>document.querySelector('.tts-project-bar input')?.value==="Copied narration");
  assert.equal(await page.getByLabel("Title",{exact:true}).evaluate(element=>element===document.activeElement),true);
  const state=await page.evaluate(()=>({projects:window.speechFixture.projects,calls:window.speechFixture.calls}));const original=state.projects.find(project=>project.title==="Source narration"),copy=state.projects.find(project=>project.title==="Copied narration");assert.ok(original&&copy);assert.notEqual(copy.id,original.id);assert.equal(original.source,source);assert.equal(copy.source,source);const duplication=state.calls.find(call=>call.operation==="duplicateProject");assert.deepEqual(duplication.input,{id:original.id,expectedRevisionId:original.revisionId,title:"Copied narration"});assert.equal(state.calls.some(call=>["render","regenerate","beginLive"].includes(call.operation)),false);
  stage="independent copy edit";await page.locator('.cm-content[contenteditable="true"]').fill("Copied project edit.");await page.getByRole("button",{name:"Save",exact:true}).click();await page.waitForFunction(id=>window.speechFixture.projects.find(project=>project.id===id)?.source==="Copied project edit.",copy.id);assert.equal(await page.evaluate(id=>window.speechFixture.projects.find(project=>project.id===id)?.source,original.id),source);
  stage="cancel name entry";await page.getByRole("button",{name:"Duplicate",exact:true}).click();await page.getByRole("form",{name:"Copy project",exact:true}).getByRole("button",{name:"Cancel",exact:true}).click();assert.equal(await page.getByRole("button",{name:"Duplicate",exact:true}).evaluate(element=>element===document.activeElement),true);assert.equal(await page.evaluate(()=>window.speechFixture.calls.filter(call=>call.operation==="duplicateProject").length),1);assert.equal(await page.evaluate(()=>window.speechFixture.projects.length),2);assert.deepEqual(errors,[]);
  await writeFile(path.join(workspace,"docs/validation/text-to-speech/project-copy-ui-result-2026-10-20.json"),JSON.stringify({browser:"Microsoft Edge Chromium",serverStarted:false,providerExecution:false,transport:"deterministic project fixture; excludes native audio/history identity remapping",checks:["latest source saved before explicit revision-bound duplication","Unicode source retained and copy opened with title focus","copy edits leave original source unchanged","cancelled name entry performs no duplicate operation","no generation requested"],accessibility,errors},null,2));process.stdout.write("Project duplication UI checks passed.\n");
}catch(error){await writeFile(path.join(output,"failure.json"),JSON.stringify({stage,error:String(error).slice(0,4096),errors},null,2));throw error;}finally{await browser.close();}
