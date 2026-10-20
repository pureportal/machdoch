import {build} from "vite";
import react from "@vitejs/plugin-react";
import {chromium} from "playwright-core";
import {mkdir,writeFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";
import {createRequire} from "node:module";
import assert from "node:assert/strict";

const workspace=path.resolve(fileURLToPath(new URL("../../..",import.meta.url)));
const require=createRequire(path.join(workspace,"apps/client/package.json"));const root="D:/Models/machdoch/speech/verification/cache-cleanup-ui";
await mkdir(root,{recursive:true});
await writeFile(path.join(root,"index.html"),'<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Cache cleanup verification</title></head><body><div id="root"></div><script type="module" src="/main.tsx"></script></body></html>');
await writeFile(path.join(root,"main.tsx"),String.raw`
import React,{useState} from "react";
import {createRoot} from "react-dom/client";
import {SettingsPanel} from "@settings-panel";
let calls=0;let inputs:boolean[]=[];let mode="success";let release!:()=>void;const first=new Promise<void>(resolve=>{release=resolve;});
const runtime={transport:"native",execute:async(operation:string,input:{restart:boolean})=>{if(operation!=="cleanCache")throw new Error("Unexpected verification operation: "+operation);calls++;inputs.push(input.restart);if(input.restart!==(calls===1))throw new Error("Only the first request may restart cleanup");if(calls>3)throw new Error("Cleanup did not terminate");if(mode==="partial-failure"&&calls===2)throw new Error("Synthetic storage failure. Repair storage and clean again.");if(mode==="success"&&calls===1)await first;return {assets:0,bytes:0,pending:calls<3};}};
const settings={connections:[],modelRoot:"D:\Models\machdoch",cloudConsent:false,maxConcurrent:1,pricing:null,budgetLimit:null,answerBudgetLimit:null,answerCharacterLimit:10000,cacheRetentionDays:7};
function App(){const [busy,setBusy]=useState(false);const [error,setError]=useState<string|null>(null);const run=async(action:()=>Promise<unknown>)=>{setBusy(true);setError(null);try{await action();}catch(error){setError(String(error));}finally{setBusy(false);}};return <main><h1>Cache cleanup verification</h1>{error&&<p role="alert">{error}</p>}<SettingsPanel runtime={runtime} settings={settings} saved={()=>{}} run={run} busy={busy}/></main>;}
Object.assign(window,{cleanupCheck:{calls:()=>calls,inputs:()=>inputs,release,mode:(value:string)=>{mode=value;calls=0;inputs=[];}}});createRoot(document.getElementById("root")!).render(<App/>);
`);
await build({configFile:false,root,base:"./",plugins:[react()],logLevel:"error",resolve:{dedupe:["react","react-dom"],alias:{react:path.dirname(require.resolve("react/package.json")),"react-dom":path.dirname(require.resolve("react-dom/package.json")),"@machdoch/speech":path.join(workspace,"packages/speech/src/index.ts"),"@settings-panel":path.join(workspace,"packages/text-to-speech/src/settings.tsx")}},build:{outDir:path.join(root,"dist"),emptyOutDir:true,minify:false}});
const temporary=path.join(root,"browser");await mkdir(temporary,{recursive:true});process.env.TEMP=temporary;process.env.TMP=temporary;
const browser=await chromium.launch({channel:"msedge",headless:true,args:["--allow-file-access-from-files"]});const page=await browser.newPage();const errors=[];page.on("pageerror",error=>errors.push(error.message));let stage="open";
try{
  await page.goto(pathToFileURL(path.join(root,"dist/index.html")).href);const clean=page.getByRole("button",{name:"Clean expired audio",exact:true});await clean.waitFor();
  stage="progress across bounded batches";await clean.click();await page.getByRole("status").filter({hasText:"Cleaning cache…"}).waitFor();assert.equal(await clean.isDisabled(),true);assert.equal(await page.evaluate(()=>window.cleanupCheck.calls()),1);await page.evaluate(()=>window.cleanupCheck.release());await page.getByRole("status").filter({hasText:"Cache cleanup finished."}).waitFor();assert.equal(await page.evaluate(()=>window.cleanupCheck.calls()),3);assert.deepEqual(await page.evaluate(()=>window.cleanupCheck.inputs()),[true,false,false]);assert.equal(await clean.isEnabled(),true);
  stage="stop on partial cleanup failure";await page.evaluate(()=>window.cleanupCheck.mode("partial-failure"));await clean.click();await page.getByRole("alert").filter({hasText:"Synthetic storage failure"}).waitFor();assert.equal(await page.evaluate(()=>window.cleanupCheck.calls()),2);assert.equal(await page.getByRole("status").filter({hasText:/Cleaning cache|Cache cleanup finished/}).count(),0);assert.equal(await clean.isEnabled(),true);
  stage="explicit recovery";await page.evaluate(()=>window.cleanupCheck.mode("success"));await clean.click();await page.getByRole("status").filter({hasText:"Cache cleanup finished."}).waitFor();assert.equal(await page.getByRole("alert").count(),0);assert.equal(await page.evaluate(()=>window.cleanupCheck.calls()),3);assert.deepEqual(errors,[]);
  await writeFile(path.join(workspace,"docs/validation/text-to-speech/cache-cleanup-ui-result-2026-10-20.json"),JSON.stringify({browser:"Microsoft Edge Chromium",serverStarted:false,providerExecution:false,transport:"deterministic cleanup receipts; native filesystem/refcount tests are separate",checks:["one action drains bounded cleanup batches","progress and disabled action while a request is pending","a partial storage failure stops the loop and clears stale progress","explicit retry completes and clears the error"],errors},null,2));process.stdout.write("Bounded cache cleanup UI checks passed.\n");
}catch(error){await writeFile(path.join(root,"failure.json"),JSON.stringify({stage,error:String(error).slice(0,4096),errors},null,2));throw error;}finally{await browser.close();}
