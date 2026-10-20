import {test} from "node:test";
import assert from "node:assert/strict";
import {previewPronunciation,type PronunciationDictionary} from "./dictionary.ts";

const rule=(id:string,text:string,caseSensitive=false)=>({id,text,phonemes:"M AA K",alphabet:"arpabet" as const,caseSensitive});

test("pronunciation preview retains leftmost-longest matching, ASCII-only folding, dictionary order and Unicode ranges",()=>{
  const dictionaries:PronunciationDictionary[]=[{id:"a",name:"A",revision:"a1",rules:[rule("short","Brand"),rule("long","Brand name"),rule("unicode","東京 🚀"),rule("case","Ä",false)]},{id:"b",name:"B",revision:"b1",rules:[rule("tie","Brand name",true)]}];
  const source="🚀 BRAND NAME Brand. 東京 🚀 ä Ä";
  const matches=previewPronunciation(source,dictionaries);
  assert.deepEqual(matches.map(item=>[item.original,item.ruleId,item.dictionaryId]),[["BRAND NAME","long","a"],["Brand","short","a"],["東京 🚀","unicode","a"],["Ä","case","a"]]);
  for(const match of matches)assert.equal(source.slice(match.from,match.to),match.original);
  assert.equal(previewPronunciation("Brand name",dictionaries)[0]!.dictionaryId,"a");
  assert.deepEqual(previewPronunciation(source,dictionaries,{from:5,to:15}).map(item=>item.original),["BRAND NAME","Brand"]);
  assert.throws(()=>previewPronunciation(source,dictionaries,{from:-1,to:3}),/range/u);
});

test("pronunciation preview handles a book-length passage with a full dictionary",()=>{
  const dictionary:PronunciationDictionary={id:"names",name:"Names",revision:"revision",rules:Array.from({length:5000},(_,index)=>rule(`rule-${index}`,`brand${index}`))};
  const source="Brand4999 words. ".repeat(62500);
  const matches=previewPronunciation(source,[dictionary]);
  assert.equal(matches.length,62500);assert.equal(matches[0]!.original,"Brand4999");assert.equal(matches.at(-1)!.to,source.length-8);
  const page=previewPronunciation(source,[dictionary],{from:source.length-2048,to:source.length});assert.ok(page.length<200);assert.equal(page.at(-1)!.to,source.length-8);
});
