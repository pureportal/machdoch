import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  navigatePromptHistory,
  type PromptHistoryNavigationState,
} from "./prompt-history-navigation.helper";

interface UsePromptHistoryNavigationOptions {
  value: string;
  history: readonly string[];
  onValueChange: (value: string) => void;
}

interface PromptHistoryNavigationController {
  historyIndex: number | null;
  handleValueChange: (value: string) => void;
  handleKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  resetHistoryNavigation: () => void;
}

const createNavigationState = (draft: string): PromptHistoryNavigationState => ({
  draft,
  draftBeforeHistory: "",
  historyIndex: null,
});

export const usePromptHistoryNavigation = ({
  value,
  history,
  onValueChange,
}: UsePromptHistoryNavigationOptions): PromptHistoryNavigationController => {
  const [navigationState, setNavigationState] =
    useState<PromptHistoryNavigationState>(() => createNavigationState(value));
  const navigationStateRef = useRef(navigationState);
  const valueRef = useRef(value);
  const historyRef = useRef(history);
  const onValueChangeRef = useRef(onValueChange);
  const expectedValueRef = useRef<string | null>(null);
  const previousValueRef = useRef(value);
  const historyIdentity = JSON.stringify(history);
  const previousHistoryIdentityRef = useRef(historyIdentity);

  navigationStateRef.current = navigationState;
  valueRef.current = value;
  historyRef.current = history;
  onValueChangeRef.current = onValueChange;

  const setCurrentNavigationState = useCallback(
    (nextState: PromptHistoryNavigationState): void => {
      navigationStateRef.current = nextState;
      setNavigationState(nextState);
    },
    [],
  );

  const resetHistoryNavigation = useCallback((): void => {
    expectedValueRef.current = null;
    setCurrentNavigationState(createNavigationState(valueRef.current));
  }, [setCurrentNavigationState]);

  useEffect(() => {
    if (previousValueRef.current === value) {
      return;
    }

    previousValueRef.current = value;

    if (expectedValueRef.current === value) {
      expectedValueRef.current = null;
      return;
    }

    setCurrentNavigationState(createNavigationState(value));
  }, [setCurrentNavigationState, value]);

  useEffect(() => {
    if (previousHistoryIdentityRef.current === historyIdentity) {
      return;
    }

    previousHistoryIdentityRef.current = historyIdentity;
    resetHistoryNavigation();
  }, [historyIdentity, resetHistoryNavigation]);

  const handleValueChange = useCallback(
    (nextValue: string): void => {
      expectedValueRef.current = nextValue;
      setCurrentNavigationState(createNavigationState(nextValue));
      onValueChangeRef.current(nextValue);
    },
    [setCurrentNavigationState],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>): void => {
      if (
        event.nativeEvent.isComposing ||
        event.keyCode === 229 ||
        (event.key !== "ArrowUp" && event.key !== "ArrowDown")
      ) {
        return;
      }

      const currentHistory = historyRef.current;
      const currentState = navigationStateRef.current;
      const isBrowsingHistory = currentState.historyIndex !== null;

      if (currentHistory.length === 0) {
        if (isBrowsingHistory) {
          resetHistoryNavigation();
        }
        return;
      }

      if (!isBrowsingHistory) {
        const textarea = event.currentTarget;

        if (
          event.key === "ArrowDown" ||
          textarea.selectionStart !== textarea.selectionEnd ||
          textarea.selectionStart !== 0
        ) {
          return;
        }
      }

      event.preventDefault();

      const nextState = navigatePromptHistory(
        isBrowsingHistory
          ? currentState
          : createNavigationState(valueRef.current),
        currentHistory,
        event.key === "ArrowUp" ? "previous" : "next",
      );

      expectedValueRef.current = nextState.draft;
      setCurrentNavigationState(nextState);
      onValueChangeRef.current(nextState.draft);
    },
    [resetHistoryNavigation, setCurrentNavigationState],
  );

  return {
    historyIndex: navigationState.historyIndex,
    handleValueChange,
    handleKeyDown,
    resetHistoryNavigation,
  };
};
