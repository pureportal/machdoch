import { useState, type JSX } from "react";
import {
  getUserApiKeyProviderLabel,
  USER_API_KEY_PROVIDER_ORDER,
} from "../../../runtime";
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
  const providerLabel = getUserApiKeyProviderLabel(setup.provider);
  const [credentialDirty, setCredentialDirty] = useState(false);

  return (
    <SettingsCard title="Model provider keys">
      <SettingsProviderChoice
        label="Provider"
        detail={
          credentialDirty
            ? "Save or restore the edited key before switching providers."
            : undefined
        }
        value={setup.provider}
        options={USER_API_KEY_PROVIDER_ORDER.map((provider) => ({
          value: provider,
          label: getUserApiKeyProviderLabel(provider),
        }))}
        disabled={setup.loading || setup.saving || credentialDirty}
        onChange={setup.onProviderChange}
      />

      <SettingsCredentialForm
        resetKey={setup.provider}
        providerLabel={providerLabel}
        keyValue={setup.keyValue}
        loading={setup.loading}
        saving={setup.saving}
        message={setup.message}
        dirtyText="Provider key changes will save automatically"
        cleanText="Provider key is up to date"
        portalAction={{
          label: `Open ${providerLabel} API key settings`,
          title: `Open ${providerLabel} API key settings`,
          onClick: () => setup.onOpenProviderPortal(setup.provider),
        }}
        onDirtyChange={setCredentialDirty}
        onSave={setup.onSave}
      />
    </SettingsCard>
  );
};
