import { useState, type JSX } from "react";
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
  const [credentialDirty, setCredentialDirty] = useState(false);
  const providerConfigured = new Map(
    setup.providerAvailability.map((availability) => [
      availability.provider,
      availability.configured,
    ]),
  );
  const selectedProviderLabel = getWebSearchProviderLabel(setup.provider);
  const webSearchProviderOptions: ReadonlyArray<{
    value: WebSearchProvider;
    label: string;
  }> = (["none", ...USER_WEB_SEARCH_PROVIDER_ORDER] as const).map(
    (provider) => ({
      value: provider,
      label: getWebSearchProviderLabel(provider),
      disabled: provider !== "none" && !providerConfigured.get(provider),
      title:
        provider !== "none" && !providerConfigured.get(provider)
          ? "Add this provider's API key before selecting it."
          : undefined,
    }),
  );

  return (
    <SettingsCard title="Web search">
      <SettingsProviderChoice
        label="Active web search provider"
        detail="New tasks use this provider when web search is enabled."
        value={setup.activeProvider}
        options={webSearchProviderOptions}
        disabled={setup.loading || setup.saving}
        onChange={setup.onActiveProviderChange}
      />

      <SettingsProviderChoice
        label="Manage API key"
        detail={
          credentialDirty
            ? "Save or restore the edited key before switching providers."
            : undefined
        }
        value={setup.provider}
        options={USER_WEB_SEARCH_PROVIDER_ORDER.map((provider) => ({
          value: provider,
          label: getWebSearchProviderLabel(provider),
        }))}
        disabled={setup.loading || setup.saving || credentialDirty}
        onChange={setup.onProviderChange}
      />

      <SettingsCredentialForm
        resetKey={setup.provider}
        providerLabel={selectedProviderLabel}
        keyValue={setup.keyValue}
        loading={setup.loading}
        saving={setup.saving}
        message={setup.message}
        dirtyText="Web-search key changes will save automatically"
        cleanText="Web-search key is up to date"
        onDirtyChange={setCredentialDirty}
        onSave={setup.onSave}
      />
    </SettingsCard>
  );
};
