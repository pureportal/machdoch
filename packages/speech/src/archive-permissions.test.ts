import test from "node:test";
import assert from "node:assert/strict";
import {archiveReferencePermission,type SpeechArchiveReferences} from "./archive-permissions.ts";

const inventory:SpeechArchiveReferences={projectId:"project",revisionId:"revision",inventorySha256:"c".repeat(64),references:[{assetId:"a".repeat(64),bytes:128,transcriptPreview:"A reference.",rightsEvidence:"Cloning permission only",original:false},{assetId:"b".repeat(64),bytes:256,transcriptPreview:null,rightsEvidence:null,original:true}]};

test("recorded cloning permission never substitutes for explicit archive redistribution evidence",()=>{
  assert.throws(()=>archiveReferencePermission(inventory,false,"Owner permits redistribution"),/Confirm permission/u);
  assert.throws(()=>archiveReferencePermission(inventory,true,""),/redistribution permission/u);
  assert.deepEqual(archiveReferencePermission(inventory,true," Owner permits bundling both recordings. "),{inventorySha256:inventory.inventorySha256,assetIds:inventory.references.map(reference=>reference.assetId),rightsEvidence:"Owner permits bundling both recordings."});
});

test("empty archives need no permission declaration and evidence uses a UTF-8 byte guard",()=>{
  assert.equal(archiveReferencePermission({...inventory,references:[]},false,""),undefined);
  assert.throws(()=>archiveReferencePermission(inventory,true,"界".repeat(1366)),/4,096 UTF-8 bytes/u);
  assert.equal(archiveReferencePermission(inventory,true,"界".repeat(1365))!.rightsEvidence.length,1365);
});
