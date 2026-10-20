import {test} from "node:test";
import assert from "node:assert/strict";
import {validatePhonemes,parseSpeechScript} from "./script.ts";
import {validateDictionaries} from "./dictionary.ts";

test("Japanese romaji accepts the documented OpenJTalk pitch markers without admitting arbitrary digits",()=>{
  assert.equal(validatePhonemes("ha0shi1ga0","romaji"),true);
  assert.equal(validatePhonemes("ha0 shi1 ga0","romaji"),true);
  assert.equal(validatePhonemes("tōkyō","romaji"),true);
  for(const value of ["0ha","ha01","ha2","ha0shi1ga3","<soft>ha0</soft>"])assert.equal(validatePhonemes(value,"romaji"),false,value);
  assert.deepEqual(parseSpeechScript("<|phoneme_start|>ha0shi1ga0<|phoneme_end|>見えます。",{phonemeAlphabet:"romaji"}).diagnostics,[]);
  assert.deepEqual(validateDictionaries([{id:"ja",name:"Japanese terms",revision:"revision",rules:[{id:"bridge",text:"橋が",phonemes:"ha0shi1ga0",alphabet:"romaji",caseSensitive:true}]}]),[]);
});

test("pitch markers do not change English stress or Chinese tone validation",()=>{
  assert.equal(validatePhonemes("HH AH0 L OW1","arpabet"),true);
  assert.equal(validatePhonemes("gong1 cheng2 shi1","pinyin"),true);
  assert.equal(validatePhonemes("ha0shi1ga0","arpabet"),false);
});
