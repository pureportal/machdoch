import { invoke } from "./media-platform";

export interface RefModInspection {
  path: string;
  name: string;
  kind: "image" | "video" | "audio" | "bundle";
  tokens: number;
  sizeBytes: number;
  members: Array<{
    key: string;
    kind: "image" | "video" | "audio";
    name: string;
    shape: number[];
    tokens: number;
    frameCount: number;
    metadata?: Record<string, unknown>;
  }>;
}

export type RefModLibraryEntry = Pick<
  RefModInspection,
  "path" | "name" | "tokens"
>;

type InspectionPage = {
  records: unknown[];
  errors?: unknown[];
  nextOffset: number | null;
};

export async function refModOperation<T>(
  workspaceRoot: string,
  request: Record<string, unknown>,
): Promise<T> {
  try {
    const operation = request.operation;
    if (operation !== "list" && operation !== "inspect-many")
      return await invoke<T>("media_refmod_operation", {
        workspaceRoot,
        request,
      });
    const records: unknown[] = [];
    const errors: unknown[] = [];
    let offset = 0;
    const limit = operation === "list" ? 1000 : 256;
    while (true) {
      const page = await invoke<InspectionPage>("media_refmod_operation", {
        workspaceRoot,
        request: { ...request, offset },
      });
      if (
        !page ||
        !Array.isArray(page.records) ||
        (operation === "list" && !Array.isArray(page.errors))
      )
        throw new Error("Could not finish reading RefMods. Try again.");
      records.push(...page.records);
      if (operation === "list") errors.push(...page.errors!);
      if (page.nextOffset === null)
        return (
          operation === "inspect-many" ? records : { records, errors }
        ) as T;
      if (
        !Number.isInteger(page.nextOffset) ||
        page.nextOffset <= offset ||
        page.nextOffset > limit
      )
        throw new Error("Could not finish reading RefMods. Try again.");
      offset = page.nextOffset;
    }
  } catch (failure) {
    if (failure && typeof failure === "object" && "message" in failure)
      throw new Error(String(failure.message));
    throw new Error(String(failure));
  }
}
