import {build} from "vite";
import react from "@vitejs/plugin-react";
import {chromium} from "playwright-core";
import {mkdir,writeFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";
import {createRequire} from "node:module";
import assert from "node:assert/strict";

const workspace=path.resolve(fileURLToPath(new URL("../../..",import.meta.url)));
const require=createRequire(path.join(workspace,"apps/client/package.json"));
const root="D:/Models/machdoch/speech/verification/reading-timer-ui";
await mkdir(root,{recursive:true});
await writeFile(path.join(root,"index.html"),'<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Reading timer verification</title></head><body><div id="root"></div><script type="module" src="/main.tsx"></script></body></html>');
await writeFile(path.join(root,"main.tsx"),String.raw`
import React,{useEffect,useState} from "react";
import {createRoot} from "react-dom/client";
import {speechPlayback} from "@machdoch/speech";
import {SpeechCreativeTools} from "@creative-tools";
import {OWNER} from "@speech-controls";
const project={id:"timer-project",title:"Reading",source:"Hello.",cast:[],profileId:null,revisionId:"revision",parentRevisionId:null,createdAt:"",updatedAt:"",archived:false,location:null,timeline:[],selectedTakes:{},bookmarks:[],variants:[]};
const runtime={execute:async()=>[]};
async function start(owner:string,itemId:string){await speechPlayback.play({owner,itemId,open:async()=>{
 const listeners=new Set<Function>();let state={status:"paused",position:0,duration:null,seekable:false};
 const emit=(status:string)=>{state={...state,status};for(const listener of listeners)listener(state);};
 return {play:async()=>emit("playing"),pause:()=>emit("paused"),stop:()=>emit("idle"),seek:()=>{},onState:(listener:Function)=>{listeners.add(listener);listener(state);return()=>listeners.delete(listener);}};
}});}
function App(){const [state,setState]=useState(speechPlayback.snapshot());useEffect(()=>speechPlayback.subscribe(setState),[]);return <main><h1>Reading timer</h1><button onClick={()=>void start(OWNER,"reading:fixture")}>Start reading</button><button onClick={()=>void start("chat:fixture","answer:fixture")}>Start answer</button><output aria-label="Playback state">{JSON.stringify({owner:state.owner,status:state.status})}</output><SpeechCreativeTools runtime={runtime} project={project} sentences={[]} onChange={()=>{}} onJump={()=>{}}/></main>;}
let fileReads=0;const original=File.prototype.text;File.prototype.text=function(){fileReads++;return original.call(this);};Object.assign(window,{readingTimerCheck:{snapshot:()=>speechPlayback.snapshot(),fileReads:()=>fileReads}});
createRoot(document.getElementById("root")!).render(<App/>);
`);
await build({configFile:false,root,base:"./",plugins:[react()],logLevel:"error",resolve:{dedupe:["react","react-dom"],alias:{react:path.dirname(require.resolve("react/package.json")),"react-dom":path.dirname(require.resolve("react-dom/package.json")),"@machdoch/speech":path.join(workspace,"packages/speech/src/index.ts"),"@speech-controls":path.join(workspace,"packages/text-to-speech/src/controls.tsx"),"@creative-tools":path.join(workspace,"packages/text-to-speech/src/creative-tools.tsx")}},build:{outDir:path.join(root,"dist"),emptyOutDir:true,minify:false}});
const temporary=path.join(root,"browser");await mkdir(temporary,{recursive:true});process.env.TEMP=temporary;process.env.TMP=temporary;
const browser=await chromium.launch({channel:"msedge",headless:true,args:["--allow-file-access-from-files"]});const page=await browser.newPage();const errors=[];page.on("pageerror",error=>errors.push(error.message));
let stage="open";
try{
  await page.clock.install({time:new Date("2026-10-20T12:00:00Z")});await page.goto(pathToFileURL(path.join(root,"dist/index.html")).href);await page.getByRole("heading",{name:"Reading timer",exact:true}).waitFor();
  await page.locator("summary").filter({hasText:/^Reading$/u}).click();await page.getByRole("button",{name:"Set sleep timer",exact:true}).click();await page.getByRole("alert").filter({hasText:"Start project reading"}).waitFor();
  stage="timer pauses its reading";await page.getByRole("button",{name:"Start reading",exact:true}).click();await page.getByLabel("Sleep minutes",{exact:true}).fill("1");await page.getByRole("button",{name:"Set sleep timer",exact:true}).click();await page.getByRole("button",{name:"Cancel sleep timer",exact:true}).waitFor();await page.clock.fastForward(60000);await page.waitForFunction(()=>window.readingTimerCheck.snapshot().status==="paused");
  stage="replacement cancels the old reading timer";await page.getByRole("button",{name:"Start reading",exact:true}).click();await page.getByRole("button",{name:"Set sleep timer",exact:true}).click();await page.getByRole("button",{name:"Start answer",exact:true}).click();await page.getByRole("button",{name:"Cancel sleep timer",exact:true}).waitFor({state:"hidden"});await page.clock.fastForward(60000);await page.getByRole("button",{name:"Pause",exact:true}).click();assert.deepEqual(await page.evaluate(()=>({owner:window.readingTimerCheck.snapshot().owner,status:window.readingTimerCheck.snapshot().status})),{owner:"chat:fixture",status:"playing"});
  stage="explicit cancellation";await page.getByRole("button",{name:"Start reading",exact:true}).click();await page.getByRole("button",{name:"Set sleep timer",exact:true}).click();await page.getByRole("button",{name:"Cancel sleep timer",exact:true}).click();await page.clock.fastForward(60000);assert.equal(await page.evaluate(()=>window.readingTimerCheck.snapshot().status),"playing");
  stage="file size before text decoding";await page.locator("summary").filter({hasText:/^Import$/u}).click();await page.getByLabel("File",{exact:true}).setInputFiles({name:"too-large.txt",mimeType:"text/plain",buffer:Buffer.alloc(4*1024*1024+1)});await page.getByRole("alert").filter({hasText:"no larger than 4 MiB"}).waitFor();assert.equal(await page.evaluate(()=>window.readingTimerCheck.fileReads()),0);assert.deepEqual(errors,[]);
  await writeFile(path.join(workspace,"docs/validation/text-to-speech/reading-timer-ui-result-2026-10-20.json"),JSON.stringify({browser:"Microsoft Edge Chromium",serverStarted:false,fakeAudioHandle:true,realAudioPlayback:false,clock:"Playwright virtual timers",checks:["requires active project reading","timer pauses only its reading item","foreground replacement cancels the timer","reading controls do not pause another owner","explicit timer cancellation","oversized import rejected before file.text"],errors},null,2));process.stdout.write("Reading timer ownership and import-boundary UI checks passed.\n");
}catch(error){await writeFile(path.join(root,"failure.json"),JSON.stringify({stage,error:String(error).slice(0,4096),errors},null,2));throw error;}finally{await browser.close();}
