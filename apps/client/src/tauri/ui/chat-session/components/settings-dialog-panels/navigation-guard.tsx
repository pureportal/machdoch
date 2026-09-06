import {
  createContext,
  useCallback,
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
  guard: SettingsNavigationGuardState,
) => () => void;

const SettingsNavigationGuardContext =
  createContext<RegisterSettingsNavigationGuard | null>(null);

export const SettingsNavigationGuardProvider = ({
  children,
  onGuardChange,
}: {
  children: ReactNode;
  onGuardChange: (guard: SettingsNavigationGuardState | null) => void;
}): JSX.Element => {
  const guards = useRef(new Map<symbol, SettingsNavigationGuardState>());
  const registerGuard = useCallback<RegisterSettingsNavigationGuard>(
    (guard) => {
      const id = Symbol();
      const publish = (): void => {
        const active = [...guards.current.values()];
        const blocking = active.find(
          (candidate) => candidate.canDiscard === false,
        );
        onGuardChange(
          active.length === 0
            ? null
            : {
                ...(blocking ?? active[0]),
                onDiscard: async () => {
                  for (const candidate of active) await candidate.onDiscard();
                },
              },
        );
      };
      guards.current.set(id, guard);
      publish();
      return () => {
        guards.current.delete(id);
        publish();
      };
    },
    [onGuardChange],
  );

  return (
    <SettingsNavigationGuardContext.Provider value={registerGuard}>
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

    return registerGuard(guard);
  }, [canDiscard, confirmLabel, description, dirty, registerGuard, title]);
};
