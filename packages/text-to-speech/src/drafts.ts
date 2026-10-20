import type { SpeechProject } from "@machdoch/speech";

export interface SpeechDraft {
  id: string;
  editorId: string;
  projectId: string;
  baseRevisionId: string;
  savedAt: string;
  project: SpeechProject;
}

let database: Promise<IDBDatabase> | undefined;

function openDatabase(): Promise<IDBDatabase> {
  database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open("machdoch-speech-drafts", 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("drafts", { keyPath: "id" }).createIndex("projectId", "projectId");
    };
    request.onerror = () => { database = undefined; reject(new Error("Draft recovery storage could not be opened. Free disk space and reopen Text to Speech.")); };
    request.onblocked = () => { database = undefined; reject(new Error("Close other Text to Speech windows to update draft recovery storage.")); };
    request.onsuccess = () => {
      request.result.onversionchange = () => { request.result.close(); database = undefined; };
      resolve(request.result);
    };
  });
  return database;
}

async function write(action: (store: IDBObjectStore) => void): Promise<void> {
  const connection = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = connection.transaction("drafts", "readwrite", { durability: "strict" });
    transaction.oncomplete = () => resolve();
    transaction.onerror = transaction.onabort = () => reject(new Error("Edits could not be saved for crash recovery. Free disk space and save the project."));
    action(transaction.objectStore("drafts"));
  });
}

export const speechDrafts = {
  async list(projectId: string): Promise<SpeechDraft[]> {
    const connection = await openDatabase();
    return new Promise((resolve, reject) => {
      const request = connection.transaction("drafts").objectStore("drafts").index("projectId").getAll(projectId);
      request.onsuccess = () => resolve((request.result as SpeechDraft[]).sort((a, b) => b.savedAt.localeCompare(a.savedAt)));
      request.onerror = () => reject(new Error("Recovery drafts could not be read. Free disk space and reopen the project."));
    });
  },
  save(draft: SpeechDraft): Promise<void> { return write(store => { store.put(draft); }); },
  remove(id: string): Promise<void> { return write(store => { store.delete(id); }); },
};
