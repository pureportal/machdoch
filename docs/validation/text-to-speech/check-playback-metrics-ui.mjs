import {build} from "vite";
import {chromium} from "playwright-core";
import {mkdir,writeFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";
import assert from "node:assert/strict";

const workspace=path.resolve(fileURLToPath(new URL("../../..",import.meta.url)));
const root="D:/Models/machdoch/speech/verification/playback-metrics-ui";
const output=path.join(root,"dist");await mkdir(root,{recursive:true});
await writeFile(path.join(root,"index.html"),'<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Speech playback verification</title></head><body><script type="module" src="/main.ts"></script></body></html>');
await writeFile(path.join(root,"main.ts"),String.raw`
import {PlaybackMetrics,SpeechPlaybackCoordinator,createPcmPlaybackHandle,createAudioPlaybackHandle} from "@machdoch/speech";
type Startup={startedAt:number;phases:Record<string,number>};let activeStartup:Startup|undefined;
const contexts=new WeakMap<AudioContext,Startup>();
const observe=(value:Startup|undefined,phase:string)=>{if(value&&value.phases[phase]===undefined)value.phases[phase]=performance.now()-value.startedAt;};
const OriginalContext=AudioContext;
class ObservedContext extends OriginalContext{
 constructor(options?:AudioContextOptions){const startup=activeStartup;observe(startup,"contextConstructorRequested");super(options);observe(startup,"contextConstructed");if(!startup)return;contexts.set(this,startup);const addModule=this.audioWorklet.addModule.bind(this.audioWorklet);this.audioWorklet.addModule=(url,options)=>{observe(startup,"workletModuleRequested");return addModule(url,options).then(()=>{observe(startup,"workletModuleResolved");},error=>{observe(startup,"workletModuleRejected");throw error;});};}
 resume(){const startup=contexts.get(this);observe(startup,"resumeRequested");return super.resume().then(()=>{observe(startup,"resumeResolved");},error=>{observe(startup,"resumeRejected");throw error;});}
}
const OriginalNode=AudioWorkletNode;
class ObservedNode extends OriginalNode{
 constructor(context:BaseAudioContext,name:string,options?:AudioWorkletNodeOptions){super(context,name,options);const startup=contexts.get(context as AudioContext);if(!startup)return;let firstAppend:number|undefined;const post=this.port.postMessage.bind(this.port);this.port.postMessage=(message,transfer=[])=>{if(message?.type==="append"&&message.samples?.length>0&&firstAppend===undefined){firstAppend=message.id;observe(startup,"firstAppendPosted");}post(message,transfer);};this.port.addEventListener("message",event=>{if(event.data?.type==="first-render")observe(startup,"firstRenderNotification");else if(firstAppend!==undefined&&event.data?.id===firstAppend)observe(startup,"firstAppendAcknowledged");});}
}
Object.defineProperty(window,"AudioContext",{configurable:true,writable:true,value:ObservedContext});Object.defineProperty(window,"AudioWorkletNode",{configurable:true,writable:true,value:ObservedNode});
const metrics=new PlaybackMetrics(512);const player=new SpeechPlaybackCoordinator(undefined,metrics);
const pcm=new Uint8Array(96000);const view=new DataView(pcm.buffer);for(let i=0;i<48000;i++)view.setInt16(i*2,Math.round(Math.sin(i/24000*997*Math.PI*2)*8192),true);
const wave=new Uint8Array(44+pcm.length);wave.set(new TextEncoder().encode("RIFF"));const header=new DataView(wave.buffer);header.setUint32(4,wave.length-8,true);wave.set(new TextEncoder().encode("WAVEfmt "),8);header.setUint32(16,16,true);header.setUint16(20,1,true);header.setUint16(22,1,true);header.setUint32(24,24000,true);header.setUint32(28,48000,true);header.setUint16(32,2,true);header.setUint16(34,16,true);wave.set(new TextEncoder().encode("data"),36);header.setUint32(40,pcm.length,true);wave.set(pcm,44);const audioUrl=URL.createObjectURL(new Blob([wave],{type:"audio/wav"}));
function waitFor(event:string,after:number):Promise<void>{return new Promise((resolve,reject)=>{let timer:number;const check=()=>metrics.snapshot().some(sample=>sample.event===event&&sample.atMs>=after);const off=metrics.subscribe(()=>{if(check()){clearTimeout(timer);off();resolve();}});timer=window.setTimeout(()=>{off();reject(new Error("Missing playback measurement: "+event));},5000);if(check()){clearTimeout(timer);off();resolve();}});}
Object.assign(window,{playbackCheck:{snapshot:()=>({samples:metrics.snapshot(),state:player.snapshot()}),async run(transport:"pcm"|"html-audio"){
  const started=performance.now();let finish!:()=>void;let completed=false;let renderedBeforeCompletion=false;const gate=new Promise<void>(resolve=>{finish=resolve;});const off=metrics.subscribe(sample=>{if(sample.event==="first-render"&&sample.atMs>=started){renderedBeforeCompletion=!completed;finish();}});
  const startup:Startup={startedAt:started,phases:{}};activeStartup=transport==="pcm"?startup:undefined;
  const rendered=waitFor("first-render",started);
  try{
  await Promise.all([player.play({owner:"verification",itemId:crypto.randomUUID(),open:async signal=>transport==="pcm"?createPcmPlaybackHandle(async(offset,maxBytes)=>{
    if(offset>=65536)await gate;const bytes=pcm.slice(offset,offset+maxBytes);completed=offset+bytes.length===pcm.length;return {audioBase64:btoa(String.fromCharCode(...bytes)),nextOffset:offset+bytes.length,complete:completed,sampleRate:24000,channels:1};
  },signal):createAudioPlaybackHandle(audioUrl,{signal,duration:2})}),rendered]);
  const pauseAt=performance.now();const paused=waitFor("pause-ack",pauseAt);player.pause();await paused;await player.resume();const stopAt=performance.now();const stopped=waitFor("stop-ack",stopAt);player.stop();await stopped;
  return {samples:metrics.snapshot().filter(sample=>sample.atMs>=started),renderedBeforeCompletion:transport==="pcm"?renderedBeforeCompletion:null,startupPhases:transport==="pcm"?startup.phases:null};
  }finally{finish();off();player.stop();activeStartup=undefined;}
}}});
`);
await build({configFile:false,root,base:"./",logLevel:"error",resolve:{alias:{"@machdoch/speech":path.join(workspace,"packages/speech/src/index.ts")}},build:{outDir:output,emptyOutDir:true,minify:false}});
const temporary=path.join(root,"browser");await mkdir(temporary,{recursive:true});process.env.TEMP=temporary;process.env.TMP=temporary;
const browser=await chromium.launch({channel:"msedge",headless:true,args:["--autoplay-policy=no-user-gesture-required","--allow-file-access-from-files"]});const page=await browser.newPage();const errors=[];page.on("pageerror",error=>errors.push(error.message));
const percentile=(values,percent)=>values.toSorted((a,b)=>a-b)[Math.ceil(values.length*percent)-1];
let stage="open";
const observations=[];
try{
  await page.goto(pathToFileURL(path.join(output,"index.html")).href);await page.waitForFunction(()=>!!window.playbackCheck);
  for(const transport of ["pcm","html-audio"]){for(let index=0;index<20;index++){stage=`${transport} ${index+1}`;const result=await page.evaluate(kind=>window.playbackCheck.run(kind),transport);if(transport==="pcm")assert.equal(result.renderedBeforeCompletion,true);assert.equal(result.samples.filter(sample=>sample.event==="first-render").length,1);observations.push({transport,...result});}}
  const summaries=["pcm","html-audio"].map(transport=>{
    const samples=observations.filter(value=>value.transport===transport).flatMap(value=>value.samples);const first=samples.filter(value=>value.event==="first-render").map(value=>value.timeToFirstAudioMs);const pause=samples.filter(value=>value.event==="pause-ack").map(value=>value.latencyMs);const stop=samples.filter(value=>value.event==="stop-ack").map(value=>value.latencyMs);assert.equal(first.length,20);assert.equal(pause.length,20);assert.equal(stop.length,20);
    return {transport,count:20,firstAudioMs:{first:first[0],maximum:Math.max(...first),p50:percentile(first,.5),p95:percentile(first,.95)},pauseAcknowledgmentMs:{maximum:Math.max(...pause),p50:percentile(pause,.5),p95:percentile(pause,.95)},stopAcknowledgmentMs:{maximum:Math.max(...stop),p50:percentile(stop,.5),p95:percentile(stop,.95)}};
  });
  const startupPhases=observations.filter(value=>value.transport==="pcm").map(value=>value.startupPhases);
  await writeFile(path.join(workspace,"docs/validation/text-to-speech/playback-startup-phase-observation-2026-10-20.json"),JSON.stringify({browser:"Microsoft Edge Chromium",observationOnly:true,providerExecution:false,physicalOutputMeasured:false,clocks:"milliseconds from each benchmark run start; render notification is main-thread receipt",instrumentation:"verification-only subclasses forward actual AudioContext and AudioWorkletNode calls",thresholdsChanged:false,summaries,startupPhases,errors},null,2));
  for(const summary of summaries){assert.ok(summary.firstAudioMs.p95<300,JSON.stringify(summary));assert.ok(summary.pauseAcknowledgmentMs.p95<150,JSON.stringify(summary));assert.ok(summary.stopAcknowledgmentMs.p95<150,JSON.stringify(summary));}
  assert.deepEqual(errors,[]);await writeFile(path.join(workspace,"docs/validation/text-to-speech/playback-metrics-ui-result-2026-10-20.json"),JSON.stringify({browser:"Microsoft Edge Chromium",serverStarted:false,syntheticAudio:true,providerExecution:false,assetTransport:"built local files with explicit test file-access flag",autoplayPolicy:"test launch override",measurementScope:"browser render-notification receipt and API acknowledgment; physical output latency unmeasured",pcmRenderedBeforeSourceCompletion:true,summaries,startupPhases,errors},null,2));process.stdout.write(JSON.stringify(summaries)+"\n");
}catch(error){await writeFile(path.join(root,"failure.json"),JSON.stringify({stage,error:String(error).slice(0,4096),errors,observations,snapshot:await page.evaluate(()=>window.playbackCheck?.snapshot())},null,2));throw error;}finally{await browser.close();}
