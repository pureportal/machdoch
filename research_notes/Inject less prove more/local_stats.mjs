import fs from 'node:fs'; import path from 'node:path';
const base=path.join(process.env.APPDATA,'machdoch');
const walk=(d,o=[])=>{ if(!fs.existsSync(d))return o; for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name); if(e.isDirectory())walk(p,o); else o.push(p);} return o;};
const med=a=>{a=[...a].sort((x,y)=>x-y);return a.length?a[Math.floor(a.length/2)]:0;};
const rows=[];let keys;
for(const p of walk(path.join(base,'goals')).filter(f=>f.endsWith('.json'))){let d;try{d=JSON.parse(fs.readFileSync(p,'utf8'))}catch{continue}
 const g=d.goal??d; if(!g||!g.status)continue; keys??=Object.keys(g);
 const reqs=Array.isArray(g.requirements)?g.requirements:[];
 rows.push({status:g.status,mode:g.mode,tokens:g.tokensUsed||0,turns:g.turns||0,min:(g.elapsedMs||0)/60000,upd:g.updatedAt||0,cost:g.costUsd,reqs:reqs.length,ver:reqs.filter(r=>r&&r.status==='verified').length,hasUsage:g.usage!==undefined,checks:g.checks??g.verificationPasses});}
console.log('goal records',rows.length,'keys',keys);
const c={};for(const r of rows){(c[r.mode+'/'+r.status]??=[]).push(r)}
for(const[k,v]of Object.entries(c).sort())console.log(k,v.length,'medTokensM',(med(v.map(x=>x.tokens))/1e6).toFixed(1),'medTurns',med(v.map(x=>x.turns)),'medMin',Math.round(med(v.map(x=>x.min))));
const cut=Date.UTC(2026,9,31);const rec=rows.filter(r=>r.upd>=cut);const rc={};rec.forEach(r=>rc[r.mode+'/'+r.status]=(rc[r.mode+'/'+r.status]||0)+1);
console.log('updated since Oct31',rec.length,rc,'with checklist',rows.filter(r=>r.reqs).map(r=>`${r.ver}/${r.reqs}:${r.status}`).slice(0,25));
const scan=(ps,l)=>{for(const p of ps){let d;try{d=JSON.parse(fs.readFileSync(p,'utf8'))}catch{console.log(l,'ERR');continue}
 const it=Array.isArray(d)?d:(d.lessons??d.entries??d.memories); if(!Array.isArray(it)){console.log(l,path.basename(p),'shape',Object.keys(d).slice(0,8));continue}
 const sum=k=>it.reduce((a,i)=>a+(i?.[k]||0),0);
 console.log(l,p.slice(-60),'n',it.length,'helpful',sum('helpfulCount'),'harmful',sum('harmfulCount'),'keys',it[0]?Object.keys(it[0]).join(','):'', 'kinds',JSON.stringify(it.reduce((a,i)=>{a[i?.kind??i?.outcome??'?']=(a[i?.kind??i?.outcome??'?']||0)+1;return a},{})),'withApplicability',it.filter(i=>i?.applicability).length);}};
const repo='C:/Development/machdoch/.machdoch';
const rf=walk(repo);scan(rf.filter(f=>f.endsWith('reasoning-bank.json')),'bank');scan(rf.filter(f=>f.endsWith('memory.json')),'mem');
const bf=walk(base).filter(f=>!f.includes('provider-enrollment')&&!f.includes('transcripts'));
scan(bf.filter(f=>f.endsWith('reasoning-bank.json')).slice(0,15),'bank');scan(bf.filter(f=>/memory[^\/]*\.json$/.test(f)).slice(0,15),'mem');
const ps=bf.filter(f=>f.endsWith('binding.json'));const pc={};for(const p of ps){try{const b=JSON.parse(fs.readFileSync(p,'utf8'));pc[b.provider]=(pc[b.provider]||0)+1}catch{}};console.log('provider bindings',ps.length,pc);
