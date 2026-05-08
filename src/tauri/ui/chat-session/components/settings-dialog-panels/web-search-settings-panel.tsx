import { Eye, EyeOff } from "lucide-react";
import { useEffect, useState, type JSX } from "react";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import {
  USER_WEB_SEARCH_PROVIDER_ORDER,
  type WebSearchProvider,
} from "../../../runtime";
import { getWebSearchProviderLabel } from "../../_helpers/session-shell";
import {
  ChoiceButtons,
  SettingPanel,
  SettingsCard,
  SettingsSaveBar,
  SettingsStatus,
} from "./shared";
import type { SettingsStatusMessage, WebSearchSetupControls } from "./types";

export interface WebSearchSettingsPanelProps {
  setup: WebSearchSetupControls;
}

const getApiKeyValidationMessage = (
  providerLabel: string,
  draftKey: string,
  saveAttempted: boolean,
): SettingsStatusMessage | null => {
  if (!saveAttempted || draftKey.trim().length > 0) {
    return null;
  }

  return {
    tone: "error",
    text: `Enter a ${providerLabel} API key before saving.`,
  };
};

export const WebSearchSettingsPanel = ({
  setup,
}: WebSearchSettingsPanelProps): JSX.Element => {
  const [draftKey, setDraftKey] = useState(setup.keyValue);
  const [savedKey, setSavedKey] = useState(setup.keyValue.trim());
  const [lastExternalKey, setLastExternalKey] = useState(setup.keyValue);
  const [keyVisible, setKeyVisible] = useState(false);
  const [saveAttempted, setSaveAttempted] = useState(false);
  const selectedProviderLabel = getWebSearchProviderLabel(setup.provider);
  const normalizedDraftKey = draftKey.trim();
  const keyDirty = normalizedDraftKey !== savedKey;
  const validationMessage = getApiKeyValidationMessage(
    selectedProviderLabel,
    draftKey,
    saveAttempted,
  );
  const webSearchProviderOptions: ReadonlyArray<{
    value: WebSearchProvider;
    label: string;
  }> = (["none", ...USER_WEB_SEARCH_PROVIDER_ORDER] as const).map(
    (provider) => ({
      value: provider,
      label: getWebSearchProviderLabel(provider),
    }),
  );

  useEffect(() => {
    setDraftKey(setup.keyValue);
    setSavedKey(setup.keyValue.trim());
    setLastExternalKey(setup.keyValue);
    setKeyVisible(false);
    setSaveAttempted(false);
  }, [setup.provider]);

  useEffect(() => {
    if (setup.keyValue === lastExternalKey) {
      return;
    }

    setDraftKey((currentDraft) =>
      currentDraft.trim() === savedKey ? setup.keyValue : currentDraft,
    );
    setSavedKey(setup.keyValue.trim());
    setLastExternalKey(setup.keyValue);
    setSaveAttempted(false);
  }, [lastExternalKey, savedKey, setup.keyValue]);

  const updateDraftKey = (value: string): void => {
    setDraftKey(value);

    if (saveAttempted && value.trim().length > 0) {
      setSaveAttempted(false);
    }
  };

  const saveDraftKey = async (): Promise<void> => {
    setSaveAttempted(true);

    if (normalizedDraftKey.length === 0) {
      return;
    }

    const saved = await setup.onSave(normalizedDraftKey);

    if (saved) {
      setDraftKey(normalizedDraftKey);
      setSavedKey(normalizedDraftKey);
      setLastExternalKey(normalizedDraftKey);
      setSaveAttempted(false);
    }
  };

  return (
    <SettingsCard
      title="Web search"
      description="Provider selection applies immediately; API key edits require saving."
    >
      <SettingPanel
        label="Active web search provider"
        detail="New tasks use this provider when web search is enabled."
      >
        <ChoiceButtons
          value={setup.activeProvider}
          options={webSearchProviderOptions}
          disabled={setup.saving}
          onChange={(provider) => {
            void setup.onActiveProviderChange(provider);
          }}
        />
      </SettingPanel>

      <SettingPanel label="API keys">
        <ChoiceButtons
          value={setup.provider}
          options={USER_WEB_SEARCH_PROVIDER_ORDER.map((provider) => ({
            value: provider,
            label: getWebSearchProviderLabel(provider),
          }))}
          disabled={setup.saving}
          onChange={setup.onProviderChange}
        />
      </SettingPanel>

      <SettingPanel label={`${selectedProviderLabel} API key`}>
        <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
          <Input
            type={keyVisible ? "text" : "password"}
            value={draftKey}
            onChange={(event) => {
              updateDraftKey(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void saveDraftKey();
              }
            }}
            placeholder={`Paste your ${selectedProviderLabel} API key`}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={validationMessage ? true : undefined}
            className="h-10 rounded-lg border-slate-800 bg-slate-950 text-slate-100 placeholder:text-slate-500"
          />
          <div className="flex items-center gap-2 md:justify-end">
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label={`${keyVisible ? "Hide" : "Show"} ${selectedProviderLabel} API key`}
              title={`${keyVisible ? "Hide" : "Show"} ${selectedProviderLabel} API key`}
              onClick={() => setKeyVisible((visible) => !visible)}
              disabled={draftKey.trim().length === 0}
              className="h-10 w-10 rounded-lg border-slate-800 bg-slate-950 text-slate-300 hover:bg-slate-900 hover:text-slate-100 disabled:opacity-40"
            >
              {keyVisible ? (
                <EyeOff className="h-4 w-4" />
              ) : (
                <Eye className="h-4 w-4" />
              )}
            </Button>
          </div>
        </div>
      </SettingPanel>

      <SettingsSaveBar
        dirty={keyDirty}
        dirtyText="Unsaved web-search key changes"
        cleanText="Web-search key is up to date"
        saveLabel="Save web-search key"
        savingLabel="Saving..."
        saving={setup.saving}
        onSave={() => {
          void saveDraftKey();
        }}
      />

      <SettingsStatus message={validationMessage ?? setup.message} />
    </SettingsCard>
  );
};
