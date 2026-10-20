import {build} from "vite";
import react from "@vitejs/plugin-react";
import {chromium} from "playwright-core";
import {readFile,mkdir,writeFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {createRequire} from "node:module";
import assert from "node:assert/strict";

const root=fileURLToPath(new URL("./ui",import.meta.url));const workspace=path.resolve(root,"../../../..");const output="D:/Models/machdoch/speech/verification/diagnostics-ui";
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
  await page.goto("https://speech.test/");await page.getByLabel("Project name",{exact:true}).fill("Diagnostic preview verification");await page.getByRole("button",{name:"Create project",exact:true}).click();await page.getByRole("button",{name:"Settings",exact:true}).click();
  const fish=page.locator("form").filter({has:page.getByRole("heading",{name:"fish-cloud",exact:true})});await fish.getByLabel("API key",{exact:true}).fill("PRIVATE_UI_ONLY_KEY");
  const diagnostics=page.locator("details").filter({has:page.locator("summary",{hasText:/^Diagnostics$/u})});await diagnostics.locator("summary").click();assert.equal(await diagnostics.getByRole("link",{name:"Save diagnostics",exact:true}).count(),0);assert.equal(await page.evaluate(()=>window.speechFixture.calls.filter(call=>call.operation==="getDiagnostics").length),0);
  await diagnostics.getByRole("button",{name:"Prepare diagnostics",exact:true}).click();await diagnostics.getByRole("link",{name:"Save diagnostics",exact:true}).waitFor();const preview=await diagnostics.getByLabel("Diagnostic preview",{exact:true}).innerText();const bundle=JSON.parse(preview);assert.equal(bundle.schema,"machdoch-speech-diagnostics");assert.equal(bundle.connections[0].model,"drama-3");assert.equal(preview.includes("PRIVATE_UI_ONLY_KEY"),false);assert.equal(preview.includes("Diagnostic preview verification"),false);
  const pending=page.waitForEvent("download");await diagnostics.getByRole("link",{name:"Save diagnostics",exact:true}).click();const download=await pending;await download.saveAs(path.join(output,"diagnostics.json"));assert.deepEqual(JSON.parse(await readFile(path.join(output,"diagnostics.json"),"utf8")),bundle);
  const calls=await page.evaluate(()=>window.speechFixture.calls);assert.deepEqual(calls.filter(call=>call.operation==="getDiagnostics").map(call=>call.input),[{limit:100}]);assert.equal(calls.filter(call=>["setConnection","render","designVoice","createVoice"].includes(call.operation)).length,0);assert.deepEqual(errors,[]);
  await writeFile(path.join(workspace,"docs/validation/text-to-speech/diagnostics-ui-result-2026-10-20.json"),JSON.stringify({browser:"Microsoft Edge Chromium",serverStarted:false,syntheticRuntime:true,checks:["explicit preparation","review before save","download equals previewed snapshot","unsaved API key and project title excluded","no credential mutation or generation"],errors},null,2));process.stdout.write("Diagnostic preview and download checks passed.\n");
}catch(error){await writeFile("D:/Models/machdoch/speech/verification/diagnostics-ui-failure.json",JSON.stringify({error:String(error).split("\n")[0],errors},null,2));throw new Error(String(error).split("\n")[0]);}finally{await browser.close();}
