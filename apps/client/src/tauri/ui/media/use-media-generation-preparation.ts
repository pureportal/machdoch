import { useCallback, useRef, useState } from "react";
import { setMediaGenerationPreparing } from "./media-generation-service";

export const useMediaGenerationPreparation = (): [
  boolean,
  (pending: boolean) => Promise<void>,
] => {
  const id = useRef(Symbol());
  const [pending, setPending] = useState(false);
  const updatePending = useCallback((value: boolean) => {
    setPending(value);
    return setMediaGenerationPreparing(id.current, value);
  }, []);
  return [pending, updatePending];
};
