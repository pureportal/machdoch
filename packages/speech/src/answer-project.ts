import { markdownToSpeech, type FinalAnswerEvent } from "./answer.ts";
import { speechContentHash } from "./compiler.ts";
import type { SpeechProfile, SpeechProject, SpeechRuntime } from "./runtime.ts";
import {speechProfileCast} from "./profile-binding.ts";

export async function openAnswerSpeechProject(runtime: SpeechRuntime, answer: FinalAnswerEvent, profile: SpeechProfile | null): Promise<SpeechProject> {
  if (!answer.complete || answer.channel !== "final" || answer.audience !== "user") throw new Error("Open a completed user-facing answer in Text to Speech.");
  const source = markdownToSpeech(answer.markdown);
  if (!source) throw new Error("This answer contains no speakable text.");
  const id = "answer-" + await speechContentHash([answer.sessionId, answer.answerId, answer.revision]);
  const {projects} = await runtime.execute("listProjects", {id,offset:0,limit:1});
  if(projects.length>1||projects.some(project=>project.id!==id))throw new Error("The answer project lookup returned an unrelated project.");
  const existing = projects[0];
  if (existing) return runtime.execute("getProject", { id });
  const now = new Date().toISOString();
  return runtime.execute("saveProject", { expectedRevisionId: null, project: {
    id, title: Array.from(source).slice(0,80).join(""), source,
    profileId: profile?.id ?? null,
    cast: profile?speechProfileCast(profile):[],
    revisionId:"",parentRevisionId:null,createdAt:now,updatedAt:now,archived:false,location:null,
    timeline:[],selectedTakes:{},bookmarks:[],variants:[],
    answerOrigin:{sessionId:answer.sessionId,answerId:answer.answerId,revision:answer.revision},
  }});
}
