import { ArrowUpRight, Eye, EyeOff } from "lucide-react";
import { useEffect, useState, type JSX } from "react";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { getProviderLabel } from "../../../model-catalog";
import { USER_API_KEY_PROVIDER_ORDER } from "../../../runtime";
import {
  ChoiceButtons,
  SettingPanel,
  SettingsCard,
  SettingsSaveBar,
  SettingsStatus,
} from "./shared";
import type { ProviderSetupControls, SettingsStatusMessage } from "./types";

export interface ProviderSettingsPanelProps {
  setup: ProviderSetupControls;
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

export const ProviderSettingsPanel = ({
  setup,
}: ProviderSettingsPanelProps): JSX.Element => {
  const [draftKey, setDraftKey] = useState(setup.keyValue);
  const [savedKey, setSavedKey] = useState(setup.keyValue.trim());
  const [keyVisible, setKeyVisible] = useState(false);
  const [saveAttempted, setSaveAttempted] = useState(false);
  const providerLabel = getProviderLabel(setup.provider);
  const normalizedDraftKey = draftKey.trim();
  const keyDirty = normalizedDraftKey !== savedKey;
  const validationMessage = getApiKeyValidationMessage(
    providerLabel,
    draftKey,
    saveAttempted,
  );

  useEffect(() => {
    setDraftKey(setup.keyValue);
    setSavedKey(setup.keyValue.trim());
    setKeyVisible(false);
    setSaveAttempted(false);
  }, [setup.provider]);

  useEffect(() => {
    if (!keyDirty) {
      setDraftKey(setup.keyValue);
      setSavedKey(setup.keyValue.trim());
    }
  }, [keyDirty, setup.keyValue]);

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
      setSaveAttempted(false);
    }
  };

  return (
    <SettingsCard
      title="Model provider keys"
      description="Provider key edits stay local until you save them."
    >
      <SettingPanel label="Provider">
        <ChoiceButtons
          value={setup.provider}
          options={USER_API_KEY_PROVIDER_ORDER.map((provider) => ({
            value: provider,
            label: getProviderLabel(provider),
          }))}
          disabled={setup.saving}
          onChange={setup.onProviderChange}
        />
      </SettingPanel>

      <SettingPanel label={`${providerLabel} API key`}>
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
            placeholder={`Paste your ${providerLabel} API key`}
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
              aria-label={`${keyVisible ? "Hide" : "Show"} ${providerLabel} API key`}
              title={`${keyVisible ? "Hide" : "Show"} ${providerLabel} API key`}
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
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={`Open ${providerLabel} API key settings`}
              title={`Open ${providerLabel} API key settings`}
              onClick={() => {
                void setup.onOpenProviderPortal(setup.provider);
              }}
              className="h-10 w-10 rounded-lg border border-slate-800 bg-slate-950 text-slate-400 hover:bg-slate-900 hover:text-slate-100"
            >
              <ArrowUpRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </SettingPanel>

      <SettingsSaveBar
        dirty={keyDirty}
        dirtyText="Unsaved provider key changes"
        cleanText="Provider key is up to date"
        saveLabel="Save provider key"
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
