import { useEffect, useRef, useState, type JSX } from "react";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import { Input } from "@machdoch/media-studio/tauri/ui/components/ui/input.js";
import { DEFAULT_ANSWER_LANGUAGE } from "../../../../../core/runtime-contract.generated.js";
import {
  loadUserAnswerLanguage,
  saveUserAnswerLanguage,
} from "../../../runtime";
import { useSettingsNavigationGuard } from "./navigation-guard";
import {
  SettingPanel,
  SettingsAutoSaveStatus,
  SettingsCard,
  SettingsStatus,
  useDebouncedAutoSave,
} from "./shared";
import type { SettingsStatusMessage } from "./types";

export const AnswerLanguageSettingsPanel = (): JSX.Element => {
  const [savedLanguage, setSavedLanguage] = useState<string | null>(null);
  const [draft, setDraft] = useState<string>(DEFAULT_ANSWER_LANGUAGE);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<SettingsStatusMessage | null>(null);
  const suppressUnmountFlushRef = useRef(false);
  const language = draft.trim();
  const dirty = savedLanguage !== null && language !== savedLanguage;

  useEffect(() => {
    let disposed = false;
    void loadUserAnswerLanguage()
      .then((loadedLanguage) => {
        if (disposed) return;
        setSavedLanguage(loadedLanguage);
        setDraft(loadedLanguage);
      })
      .catch(() => {
        if (!disposed) {
          setMessage({
            tone: "error",
            text: "Failed to load answer language. Reopen settings to retry.",
          });
        }
      });
    return () => {
      disposed = true;
    };
  }, []);

  const save = async (): Promise<void> => {
    setSaving(true);
    setMessage(null);
    try {
      setSavedLanguage(await saveUserAnswerLanguage(language));
    } catch {
      setMessage({
        tone: "error",
        text: "Failed to save answer language. Try again.",
      });
    } finally {
      setSaving(false);
    }
  };

  useDebouncedAutoSave({
    dirty,
    saving,
    signature: language,
    onSave: save,
    suppressUnmountFlushRef,
  });

  useSettingsNavigationGuard({
    dirty: dirty || saving,
    title: "Unsaved answer language",
    description: saving
      ? "Wait for the answer language to finish saving."
      : "Unsaved language changes will be discarded.",
    canDiscard: !saving,
    onDiscard: () => {
      suppressUnmountFlushRef.current = true;
      setDraft(savedLanguage ?? DEFAULT_ANSWER_LANGUAGE);
    },
  });

  return (
    <SettingsCard title="Answer language">
      <SettingPanel label="Language">
        <div className="flex items-center gap-2">
          <Input
            aria-label="Answer language"
            placeholder="Not set"
            value={draft}
            disabled={savedLanguage === null || saving}
            onChange={(event) => setDraft(event.target.value)}
            className="h-10 max-w-64 rounded-lg border-slate-800 bg-slate-950 text-slate-100"
          />
          <Button
            type="button"
            variant="outline"
            disabled={savedLanguage === null || saving || !draft}
            onClick={() => setDraft("")}
          >
            Clear
          </Button>
        </div>
      </SettingPanel>
      <SettingsAutoSaveStatus
        dirty={dirty}
        saving={saving}
        dirtyText="Unsaved changes"
        cleanText=""
        onSaveNow={save}
      />
      <SettingsStatus message={message} />
    </SettingsCard>
  );
};
