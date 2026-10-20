import {readFile,writeFile,mkdir,stat} from "node:fs/promises";
import {createReadStream} from "node:fs";
import {createHash} from "node:crypto";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import path from "node:path";
import assert from "node:assert/strict";
import {compileSpeechScript,speechCastBindings,speechRenderSegment,orderedProductionTakes} from "../../../packages/speech/src/index.ts";

const directory="D:/Models/machdoch/speech/verification/long-form";
await mkdir(directory,{recursive:true});
const cast=[{id:"narrator",name:"Narrator",voiceId:"synthetic-voice",referenceAssetIds:[],direction:""}];
const paragraph="Morning light crossed the river. The passengers counted the windows and waited by the station. Grüße aus der alten Stadt. 世界の旅は静かに続いた. ";
const source=Array.from({length:48},(_,index)=>`# Chapter ${index+1}\nThe account for chapter ${index+1} begins here.\n${paragraph.repeat(54)}\n`).join("\n");
const options={backend:"fish-cloud",cast:speechCastBindings(cast)};
const initial=compileSpeechScript(source,options);
assert.deepEqual(initial.diagnostics.filter(item=>item.severity==="error"),[]);
assert.equal(initial.segments.length,48);
const revisedSource=source.replace("The account for chapter 24 begins here.","A sealed letter arrives at the beginning of chapter 24.");
const revised=compileSpeechScript(revisedSource,options);
assert.equal(revised.segments.length,48);
const before=new Set(initial.segments.map(segment=>segment.id));
const unchanged=revised.segments.filter(segment=>before.has(segment.id));
assert.equal(unchanged.length,47);
const selected=Object.fromEntries(initial.segments.map((segment,index)=>[segment.id,`take-${index}`]));
const takes=initial.segments.map((segment,index)=>({id:`take-${index}`,projectId:"book",segmentId:segment.id}));
assert.throws(()=>orderedProductionTakes({id:"book",selectedTakes:selected},takes,revised.segments.map(segment=>segment.id),true),/Select a take for every current script segment/);
const encoderRoot="D:/Models/machdoch/speech/encoder";
const manifest=JSON.parse(await readFile(path.join(encoderRoot,"manifest.json"),"utf8"));
const binaries={};
for(const [field,digest] of [["binary","3256173f3f8bffd7df12227c68adf68025edb1832273a9530688a7bb1ed8edec"],["ffprobe","f0d36ecbbdd3bcfac3efa078c96c7271c2e68b3810595552ac3b7f17e9a65c52"]]){
  const binary=path.resolve(encoderRoot,manifest[field]);assert.ok(binary.startsWith(path.resolve(encoderRoot)+path.sep));const hash=createHash("sha256");for await(const chunk of createReadStream(binary))hash.update(chunk);assert.equal(hash.digest("hex"),digest);binaries[field]=binary;
}
const execute=promisify(execFile);
const environment={...process.env,TEMP:directory,TMP:directory};
const audio=[];
for(const frequency of [997,499]){
  const file=path.join(directory,`book-tone-${frequency}-8k-mono-600s.wav`);
  let exists=true;try{await stat(file);}catch(error){if(error.code!=="ENOENT")throw error;exists=false;}
  if(!exists)await execute(binaries.binary,["-nostdin","-hide_banner","-loglevel","error","-f","lavfi","-i",`sine=frequency=${frequency}:sample_rate=8000:duration=600`,"-ac","1","-c:a","pcm_s16le","-n",file],{env:environment,windowsHide:true,maxBuffer:65536});
  const {stdout}=await execute(binaries.ffprobe,["-v","error","-show_entries","stream=sample_rate,channels,codec_name:format=duration,size","-of","json",file],{env:environment,windowsHide:true,maxBuffer:65536});const info=JSON.parse(stdout);assert.equal(info.streams[0].sample_rate,"8000");assert.equal(info.streams[0].channels,1);assert.equal(Number(info.format.duration),600);assert.equal(info.streams[0].codec_name,"pcm_s16le");audio.push(file);
}
const fixture={schema:"machdoch-speech-book-verification",version:1,syntheticAudio:true,providerExecution:false,source,revisedSource,cast,segments:initial.segments.map(segment=>speechRenderSegment(segment)),revisedSegments:revised.segments.map(segment=>speechRenderSegment(segment)),unchangedSegments:unchanged.length,characters:Array.from(source).length,utf8Bytes:Buffer.byteLength(source),durationPerChapter:600,sampleRate:8000,channels:1,audio};
await writeFile(path.join(directory,"book-fixture-2026-10-20.json"),JSON.stringify(fixture));
await writeFile(new URL("./book-preparation-result-2026-10-20.json",import.meta.url),JSON.stringify({syntheticAudio:true,providerExecution:false,chapters:48,segments:initial.segments.length,characters:fixture.characters,utf8Bytes:fixture.utf8Bytes,unchangedSegments:unchanged.length,changedSegments:1,oldSelectionRejectedForChangedSegment:true,intendedAudioHours:8,sampleRate:8000,channels:1,completeAssemblyVerified:false},null,2));
process.stdout.write(`Prepared ${fixture.utf8Bytes} UTF-8 bytes, 48 chapters and synthetic lossless audio; 47 segment IDs survive a selective edit. Assembly is not verified by this preparation step.\n`);
