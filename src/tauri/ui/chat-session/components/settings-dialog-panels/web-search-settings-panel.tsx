import type { JSX } from "react";
import {
  USER_WEB_SEARCH_PROVIDER_ORDER,
  type WebSearchProvider,
} from "../../../runtime";
import { getWebSearchProviderLabel } from "../../_helpers/session-shell";
import {
  SettingsCard,
  SettingsCredentialForm,
  SettingsProviderChoice,
} from "./shared";
import type { WebSearchSetupControls } from "./types";

export interface WebSearchSettingsPanelProps {
  setup: WebSearchSetupControls;
}

export const WebSearchSettingsPanel = ({
  setup,
}: WebSearchSettingsPanelProps): JSX.Element => {
  const selectedProviderLabel = getWebSearchProviderLabel(setup.provider);
  const webSearchProviderOptions: ReadonlyArray<{
    value: WebSearchProvider;
    label: string;
  }> = (["none", ...USER_WEB_SEARCH_PROVIDER_ORDER] as const).map(
    (provider) => ({
      value: provider,
      label: getWebSearchProviderLabel(provider),
    }),
  );

  return (
    <SettingsCard title="Web search">
      <SettingsProviderChoice
        label="Active web search provider"
        detail="New tasks use this provider when web search is enabled."
        value={setup.activeProvider}
        options={webSearchProviderOptions}
        disabled={setup.saving}
        onChange={setup.onActiveProviderChange}
      />

      <SettingsProviderChoice
        label="API keys"
        value={setup.provider}
        options={USER_WEB_SEARCH_PROVIDER_ORDER.map((provider) => ({
          value: provider,
          label: getWebSearchProviderLabel(provider),
        }))}
        disabled={setup.saving}
        onChange={setup.onProviderChange}
      />

      <SettingsCredentialForm
        resetKey={setup.provider}
        providerLabel={selectedProviderLabel}
        keyValue={setup.keyValue}
        saving={setup.saving}
        message={setup.message}
        dirtyText="Web-search key changes will save automatically"
        cleanText="Web-search key is up to date"
        onSave={setup.onSave}
      />
    </SettingsCard>
  );
};
