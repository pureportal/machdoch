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
    metadata: Record<string, unknown>;
  }>;
}

export async function refModOperation<T>(
  workspaceRoot: string,
  request: Record<string, unknown>,
): Promise<T> {
  try {
    return await invoke<T>("media_refmod_operation", {
      workspaceRoot,
      request,
    });
  } catch (failure) {
    if (failure && typeof failure === "object" && "message" in failure)
      throw new Error(String(failure.message));
    throw new Error(String(failure));
  }
}
