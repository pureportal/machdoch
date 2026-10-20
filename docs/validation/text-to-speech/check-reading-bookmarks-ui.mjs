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
const root="D:/Models/machdoch/speech/verification/reading-bookmarks-ui";
await mkdir(root,{recursive:true});
await writeFile(path.join(root,"index.html"),'<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Reading bookmark verification</title></head><body><div id="root"></div><script type="module" src="/main.tsx"></script></body></html>');
await writeFile(path.join(root,"main.tsx"),String.raw`
import React,{useEffect,useState} from "react";
import {createRoot} from "react-dom/client";
import {speechPlayback} from "@machdoch/speech";
import {ReadingBookmarks} from "@reading-bookmarks";
import {OWNER} from "@speech-controls";
const take=(id:string,duration:number)=>({id,asset:{sha256:id==="second"?"b".repeat(64):"a".repeat(64),duration}});
let lastRead:number|null=null;let saved:any[]=[];
async function start(owner:string){await speechPlayback.play({owner,itemId:owner===OWNER?"reading:fixture":"answer:fixture",open:async()=>{
 const listeners=new Set<Function>();let state={status:"paused",position:4.25,duration:8,seekable:true};const emit=(status:string)=>{state={...state,status};for(const listener of listeners)listener(state);};
 return {play:async()=>emit("playing"),pause:()=>emit("paused"),stop:()=>emit("idle"),seek:()=>{},onState:(listener:Function)=>{listeners.add(listener);listener(state);return()=>listeners.delete(listener);}};
}});}
function App(){const [state,setState]=useState(speechPlayback.snapshot());const [bookmarks,setBookmarks]=useState<any[]>([]);const [longer,setLonger]=useState(false);const [replaced,setReplaced]=useState(false);const [error,setError]=useState<string|null>(null);useEffect(()=>speechPlayback.subscribe(setState),[]);const onChange=(value:any[])=>{saved=value;setBookmarks(value);};const sequence={takes:[take("first",longer?9:3),take(replaced?"replacement":"second",5)],offsets:[0,longer?9:3],duration:longer?14:8,signature:"fixture"};return <main tabIndex={-1}><h1>Reading bookmark verification</h1><button onClick={()=>void start(OWNER)}>Start reading</button><button onClick={()=>void start("chat:fixture")}>Start answer</button><button onClick={()=>setLonger(true)}>Lengthen earlier chapter</button><button onClick={()=>setReplaced(true)}>Replace bookmarked take</button><button onClick={()=>onChange(Array.from({length:25},(_,i)=>({id:"seed-"+i,label:"Seed "+i,takeId:"first",assetSha256:"a".repeat(64),seconds:0})))}>Seed bookmarks</button><button onClick={()=>onChange([{id:"last",label:"Last",takeId:"first",assetSha256:"a".repeat(64),seconds:0}])}>Seed one bookmark</button>{error&&<p role="alert">{error}</p>}<ReadingBookmarks bookmarks={bookmarks} sequence={sequence} itemId="reading:fixture" state={state} busy={false} run={async action=>{try{await action();setError(null);}catch(error){setError(String(error));}}} onRead={async seconds=>{lastRead=seconds;}} onChange={onChange} onEmpty={()=>document.querySelector("main")?.focus()}/></main>;}
Object.assign(window,{bookmarkCheck:{bookmarks:()=>saved,lastRead:()=>lastRead,snapshot:()=>speechPlayback.snapshot()}});createRoot(document.getElementById("root")!).render(<App/>);
`);
await build({configFile:false,root,base:"./",plugins:[react()],logLevel:"error",resolve:{dedupe:["react","react-dom"],alias:{react:path.dirname(require.resolve("react/package.json")),"react-dom":path.dirname(require.resolve("react-dom/package.json")),"@machdoch/speech":path.join(workspace,"packages/speech/src/index.ts"),"@speech-controls":path.join(workspace,"packages/text-to-speech/src/controls.tsx"),"@reading-bookmarks":path.join(workspace,"packages/text-to-speech/src/reading-bookmarks.tsx")}},build:{outDir:path.join(root,"dist"),emptyOutDir:true,minify:false}});
const temporary=path.join(root,"browser");await mkdir(temporary,{recursive:true});process.env.TEMP=temporary;process.env.TMP=temporary;
const browser=await chromium.launch({channel:"msedge",headless:true,args:["--allow-file-access-from-files"]});const page=await browser.newPage();const errors=[];page.on("pageerror",error=>errors.push(error.message));
let stage="open";
try{
  await page.goto(pathToFileURL(path.join(root,"dist/index.html")).href);await page.getByRole("heading",{name:"Reading bookmark verification",exact:true}).waitFor();assert.equal(await page.getByRole("region",{name:"Reading bookmarks",exact:true}).count(),0);
  stage="capture actual owned clock";await page.getByRole("button",{name:"Start reading",exact:true}).click();await page.getByLabel("Bookmark name",{exact:true}).fill("Passage");await page.getByRole("button",{name:"Add bookmark",exact:true}).click();await page.getByRole("button",{name:"Read bookmark Passage",exact:true}).waitFor();assert.equal(await page.getByLabel("Bookmark name",{exact:true}).evaluate(element=>element===document.activeElement),true);const captured=await page.evaluate(()=>window.bookmarkCheck.bookmarks()[0]);assert.equal(captured.takeId,"second");assert.equal(captured.seconds,1.25);assert.equal(captured.assetSha256,"b".repeat(64));
  stage="earlier duration change";await page.getByRole("button",{name:"Lengthen earlier chapter",exact:true}).click();await page.getByRole("button",{name:"Read bookmark Passage",exact:true}).click();await page.waitForFunction(()=>window.bookmarkCheck.lastRead()===10.25);
  stage="replacement cannot move bookmark";await page.getByRole("button",{name:"Replace bookmarked take",exact:true}).click();assert.equal(await page.getByRole("button",{name:"Read bookmark Passage",exact:true}).isDisabled(),true);await page.getByText("The bookmarked take is missing or no longer selected. Select it again or remove the bookmark.",{exact:true}).waitFor();
  stage="foreground ownership";await page.getByRole("button",{name:"Start answer",exact:true}).click();await page.getByLabel("Bookmark name",{exact:true}).waitFor({state:"hidden"});assert.equal(await page.getByRole("button",{name:"Read bookmark Passage",exact:true}).count(),1);
  stage="bounded pages and focus";await page.getByRole("button",{name:"Seed bookmarks",exact:true}).click();const region=page.getByRole("region",{name:"Reading bookmarks",exact:true});assert.equal(await region.locator("li").count(),20);await page.getByRole("button",{name:"Next bookmarks",exact:true}).click();assert.equal(await region.locator("li").count(),5);assert.equal(await region.evaluate(element=>element===document.activeElement),true);await page.getByRole("button",{name:"Remove bookmark Seed 24",exact:true}).click();assert.equal(await region.locator("li").count(),4);assert.equal(await region.evaluate(element=>element===document.activeElement),true);await page.getByRole("button",{name:"Seed one bookmark",exact:true}).click();await page.getByRole("button",{name:"Remove bookmark Last",exact:true}).click();await region.waitFor({state:"hidden"});assert.equal(await page.locator("main").evaluate(element=>element===document.activeElement),true);assert.deepEqual(errors,[]);
  await writeFile(path.join(workspace,"docs/validation/text-to-speech/reading-bookmarks-ui-result-2026-10-20.json"),JSON.stringify({browser:"Microsoft Edge Chromium",serverStarted:false,audioHandle:"synthetic measured coordinator fixture",realAudioPlayback:false,checks:["capture only the active project reading clock","bookmark binds immutable take hash and local seconds","earlier chapter duration changes preserve position","replacement disables stale bookmark with recovery","foreground answer hides capture controls","20-item pages and focus after add, paging and removal"],errors},null,2));process.stdout.write("Measured reading bookmark UI checks passed.\n");
}catch(error){await writeFile(path.join(root,"failure.json"),JSON.stringify({stage,error:String(error).slice(0,4096),errors},null,2));throw error;}finally{await browser.close();}
