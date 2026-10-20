import type {SourceRange, SpeechScript} from "./script.ts";

export interface SpeechRenderTarget extends SourceRange {
  id: string; kind: "chapter" | "scene" | "turn"; title: string;
}

export function speechRenderTargets(script: SpeechScript, cast: readonly {id: string; name: string}[]): SpeechRenderTarget[] {
  if (script.diagnostics.some(item => item.severity === "error")) throw new Error("Resolve script errors before choosing a render target.");
  const targets: SpeechRenderTarget[] = [];
  const spoken = script.nodes.filter(node => node.kind === "phoneme" || node.kind === "text" && node.value.trim());
  const meaningful = (from: number, to: number) => {
    let lower=0,upper=spoken.length;
    while(lower<upper){const middle=Math.floor((lower+upper)/2);if(spoken[middle]!.to<=from)lower=middle+1;else upper=middle;}
    return lower<spoken.length&&spoken[lower]!.from<to;
  };
  const headings = script.nodes.filter(node => node.kind === "chapter" || node.kind === "scene");
  let nextChapter=script.source.length,nextScope=script.source.length;
  for (let index=headings.length-1;index>=0;index--) {
    const heading=headings[index]!;
    const to=heading.kind==="chapter"?nextChapter:nextScope;
    if (meaningful(heading.to, to)) targets.push({id: heading.id, kind: heading.kind as "chapter" | "scene", title: heading.value, from: heading.to, to});
    nextScope=heading.from;if(heading.kind==="chapter")nextChapter=heading.from;
  }
  targets.reverse();
  let from = 0;
  let anchor = "start";
  let speaker: string | null = null;
  let words="";
  const names=new Map(cast.map(member=>[member.id,member.name]));
  const turn = (to: number) => {
    if (!meaningful(from, to)) return;
    const preview=Array.from(words.replace(/\s+/gu," ").trim()).slice(0,80).join("");
    const name=speaker===null?null:names.get(speaker)??speaker;
    targets.push({id:`turn:${anchor}`,kind:"turn",title:name ? `${name} · ${preview}` : preview||"Turn",from,to});
  };
  for (const node of script.nodes) {
    if(node.kind==="text"){
      if(words.length<160){let part=node.value.slice(0,160-words.length);if(/[\uD800-\uDBFF]$/u.test(part))part=part.slice(0,-1);words+=part;}
      continue;
    }
    if (node.kind !== "chapter" && node.kind !== "scene" && node.kind !== "speaker") continue;
    turn(node.from);
    words="";
    from = node.kind === "speaker" ? node.from : node.to;
    anchor = node.id;
    if (node.kind === "speaker") speaker = node.value;
  }
  turn(script.source.length);
  return targets;
}
