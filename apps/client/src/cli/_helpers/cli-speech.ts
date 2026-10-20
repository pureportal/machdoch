import { readFile, stat } from "node:fs/promises";
import {
  nativeSpeechRuntime,
  produceSpeechProject,
  submitSpeechProject,
} from "../../core/speech.js";
import type { SpeechProductionRequest } from "../../core/speech.js";
import type { SpeechOperations } from "@machdoch/speech/runtime";
import type { ParsedCliArgs } from "./cli-args-types.js";
import { writeStdoutLine } from "./cli-io.js";

const operations = new Set<keyof SpeechOperations>([
  "runtimeModelStatus", "runtimeInstallModel", "runtimeCancelDownload", "runtimeRemoveModel",
  "listProjects",
  "getProject",
  "revisions",
  "getRevision",
  "listProfiles",
  "listDictionaries",
  "dictionaryRevisions",
  "render",
  "listJobs",
  "listTakes",
  "resolveTakes",
  "takeProvenance",
  "align",
  "regenerate",
  "compareVoices",
  "listVoiceReviews",
  "listFavoriteVoices",
  "listVoiceMutations",
  "checkVoiceMutation",
  "updateVoice",
  "deleteVoice",
  "designVoice",
  "createVoice",
  "getVoiceWorkflow",
  "getDiagnostics",
  "archiveReferences",
  "getTiming",
  "listTimings",
  "resolveTimings",
  "cancel",
  "queue",
  "retry",
  "export",
]);

export async function runSpeechCommand(args: ParsedCliArgs): Promise<void> {
  const path = args.speech?.inputJsonFile;
  if (!path)
    throw new Error("Supply --input-json-file for the speech operation.");
  if ((await stat(path)).size > 4 * 1024 * 1024)
    throw new Error("Keep speech automation input below 4 MiB.");
  const request: unknown = JSON.parse(await readFile(path, "utf8"));
  if (
    !request ||
    typeof request !== "object" ||
    Array.isArray(request) ||
    Object.keys(request).length !== 2 ||
    !("operation" in request) ||
    !("input" in request) ||
    typeof request.operation !== "string" ||
    !request.input ||
    typeof request.input !== "object" ||
    Array.isArray(request.input)
  )
    throw new Error("Supply a speech operation and its structured input.");
  let result: unknown;
  if (request.operation === "produce")
    result = await produceSpeechProject(
      request.input as SpeechProductionRequest,
    );
  else if (request.operation === "renderProject")
    result = await submitSpeechProject(
      request.input as Omit<SpeechProductionRequest, "output">,
    );
  else if (operations.has(request.operation as keyof SpeechOperations))
    result = await nativeSpeechRuntime.execute(
      request.operation as keyof SpeechOperations,
      request.input as SpeechOperations[keyof SpeechOperations]["input"],
    );
  else
    throw new Error(
      `Choose produce, renderProject, ${[...operations].join(", ")}.`,
    );
  writeStdoutLine(JSON.stringify(result));
}
