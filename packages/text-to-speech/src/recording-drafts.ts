export interface RecordingDraft { id: string; audio: Blob; transcript: string; rightsEvidence: string; createdAt: string }

async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("machdoch-speech-recordings", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("recordings", { keyPath: "id" });
    request.onerror = () => reject(new Error("Recording recovery storage is unavailable. Keep this window open and retry."));
    request.onsuccess = () => resolve(request.result);
  });
}

export async function recordingDrafts(action: "list" | "save" | "delete", value?: RecordingDraft | string): Promise<RecordingDraft[]> {
  const connection = await database();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = connection.transaction("recordings", action === "list" ? "readonly" : "readwrite", { durability: "strict" });
      const store = transaction.objectStore("recordings");
      if (action === "save") store.put(value);
      if (action === "delete") store.delete(value as string);
      const request = store.getAll();
      transaction.oncomplete = () => resolve(request.result as RecordingDraft[]);
      transaction.onerror = () => reject(new Error("The recording recovery copy could not be saved. Check available storage and retry."));
      transaction.onabort = () => reject(new Error("Recording recovery storage was interrupted. Keep this window open and retry."));
    });
  } finally { connection.close(); }
}
