import { invoke, isTauri } from "@tauri-apps/api/core";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { LazyStore } from "@tauri-apps/plugin-store";
import { useEffect, useRef, useState } from "react";
import { trackOperation } from "@machdoch/analytics/operations";
import { parseRelease } from "../../../update/release.js";
import {
  deferUpdateNotification,
  normalizeUpdateNotificationPreference,
  shouldNotifyForUpdate,
  type UpdateNotificationPreference,
} from "./update-notifications";

export const CHECK_FOR_UPDATES_EVENT = "machdoch:check-for-updates";
type UpdatePhase =
  | "idle"
  | "checking"
  | "available"
  | "current"
  | "downloading"
  | "installing"
  | "installed"
  | "error";

export function useDesktopUpdate(options: {
  busy: boolean;
  flush: () => Promise<void>;
}) {
  const [phase, setPhase] = useState<UpdatePhase>("idle");
  const [open, setOpen] = useState(false);
  const [release, setRelease] = useState<Update | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{
    downloaded: number;
    total?: number;
  }>({ downloaded: 0 });
  const [saving, setSaving] = useState(false);
  const update = useRef<Update | null>(null);
  const preference = useRef<UpdateNotificationPreference>({});
  const store = useRef<LazyStore | null>(null);
  const installing = useRef(false);
  const installed = useRef(false);
  const checking = useRef(false);
  const latest = useRef(options);
  latest.current = options;

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    let reminder: ReturnType<typeof setInterval> | undefined;
    let enabled = false;
    const showPending = () => {
      if (
        !disposed &&
        update.current &&
        shouldNotifyForUpdate(
          update.current.version,
          preference.current,
          Date.now(),
        )
      )
        setOpen(true);
    };
    const checkForUpdate = async (manual = false) => {
      if (
        disposed ||
        !enabled ||
        checking.current ||
        installing.current ||
        installed.current
      )
        return;
      checking.current = true;
      if (manual) {
        setOpen(true);
        setPhase("checking");
        setError(null);
      }
      try {
        const found = await trackOperation(manual ? "update.check" : "", () =>
          check({
            timeout: 30_000,
            headers: { "Cache-Control": "no-cache" },
          }),
        );
        if (disposed) {
          await found?.close();
          return;
        }
        if (found) {
          try {
            parseRelease(found.rawJson);
          } catch (failure) {
            await found.close();
            throw failure;
          }
        }
        const previous = update.current;
        update.current = found;
        setRelease(found);
        setPhase(found ? "available" : "current");
        setError(null);
        if (previous) await previous.close();
        if (
          manual ||
          (found &&
            shouldNotifyForUpdate(
              found.version,
              preference.current,
              Date.now(),
            ))
        )
          setOpen(true);
      } catch (failure) {
        if (disposed) return;
        const message =
          failure instanceof Error ? failure.message : String(failure);
        if (manual) {
          setPhase("error");
          setError(`Could not check for updates. ${message}`);
        } else console.error("Could not check for updates", failure);
      } finally {
        checking.current = false;
      }
    };
    const manualCheck = () => {
      void checkForUpdate(true);
    };
    const resumeCheck = () => {
      if (document.visibilityState === "visible") showPending();
    };
    void (async () => {
      try {
        enabled = await invoke<boolean>("app_update_available");
        if (disposed || !enabled) return;
        const notificationStore = new LazyStore("machdoch-update-state.json", {
          autoSave: false,
        });
        store.current = notificationStore;
        window.addEventListener(CHECK_FOR_UPDATES_EVENT, manualCheck);
        preference.current = normalizeUpdateNotificationPreference(
          await notificationStore.get("notification"),
        );
        if (disposed) return;
        document.addEventListener("visibilitychange", resumeCheck);
        await checkForUpdate();
        if (disposed) return;
        timer = setInterval(
          () => {
            void checkForUpdate();
          },
          6 * 60 * 60_000,
        );
        reminder = setInterval(showPending, 60_000);
      } catch (failure) {
        if (!disposed) console.error("Could not initialize updates", failure);
      }
    })();
    return () => {
      disposed = true;
      clearInterval(timer);
      clearInterval(reminder);
      window.removeEventListener(CHECK_FOR_UPDATES_EVENT, manualCheck);
      document.removeEventListener("visibilitychange", resumeCheck);
      const current = update.current;
      update.current = null;
      if (current && !installing.current)
        void current
          .close()
          .catch((failure: unknown) =>
            console.error("Could not release update", failure),
          );
    };
  }, []);

  async function defer(duration: "hour" | "day" | "week" | "release") {
    if (installing.current || saving) return;
    if (!update.current) {
      setOpen(false);
      return;
    }
    setSaving(true);
    try {
      const next = deferUpdateNotification(
        update.current.version,
        duration,
        Date.now(),
      );
      if (!store.current)
        throw new Error("Update preferences are unavailable.");
      await store.current.set("notification", next);
      await store.current.save();
      preference.current = next;
      setOpen(false);
    } catch (failure) {
      setError(
        `Could not save the reminder. ${failure instanceof Error ? failure.message : String(failure)}`,
      );
    } finally {
      setSaving(false);
    }
  }

  async function install() {
    const selected = update.current;
    if (
      !selected ||
      installing.current ||
      checking.current ||
      installed.current
    )
      return;
    installing.current = true;
    setError(null);
    try {
      if (latest.current.busy)
        throw new Error(
          "Wait for running work to finish before installing the update.",
        );
      await latest.current.flush();
      await invoke("prepare_app_update");
      setPhase("downloading");
      setProgress({ downloaded: 0 });
      await trackOperation("update.download", () =>
        selected.download(
          (event) => {
            if (event.event === "Started")
              setProgress({ downloaded: 0, total: event.data.contentLength });
            else if (event.event === "Progress")
              setProgress((value) => ({
                ...value,
                downloaded: value.downloaded + event.data.chunkLength,
              }));
          },
          { timeout: 30 * 60_000 },
        ),
      );
      if (latest.current.busy)
        throw new Error(
          "Work started during the download. Wait for it to finish and try again.",
        );
      await latest.current.flush();
      await invoke("prepare_app_update");
      setPhase("installing");
      await trackOperation("update.install", () => selected.install());
      installed.current = true;
      setPhase("installed");
      await relaunch();
    } catch (failure) {
      setPhase((value) => (value === "installed" ? "installed" : "available"));
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      installing.current = false;
      await invoke("finish_app_update").catch((failure: unknown) => {
        console.error("Could not release the update lock", failure);
        setError(
          "Could not release the update lock. Restart Machdoch before trying again.",
        );
      });
    }
  }

  return {
    phase,
    open,
    release,
    error,
    progress,
    saving,
    defer,
    install,
    check: () => window.dispatchEvent(new Event(CHECK_FOR_UPDATES_EVENT)),
    restart: async () => {
      try {
        if (latest.current.busy)
          throw new Error("Wait for running work to finish before restarting.");
        await latest.current.flush();
        await invoke("prepare_app_update");
        await relaunch();
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure));
      } finally {
        await invoke("finish_app_update").catch((failure: unknown) => {
          console.error("Could not release the update lock", failure);
          setError(
            "Could not release the update lock. Restart Machdoch before trying again.",
          );
        });
      }
    },
    close: () => {
      void defer("hour");
    },
  };
}
