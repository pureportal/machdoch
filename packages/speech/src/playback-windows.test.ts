import { test } from "node:test";
import assert from "node:assert/strict";
import { SpeechPlaybackCoordinator, type PlaybackHandle, type PlaybackState } from "./playback.ts";

function until(coordinator: SpeechPlaybackCoordinator, status: PlaybackState["status"]): Promise<void> {
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{dispose();reject(new Error("Expected playback state "+status));},2000);
    let dispose=()=>{};
    dispose=coordinator.subscribe(state=>{if(state.status===status){clearTimeout(timer);queueMicrotask(()=>dispose());resolve();}});
  });
}

test("another window replaces foreground speech and remote recording pauses a loading render", async () => {
  const name="speech-test-"+crypto.randomUUID();
  const firstChannel=new BroadcastChannel(name),secondChannel=new BroadcastChannel(name);
  const first=new SpeechPlaybackCoordinator(()=>firstChannel),second=new SpeechPlaybackCoordinator(()=>secondChannel);
  let stopped=false,plays=0;
  const handle:PlaybackHandle={play:async()=>{},pause(){},stop(){stopped=true;},seek(){},setRate(){},setVolume(){},onState:()=>()=>{}};
  try {
    await first.play({owner:"chat",itemId:"answer",open:async()=>handle});
    const replaced=until(first,"idle");
    await second.play({owner:"studio",itemId:"take",open:async()=>({...handle,stop(){}})});
    await replaced;
    assert.equal(stopped,true);
    assert.equal(second.snapshot().status,"playing");
    let finish:((handle:PlaybackHandle)=>void)|undefined;
    const loading=second.play({owner:"studio",itemId:"loading",open:()=>new Promise(resolve=>{finish=resolve;})});
    await new Promise<void>(resolve=>{firstChannel.addEventListener("message",()=>resolve(),{once:true});});
    const paused=until(second,"paused");
    first.pause();
    await paused;
    finish!({...handle,play:async()=>{plays++;},stop(){}});
    await loading;
    assert.equal(plays,0);
    await second.resume();
    assert.equal(plays,1);
  } finally {first.stop();second.stop();firstChannel.close();secondChannel.close();}
});
