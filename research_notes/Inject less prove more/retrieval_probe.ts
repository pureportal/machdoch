import fs from 'node:fs';
import { execSync } from 'node:child_process';
const R='file:///C:/Development/machdoch/apps/client/src/core/';
const { retrieveConversationMemory, tokenizeMemoryText } = await import(R+'memory-retrieval.ts');
const { retrieveReasoningLessons } = await import(R+'reasoning-bank.ts');
const S='C:/Development/machdoch/.machdoch/local/state/';
const bankRaw=JSON.parse(fs.readFileSync(S+'reasoning-bank.json','utf8')); const lessons=bankRaw.lessons??bankRaw;
const memRaw=JSON.parse(fs.readFileSync(S+'memory.json','utf8')); const mem=(memRaw.entries??memRaw).map((e:any)=>({...e,searchTerms:e.searchTerms??[]}));
const task='Research online about how we can crazy improve our AI Agent solution / suite. Especially things like better understanding, better context, better memory, improved features, new capabilities, etc - Check for newest benchmarks, white paper (researchs), etc!';
const lessonText=(l:any)=>[l.title,l.description,l.content,...l.triggerTerms].join(' ');
const memText=(e:any)=>[e.key,e.content,...(e.searchTerms??[])].join(' ');
const overlap=(q:string,t:string)=>{const a=new Set(tokenizeMemoryText(q));const b=new Set(tokenizeMemoryText(t));return [...a].filter(x=>b.has(x));};
const r=retrieveReasoningLessons(task,lessons);
console.log('THIS TASK lessons:',r.length);for(const l of r)console.log(' -',l.title.slice(0,80),'| shared:',overlap(task,lessonText(l)).join(','));
const m=retrieveConversationMemory(task,mem);
console.log('THIS TASK memory:',m.entries.length);for(const x of m.ranked)console.log(' -',x.entry.key.slice(0,60),'| score',x.score.toFixed(2),'| shared:',overlap(task,memText(x.entry)).join(','));
const subjects=execSync('git -C C:/Development/machdoch log -300 --pretty=%s',{encoding:'utf8'}).split('\n').map(s=>s.replace(/^[^\p{L}\d]+/u,'').trim()).filter(s=>s.length>12&&!/^Bump version/.test(s));
let lr=0,lOne=0,lTwo=0,mr=0,mOne=0,mTwo=0,lZero=0,mZero=0,n=0;const seenL=new Map<string,number>(),seenM=new Map<string,number>();
for(const q of subjects){n++;const a=retrieveReasoningLessons(q,lessons);const b=retrieveConversationMemory(q,mem);if(!a.length)lZero++;if(!b.entries.length)mZero++;
 for(const l of a){lr++;const c=overlap(q,lessonText(l)).length;if(c<=1)lOne++;else if(c===2)lTwo++;seenL.set(l.id,(seenL.get(l.id)??0)+1);}
 for(const e of b.entries){mr++;const c=overlap(q,memText(e)).length;if(c<=1)mOne++;else if(c===2)mTwo++;seenM.set(e.id,(seenM.get(e.id)??0)+1);}}
const pct=(a:number,b:number)=>b?(100*a/b).toFixed(1)+'%':'-';
console.log('queries',n);
console.log('lessons retrieved',lr,'per q',(lr/n).toFixed(2),'single-token',pct(lOne,lr),'two-token',pct(lTwo,lr),'zero-result q',pct(lZero,n),'distinct',seenL.size,'of',lessons.length);
console.log('memory retrieved',mr,'per q',(mr/n).toFixed(2),'single-token',pct(mOne,mr),'two-token',pct(mTwo,mr),'zero-result q',pct(mZero,n),'distinct',seenM.size,'of',mem.length);
const rc=lessons.map((l:any)=>l.retrievalCount||0).sort((a:number,b:number)=>b-a);
console.log('bank retrievalCount total',rc.reduce((a:number,b:number)=>a+b,0),'never',rc.filter((x:number)=>!x).length,'top10',rc.slice(0,10).join(','),'helpful>0',lessons.filter((l:any)=>l.helpfulCount>0).length,'harmful>0',lessons.filter((l:any)=>l.harmfulCount>0).length);
const age=(t:number)=>(Date.now()-t)/864e5; const med=(a:number[])=>a.sort((x,y)=>x-y)[Math.floor(a.length/2)];
console.log('lesson median age d',med(lessons.map((l:any)=>age(l.updatedAt))).toFixed(1),'memory median age d',med(mem.map((e:any)=>age(e.updatedAt))).toFixed(1),'oldest mem d',Math.max(...mem.map((e:any)=>age(e.updatedAt))).toFixed(1));
// counterfactual gate and seeded hand-label sample
const EXTRA=new Set(['can','new','check','add','use','using','fix','make','run','all','not','into','only','when','after','before','keep','show','update','support','allow','improve','better','etc','our','about','especially','things','like']);
const strong=(q:string,t:string)=>overlap(q,t).filter(x=>!EXTRA.has(x));
let lKeep=0,mKeep=0,lZ=0,mZ=0;const sampleL:any[]=[],sampleM:any[]=[];
let seed=20261101;const rnd=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296;};
for(const q of subjects){const a=retrieveReasoningLessons(q,lessons);const b=retrieveConversationMemory(q,mem).entries;
 const ak=a.filter((l:any)=>strong(q,lessonText(l)).length>=2);const bk=b.filter((e:any)=>strong(q,memText(e)).length>=2);lKeep+=ak.length;mKeep+=bk.length;if(!ak.length)lZ++;if(!bk.length)mZ++;
 for(const l of a)sampleL.push({q,t:l.title,s:strong(q,lessonText(l)).join(',')});for(const e of b)sampleM.push({q,t:e.key+' :: '+e.content.slice(0,90),s:strong(q,memText(e)).join(',')});}
console.log('GATE >=2 strong tokens: lessons kept',lKeep,'of',lr,'zero q',pct(lZ,n),'| memory kept',mKeep,'of',mr,'zero q',pct(mZ,n));
const pick=(a:any[],k:number)=>{const c=[...a];const o=[];for(let i=0;i<k&&c.length;i++)o.push(c.splice(Math.floor(rnd()*c.length),1)[0]);return o;};
console.log('SAMPLE LESSONS');for(const x of pick(sampleL,25))console.log(`Q: ${x.q.slice(0,70)} || L: ${x.t.slice(0,80)} || ${x.s}`);
console.log('SAMPLE MEMORY');for(const x of pick(sampleM,25))console.log(`Q: ${x.q.slice(0,70)} || M: ${x.t.slice(0,120)} || ${x.s}`);
