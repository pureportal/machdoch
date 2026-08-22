import {
  createContext,
  useContext,
  useEffect,
  useRef,
  type JSX,
  type ReactNode,
} from "react";

export interface SettingsNavigationGuardState {
  title: string;
  description: string;
  confirmLabel?: string;
  canDiscard?: boolean;
  onDiscard: () => Promise<void> | void;
}

type RegisterSettingsNavigationGuard = (
  guard: SettingsNavigationGuardState | null,
) => void;

const SettingsNavigationGuardContext =
  createContext<RegisterSettingsNavigationGuard | null>(null);

export const SettingsNavigationGuardProvider = ({
  children,
  onGuardChange,
}: {
  children: ReactNode;
  onGuardChange: RegisterSettingsNavigationGuard;
}): JSX.Element => {
  return (
    <SettingsNavigationGuardContext.Provider value={onGuardChange}>
      {children}
    </SettingsNavigationGuardContext.Provider>
  );
};

export const useSettingsNavigationGuard = ({
  dirty,
  title,
  description,
  confirmLabel,
  canDiscard = true,
  onDiscard,
}: SettingsNavigationGuardState & { dirty: boolean }): void => {
  const registerGuard = useContext(SettingsNavigationGuardContext);
  const onDiscardRef = useRef(onDiscard);
  onDiscardRef.current = onDiscard;

  useEffect(() => {
    if (!registerGuard || !dirty) {
      return;
    }

    const guard: SettingsNavigationGuardState = {
      title,
      description,
      confirmLabel,
      canDiscard,
      onDiscard: () => onDiscardRef.current(),
    };

    registerGuard(guard);

    return () => {
      registerGuard(null);
    };
  }, [
    canDiscard,
    confirmLabel,
    description,
    dirty,
    registerGuard,
    title,
  ]);
};
