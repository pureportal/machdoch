import type { JSX } from "react";
import { getProviderLabel } from "../../../model-catalog";
import { USER_API_KEY_PROVIDER_ORDER } from "../../../runtime";
import {
  SettingsCard,
  SettingsCredentialForm,
  SettingsProviderChoice,
} from "./shared";
import type { ProviderSetupControls } from "./types";

export interface ProviderSettingsPanelProps {
  setup: ProviderSetupControls;
}

export const ProviderSettingsPanel = ({
  setup,
}: ProviderSettingsPanelProps): JSX.Element => {
  const providerLabel = getProviderLabel(setup.provider);

  return (
    <SettingsCard title="Model provider keys">
      <SettingsProviderChoice
        label="Provider"
        value={setup.provider}
        options={USER_API_KEY_PROVIDER_ORDER.map((provider) => ({
          value: provider,
          label: getProviderLabel(provider),
        }))}
        disabled={setup.saving}
        onChange={setup.onProviderChange}
      />

      <SettingsCredentialForm
        resetKey={setup.provider}
        providerLabel={providerLabel}
        keyValue={setup.keyValue}
        saving={setup.saving}
        message={setup.message}
        dirtyText="Provider key changes will save automatically"
        cleanText="Provider key is up to date"
        portalAction={{
          label: `Open ${providerLabel} API key settings`,
          title: `Open ${providerLabel} API key settings`,
          onClick: () => setup.onOpenProviderPortal(setup.provider),
        }}
        onSave={setup.onSave}
      />
    </SettingsCard>
  );
};
