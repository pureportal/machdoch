import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AnswerSpeechLedger, createSpeechPlayback, createSystemSpeechHandle,
  markdownToSpeech, speechPlayback, openAnswerSpeechProject, type SpeechProfile,
  StreamingAnswerPlayback,answerSpeechRevision,createAudioPlaybackHandle,speechProfileBinding,retainSpeechPlayback,
} from "@machdoch/speech";
import type { UserVoiceSettings } from "../../runtime";
import type { ChatSessionMessage, ShellVoiceSettings } from "../../chat-session.model";
import { speechAssetUrl, speechRuntime } from "../../speech-runtime";
import { getFinalSpeechAnswer } from "./execution-message";

export interface ChatSessionVoiceOption { voiceURI: string; label: string; lang: string; isDefault: boolean }
export interface UseChatSessionVoiceOptions {
  activeSessionId: string;
  settings: ShellVoiceSettings;
  aiVoiceSettings: UserVoiceSettings;
  visibleMessages: ChatSessionMessage[];
  refreshKey?: boolean;
  onSettingsChange: (updater: (settings: ShellVoiceSettings) => ShellVoiceSettings) => void;
  conversationAutoSpeakOverride?: boolean;
  onConversationAutoSpeakChange: (value: boolean | undefined) => void;
  conversationProfileId?: string;
  onConversationProfileChange: (value: string | undefined) => void;
}
export interface ChatSessionVoiceController {
  answerMode:"completed"|"streaming";
  streamingSupported:boolean;
  setAnswerMode(mode:"completed"|"streaming"):void;
  supported: boolean;
  systemVoicesSupported: boolean;
  autoSpeakResponses: boolean;
  conversationAutoSpeak: "default" | "manual" | "auto";
  setConversationAutoSpeak: (value: "default" | "manual" | "auto") => void;
  conversationProfileId: string | undefined;
  conversationProfiles: Array<{ id: string; name: string }>;
  setConversationProfile: (value: string | undefined) => void;
  availabilityDescription: string;
  preferredVoiceURI: string | null;
  rate: number;
  speakingMessageId: string | null;
  errorText: string | null;
  voiceOptions: ChatSessionVoiceOption[];
  setAutoSpeakResponses: (enabled: boolean) => void;
  setPreferredVoiceURI: (voiceURI: string | null) => void;
  setRate: (rate: number) => void;
  speakMessage: (message: ChatSessionMessage) => void;
  speakSelection: (message: ChatSessionMessage, selection: string) => void;
  openInStudio: (message: ChatSessionMessage) => void;
  saveAudio: (message: ChatSessionMessage) => void;
  canSaveAudio: boolean;
  pauseSpeaking: () => void;
  resumeSpeaking: () => void;
  stopSpeaking: () => void;
}

const ledger = new AnswerSpeechLedger();
const streamedAnswers=new Map<string,string>();
function rememberStream(key:string,value:string):void{
  streamedAnswers.set(key,value);
  if(streamedAnswers.size>1000)streamedAnswers.delete(streamedAnswers.keys().next().value!);
}
const rate = (value: number): number => Number.isFinite(value) ? Math.min(1.4, Math.max(0.8, value)) : 1;
const systemSupported = (): boolean => typeof window !== "undefined" && typeof window.speechSynthesis !== "undefined" && typeof SpeechSynthesisUtterance !== "undefined";

export const useChatSessionVoice = (options: UseChatSessionVoiceOptions): ChatSessionVoiceController => {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [profiles, setProfiles] = useState<SpeechProfile[]>([]);
  const [profilesLoaded,setProfilesLoaded]=useState(false);
  const [speakingMessageId, setSpeakingMessageId] = useState<string | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const primed = useRef<string | null>(null);
  const streamingPrimed=useRef<string|null>(null);
  const streaming=useRef<{key:string;taskId:string;sequence:number;player:StreamingAnswerPlayback}|null>(null);
  const playingRevision = useRef<{ messageId: string; revision: string } | null>(null);
  const owner = `chat:${options.activeSessionId}`;
  const activeOwner = useRef(owner);
  activeOwner.current = owner;
  const browserSupported = systemSupported();
  const effectiveProfileId = options.conversationProfileId ?? options.settings.speechProfileId;
  const selectedProfile = profiles.find(profile => profile.id === effectiveProfileId);
  const selectedProvider = options.aiVoiceSettings.activeProvider;
  const useSystemVoice = !effectiveProfileId && (Boolean(options.settings.preferredVoiceURI) || selectedProvider === "none");
  const configured = options.aiVoiceSettings.providerAvailability.some(entry => entry.provider === selectedProvider && entry.configured);
  const automaticSpeech = options.conversationAutoSpeakOverride ?? options.settings.autoSpeakResponses;
  const answerMode=options.settings.answerMode??"completed";
  const streamingSupported=selectedProfile?.backend==="fish-cloud";
  const supported = effectiveProfileId ? Boolean(selectedProfile) : useSystemVoice ? browserSupported : configured;

  useEffect(() => {
    if (!browserSupported) return;
    const refresh = (): void => setVoices([...window.speechSynthesis.getVoices()].sort((a, b) => a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name)));
    refresh();
    window.speechSynthesis.addEventListener("voiceschanged", refresh);
    return () => window.speechSynthesis.removeEventListener("voiceschanged", refresh);
  }, [browserSupported]);

  useEffect(() => {
    let active = true;
    setProfilesLoaded(false);
    void speechRuntime.execute("listProfiles", {}).then(value => { if (active) {setProfiles(value);setProfilesLoaded(true);} }).catch(() => {
      if(active)setProfilesLoaded(true);
      if (active && effectiveProfileId) setErrorText("Speech profiles could not be loaded. Reopen Text to Speech and check its connection.");
    });
    return () => { active = false; };
  }, [options.refreshKey, effectiveProfileId]);

  useEffect(() => speechPlayback.subscribe(state => {
    if (state.owner === owner) {
      setSpeakingMessageId(state.status === "idle" ? null : state.itemId);
      setErrorText(state.error);
    } else setSpeakingMessageId(null);
  }), [owner]);

  const stopSpeaking = useCallback((): void => { speechPlayback.stop(owner); playingRevision.current = null; streaming.current=null;setSpeakingMessageId(null); }, [owner]);
  useEffect(() => { primed.current = null; return stopSpeaking; }, [owner, stopSpeaking]);
  useEffect(()=>stopSpeaking,[answerMode,effectiveProfileId,selectedProvider,useSystemVoice,stopSpeaking]);
  useEffect(()=>{if(!automaticSpeech&&streaming.current)stopSpeaking();},[automaticSpeech,stopSpeaking]);

  const speak = useCallback((message: ChatSessionMessage, selection?: string, automatic = false): void => {
    const answer = getFinalSpeechAnswer(message, options.activeSessionId);
    if (!answer) return;
    const text = markdownToSpeech(selection ?? answer.markdown, { readCode: selection !== undefined });
    if (!text) return;
    streaming.current=null;
    setErrorText(null);
    playingRevision.current = { messageId: message.id, revision: answer.revision };
    void speechPlayback.play({
      owner, itemId: message.id,
      open: async signal => {
        const settings = await speechRuntime.execute("settings", {});
        if (Array.from(text).length > settings.answerCharacterLimit) throw new Error("This answer exceeds the speech limit. Read a shorter selection or change the answer limit in Text to Speech.");
        if (useSystemVoice) {
          return createSystemSpeechHandle(text, { voiceURI: options.settings.preferredVoiceURI, rate: rate(options.settings.rate), signal });
        }
        const profileId = effectiveProfileId ?? `default-${selectedProvider}`;
        const allProfiles = await speechRuntime.execute("listProfiles", {});
        const profile = allProfiles.find(value => value.id === profileId);
        if (!profile) throw new Error("Choose a saved speech profile in Voice settings.");
        if(selection===undefined){
          const recorded=await speechRuntime.execute("findAnswerAudio",{owner,alternateOwner:`chat:auto:${options.activeSessionId}`,answerId:answer.answerId,revision:answer.revision,source:text,profileId});
          signal.throwIfAborted();
          if(recorded)return retainSpeechPlayback(speechRuntime,{owner,assetIds:[recorded.asset.id]},signal,()=>createAudioPlaybackHandle(speechAssetUrl(recorded.asset.path),{rate:rate(options.settings.rate),signal,duration:recorded.asset.duration}),message=>{if(activeOwner.current===owner)setErrorText(message);});
        }
        return createSpeechPlayback(speechRuntime, { owner: automatic ? `chat:auto:${options.activeSessionId}` : owner, projectId: null, revisionId: answer.revision, profileId,expectedProfile:profile, segments: [{ id: selection === undefined ? answer.answerId : `${answer.answerId}-selection`, text, spokenText: text, chapter: null,...speechProfileBinding(profile) }], takes: 1, priority: 100, reuseCache: true, cloudConsent: settings.cloudConsent, budgetLimit: automatic ? settings.answerBudgetLimit : settings.budgetLimit }, signal,
          {assetUrl:speechAssetUrl,rate:rate(options.settings.rate),onCancellationFailure:message => {if(activeOwner.current===owner)setErrorText(message);}});
      },
    });
  }, [options.activeSessionId, options.settings, owner, selectedProvider, useSystemVoice, effectiveProfileId]);

  const speakMessage = useCallback((message: ChatSessionMessage): void => {
    const playback = speechPlayback.snapshot();
    if (playback.owner === owner && playback.itemId === message.id && !["idle","failed"].includes(playback.status)) {
      if (playback.status === "blocked" || playback.status === "paused") void speechPlayback.resume();
      else stopSpeaking();
      return;
    }
    speak(message);
  }, [owner, speak, stopSpeaking]);

  useEffect(() => {
    const current = playingRevision.current;
    if (!current) return;
    const message = options.visibleMessages.find(item => item.id === current.messageId);
    const answer = message && getFinalSpeechAnswer(message, options.activeSessionId);
    if (!answer || answer.revision !== current.revision) stopSpeaking();
  }, [options.visibleMessages, options.activeSessionId, stopSpeaking]);

  const latestUserIndex=options.visibleMessages.reduce((last,message,index)=>message.role==="user"?index:last,-1);
  const latestUserId=options.visibleMessages[latestUserIndex]?.id;
  const previousUser = useRef(latestUserId);
  useEffect(() => { if (previousUser.current !== latestUserId) stopSpeaking(); previousUser.current = latestUserId; }, [latestUserId, stopSpeaking]);

  useEffect(() => {
    const answers = options.visibleMessages.flatMap((message,index) => {
      const answer = getFinalSpeechAnswer(message, options.activeSessionId);
      return answer ? [{ answer, message,index }] : [];
    });
    if (primed.current !== options.activeSessionId) { ledger.prime(answers.map(value => value.answer)); primed.current = options.activeSessionId; return; }
    if(automaticSpeech&&effectiveProfileId&&!profilesLoaded)return;
    const newAnswers = answers.filter(({ answer,index }) => ledger.accept(answer) === "new"&&index>latestUserIndex);
    if (answerMode==="completed"&&supported && automaticSpeech && newAnswers.length) speak(newAnswers.at(-1)!.message, undefined, true);
    if(answerMode==="streaming"&&automaticSpeech&&supported&&newAnswers.length){
      const latest=newAnswers.at(-1)!.message;
      const trace=latest.source?.kind==="execution"?latest.source.thinking:undefined;
      if(!trace?.finalAnswerStream&&!streamedAnswers.has(`${options.activeSessionId}:${latest.taskId??latest.id}`))setErrorText(streamingSupported?"This run did not provide a final-answer stream. Read the completed answer or choose completed playback.":"Choose a Fish Cloud speech profile for streaming replies, or choose completed replies.");
    }
  }, [options.visibleMessages, options.activeSessionId, automaticSpeech, speak, supported,answerMode,effectiveProfileId,profilesLoaded,streamingSupported,latestUserIndex]);

  useEffect(()=>{
    const candidates=options.visibleMessages.flatMap((message,index)=>{
      const source=message.source;
      const trace=source?.kind==="thinking"||source?.kind==="execution"?source.thinking:undefined;
      const snapshot=trace?.finalAnswerStream;
      return message.role==="agent"&&snapshot?[{message,snapshot,index,taskId:message.taskId??message.id}]:[];
    });
    if(streamingPrimed.current!==options.activeSessionId){
      for(const item of candidates)rememberStream(`${options.activeSessionId}:${item.taskId}`,`${item.snapshot.responseId}:${item.snapshot.answerId}`);
      streamingPrimed.current=options.activeSessionId;return;
    }
    const active=streaming.current;
    if(active&&!candidates.some(item=>item.taskId===active.taskId)){stopSpeaking();return;}
    for(const {message,snapshot,index,taskId} of candidates){
      const taskKey=`${options.activeSessionId}:${taskId}`;
      const key=`${snapshot.responseId}:${snapshot.answerId}`;
      const current=streaming.current;
      if(index<=latestUserIndex){rememberStream(taskKey,key);if(current?.taskId===taskId)stopSpeaking();continue;}
      const previous=streamedAnswers.get(taskKey);
      const terminalFailure=snapshot.status==="retracted"||snapshot.status==="limited"||message.source?.kind==="execution"&&!getFinalSpeechAnswer(message,options.activeSessionId);
      if(current?.taskId===taskId){
        if(snapshot.sequence<=current.sequence&&key===current.key&&!terminalFailure)continue;
        current.sequence=snapshot.sequence;
        if(terminalFailure||key!==current.key){current.player.retract(snapshot.reason??"The final answer changed. Replay the completed answer deliberately.");stopSpeaking();return;}
        current.player.update({kind:"answer",channel:"final",audience:"user",sessionId:options.activeSessionId,answerId:taskId,revision:answerSpeechRevision(key),markdown:snapshot.text,complete:snapshot.status==="completed"});
        continue;
      }
      if(previous!==undefined||terminalFailure){if(previous===undefined)rememberStream(taskKey,key);continue;}
      if(automaticSpeech&&effectiveProfileId&&!profilesLoaded)continue;
      rememberStream(taskKey,key);
      if(answerMode!=="streaming"||!automaticSpeech||!supported)continue;
      if(!streamingSupported||!selectedProfile){setErrorText("Choose a Fish Cloud speech profile for streaming replies, or choose completed replies.");continue;}
      const player=new StreamingAnswerPlayback();
      player.update({kind:"answer",channel:"final",audience:"user",sessionId:options.activeSessionId,answerId:taskId,revision:answerSpeechRevision(key),markdown:snapshot.text,complete:snapshot.status==="completed"});
      streaming.current={key,taskId,sequence:snapshot.sequence,player};playingRevision.current=null;
      setErrorText(null);
      void speechPlayback.play({owner,itemId:message.id,open:async signal=>{
        const settings=await speechRuntime.execute("settings",{});signal.throwIfAborted();
        return player.open(speechRuntime,{input:{owner:`chat:auto:${options.activeSessionId}`,projectId:null,revisionId:`stream-${answerSpeechRevision(key)}`,profileId:selectedProfile.id,expectedProfile:selectedProfile,priority:100,cloudConsent:settings.cloudConsent,budgetLimit:settings.answerBudgetLimit},maxCharacters:settings.answerCharacterLimit,rate:rate(options.settings.rate),...speechProfileBinding(selectedProfile),onError:text=>{if(activeOwner.current===owner){stopSpeaking();setErrorText(text);}}},signal);
      }});
    }
  },[options.visibleMessages,options.activeSessionId,answerMode,automaticSpeech,supported,streamingSupported,selectedProfile,options.settings.rate,owner,stopSpeaking,effectiveProfileId,profilesLoaded,latestUserIndex]);

  useEffect(() => {
    const stop = (): void => stopSpeaking();
    window.addEventListener("pagehide", stop);
    return () => window.removeEventListener("pagehide", stop);
  }, [stopSpeaking]);

  const voiceOptions = useMemo(() => [
    ...profiles.map(profile => ({ voiceURI: `profile:${profile.id}`, label: profile.name, lang: profile.language ?? "", isDefault: false })),
    ...voices.map(voice => ({ voiceURI: voice.voiceURI, label: `${voice.name} · ${voice.lang}`, lang: voice.lang, isDefault: voice.default })),
  ], [profiles, voices]);

  return {
    answerMode,streamingSupported,setAnswerMode:answerMode=>options.onSettingsChange(settings=>({...settings,answerMode})),
    supported, systemVoicesSupported: browserSupported,
    autoSpeakResponses: options.settings.autoSpeakResponses,
    conversationAutoSpeak: options.conversationAutoSpeakOverride === undefined ? "default" : options.conversationAutoSpeakOverride ? "auto" : "manual",
    setConversationAutoSpeak: value => options.onConversationAutoSpeakChange(value === "default" ? undefined : value === "auto"),
    conversationProfileId: options.conversationProfileId,
    conversationProfiles: profiles.map(({id,name})=>({id,name})),
    setConversationProfile: options.onConversationProfileChange,
    availabilityDescription: errorText ?? (supported ? "" : "Choose a configured speech profile or an available system voice."),
    preferredVoiceURI: options.settings.speechProfileId ? `profile:${options.settings.speechProfileId}` : options.settings.preferredVoiceURI ?? null,
    rate: rate(options.settings.rate), speakingMessageId, errorText, voiceOptions,
    setAutoSpeakResponses: enabled => options.onSettingsChange(settings => ({ ...settings, autoSpeakResponses: enabled })),
    setPreferredVoiceURI: voiceURI => options.onSettingsChange(settings => {
      const next = { ...settings };
      delete next.speechProfileId; delete next.preferredVoiceURI;
      if (voiceURI?.startsWith("profile:")) next.speechProfileId = voiceURI.slice(8);
      else if (voiceURI) next.preferredVoiceURI = voiceURI;
      return next;
    }),
    setRate: value => {
      try { if (speechPlayback.snapshot().owner === owner) speechPlayback.setRate(rate(value)); }
      catch (error) { setErrorText(error instanceof Error ? error.message : "Playback speed could not be changed. Stop playback and try again."); }
      options.onSettingsChange(settings => ({ ...settings, rate: rate(value) }));
    },
    speakMessage, speakSelection: (message, selection) => speak(message, selection),
    openInStudio: message => {
      const answer = getFinalSpeechAnswer(message, options.activeSessionId);
      if (!answer) return;
      const profileId = effectiveProfileId ?? (selectedProvider === "none" ? null : "default-" + selectedProvider);
      void openAnswerSpeechProject(speechRuntime, answer, profiles.find(profile => profile.id === profileId) ?? null).then(project => {
        window.dispatchEvent(new CustomEvent("machdoch:open-speech-project", { detail: { id: project.id } }));
      }).catch(error => setErrorText(error instanceof Error ? error.message : "The answer could not be opened in Text to Speech."));
    },
    canSaveAudio: !useSystemVoice,
    saveAudio: message => {
      const answer=getFinalSpeechAnswer(message,options.activeSessionId);
      if (!answer) return;
      const source=markdownToSpeech(answer.markdown);
      void speechRuntime.execute("saveAnswerAudio",{owner,alternateOwner:"chat:auto:"+options.activeSessionId,answerId:answer.answerId,revision:answer.revision,sessionId:answer.sessionId,source,title:Array.from(source).slice(0,80).join("")}).then(project=>{
        window.dispatchEvent(new CustomEvent("machdoch:open-speech-project",{detail:{id:project.id}}));
      }).catch(error=>setErrorText(error instanceof Error?error.message:"The generated speech could not be saved."));
    },
    pauseSpeaking: () => speechPlayback.pause(), resumeSpeaking: () => { void speechPlayback.resume(); }, stopSpeaking,
  };
};
