import { useCallback, useEffect, useRef, useState } from "react";
import type {
  InstructionMutationInput,
  InstructionMutationResult,
  InstructionRegistryResult,
} from "@machdoch/fleet-protocol/instruction-contract";
import type { InstructionManagementControls } from "./types";

export interface InstructionLibraryRuntime {
  loadRegistry(workspace: string | null): Promise<InstructionRegistryResult>;
  mutate(
    workspace: string | null,
    input: InstructionMutationInput,
  ): Promise<InstructionMutationResult>;
  beforeSave?(
    input: InstructionMutationInput,
    registry: InstructionRegistryResult | null,
  ): Promise<void>;
  afterSave?(
    input: InstructionMutationInput,
    registry: InstructionRegistryResult | null,
  ): Promise<void>;
}

export function useInstructionManagement(
  workspaceRoot: string | null,
  runtime: InstructionLibraryRuntime,
) {
  const [registry, setRegistry] = useState<InstructionRegistryResult | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] =
    useState<InstructionManagementControls["message"]>(null);
  const runtimeRef = useRef(runtime);
  runtimeRef.current = runtime;
  const registryRef = useRef(registry);
  registryRef.current = registry;
  const requestIdRef = useRef(0);
  const savingRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestIdRef.current += 1;
    };
  }, []);

  const onRefresh = useCallback(async (): Promise<void> => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    try {
      const next = await runtimeRef.current.loadRegistry(workspaceRoot);
      if (!mountedRef.current || requestIdRef.current !== requestId) return;
      setRegistry(next);
      setMessage(null);
    } catch (error) {
      if (mountedRef.current && requestIdRef.current === requestId)
        setMessage({
          tone: "error",
          text: error instanceof Error ? error.message : String(error),
        });
    } finally {
      if (mountedRef.current && requestIdRef.current === requestId)
        setLoading(false);
    }
  }, [workspaceRoot]);

  const onSave = useCallback(
    async (
      input: InstructionMutationInput,
    ): Promise<InstructionMutationResult | false> => {
      if (savingRef.current) return false;
      savingRef.current = true;
      setSaving(true);
      setMessage(null);
      const operations = runtimeRef.current;
      const previous = registryRef.current;
      try {
        await operations.beforeSave?.(input, previous);
        const result = await operations.mutate(workspaceRoot, input);
        await operations.afterSave?.(input, previous);
        if (mountedRef.current) await onRefresh();
        return result;
      } catch (error) {
        if (mountedRef.current)
          setMessage({
            tone: "error",
            text: error instanceof Error ? error.message : String(error),
          });
        return false;
      } finally {
        savingRef.current = false;
        if (mountedRef.current) setSaving(false);
      }
    },
    [onRefresh, workspaceRoot],
  );

  return {
    workspaceRoot,
    registry,
    loading,
    saving,
    message,
    onRefresh,
    onSave,
  };
}
