export interface SpeechArchiveReferences {
  projectId:string;revisionId:string;inventorySha256:string;
  references:Array<{assetId:string;bytes:number;transcriptPreview:string|null;rightsEvidence:string|null;original:boolean}>;
}

export interface SpeechArchiveReferencePermission {
  inventorySha256:string;assetIds:string[];rightsEvidence:string;
}

export function archiveReferencePermission(inventory:SpeechArchiveReferences,approved:boolean,evidence:string):SpeechArchiveReferencePermission|undefined{
  if(inventory.references.length===0)return undefined;
  if(!approved)throw new Error("Confirm permission to include the listed reference recordings in this archive.");
  const rightsEvidence=evidence.trim();
  if(!rightsEvidence||new TextEncoder().encode(rightsEvidence).length>4096)throw new Error("Record redistribution permission within 4,096 UTF-8 bytes before exporting references.");
  return {inventorySha256:inventory.inventorySha256,assetIds:inventory.references.map(reference=>reference.assetId),rightsEvidence};
}
