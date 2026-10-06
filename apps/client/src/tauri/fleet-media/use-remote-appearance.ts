import { useEffect, useRef, useState } from "react";
import { deviceAppearanceSchema } from "@machdoch/fleet-protocol/device-settings";
import {
  useBrowserAppearance,
  type AppearanceSettings,
} from "@machdoch/product-ui";
import { invokeDeviceSettingsCommand } from "../ui/device-settings-platform";

export function useRemoteAppearance(): {
  settings: AppearanceSettings | null;
  saving: boolean;
  error: string | null;
  save(settings: AppearanceSettings): Promise<void>;
} {
  const browser = useBrowserAppearance();
  const browserRef = useRef(browser);
  browserRef.current = browser;
  const [settings, setSettings] = useState<AppearanceSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async (): Promise<void> => {
      try {
        if (!pending.current) {
          const value = deviceAppearanceSchema.parse(
            await invokeDeviceSettingsCommand("get_device_appearance"),
          );
          if (!disposed && !pending.current) {
            setSettings(value);
            browserRef.current.save(value);
            setError(null);
          }
        }
      } catch (cause) {
        if (!disposed)
          setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!disposed)
          timer = setTimeout(() => {
            void poll();
          }, 3000);
      }
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, []);
  return {
    settings,
    saving,
    error: error ?? browser.error,
    async save(next) {
      if (pending.current) return;
      pending.current = true;
      setSaving(true);
      setError(null);
      try {
        const value = deviceAppearanceSchema.parse(
          await invokeDeviceSettingsCommand("save_device_appearance", {
            settings: next,
          }),
        );
        setSettings(value);
        browserRef.current.save(value);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
        throw cause;
      } finally {
        pending.current = false;
        setSaving(false);
      }
    },
  };
}
