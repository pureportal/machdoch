export interface AlignedWord { text: string; start: number; end: number }
export interface AlignmentSnapshot { chunkSeq: number; chunkAudioOffsetSeconds: number; words: AlignedWord[] }

export class SpeechAlignment {
  private readonly chunks = new Map<number, AlignmentSnapshot>();
  replace(snapshot: AlignmentSnapshot): void {
    if (!Number.isSafeInteger(snapshot.chunkSeq) || snapshot.chunkSeq < 0 || !Number.isFinite(snapshot.chunkAudioOffsetSeconds) || snapshot.chunkAudioOffsetSeconds < 0) throw new Error("The provider returned invalid alignment metadata.");
    let lastStart = 0;
    for (const word of snapshot.words) {
      if (typeof word.text !== "string" || !Number.isFinite(word.start) || !Number.isFinite(word.end) || word.start < lastStart || word.start < 0 || word.end < word.start) throw new Error("The provider returned invalid word timing.");
      lastStart = word.start;
    }
    this.chunks.set(snapshot.chunkSeq, { ...snapshot, words: snapshot.words.map(word => ({ ...word })) });
  }
  words(): AlignedWord[] {
    return [...this.chunks.values()].sort((a, b) => a.chunkSeq - b.chunkSeq).flatMap(chunk => chunk.words.map(word => ({ ...word, start: word.start + chunk.chunkAudioOffsetSeconds, end: word.end + chunk.chunkAudioOffsetSeconds })));
  }
  at(seconds: number): AlignedWord | undefined { return this.words().find(word => seconds >= word.start && seconds < word.end); }
  clear(): void { this.chunks.clear(); }
}

export function exportSubtitles(words: ReadonlyArray<AlignedWord>, format: "srt" | "vtt"): string {
  if (!words.length) throw new Error("Measured alignment is required for subtitles.");
  const time = (seconds: number): string => {
    if (!Number.isFinite(seconds) || seconds < 0) throw new Error("Subtitle timing must be finite and nonnegative.");
    const milliseconds = Math.round(seconds * 1000);
    return `${Math.floor(milliseconds / 3600000).toString().padStart(2, "0")}:${Math.floor(milliseconds / 60000 % 60).toString().padStart(2, "0")}:${Math.floor(milliseconds / 1000 % 60).toString().padStart(2, "0")}${format === "srt" ? "," : "."}${(milliseconds % 1000).toString().padStart(3, "0")}`;
  };
  const cues: AlignedWord[] = [];
  let cue: AlignedWord | undefined;
  let previousEnd = 0;
  for (const word of words) {
    if (word.end < word.start || word.start < previousEnd) throw new Error("Resolve overlapping or superseded alignment before subtitle export.");
    if (cue && (word.start - cue.end > 1 || word.end - cue.start > 6 || cue.text.length + word.text.length > 72)) { cues.push(cue); cue = undefined; }
    cue = cue ? { text: `${cue.text} ${word.text}`, start: cue.start, end: word.end } : { ...word };
    previousEnd = word.end;
  }
  if (cue) cues.push(cue);
  return (format === "vtt" ? "WEBVTT\n\n" : "") + cues.map((item, index) => `${format === "srt" ? `${index + 1}\n` : ""}${time(item.start)} --> ${time(item.end)}\n${item.text.replace(/[\r\n]/gu, " ").replace(/-->/gu, "→")}\n`).join("\n");
}
