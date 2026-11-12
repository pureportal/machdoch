"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Cpu, Plus, SquareTerminal } from "lucide-react";
import {
  isCloudCliProvider,
  type CloudAiProvider,
  type CloudProviderSettings,
} from "@machdoch/fleet-protocol/cloud-providers";
import { providerLabels } from "@/lib/cloud-provider-presets";
import { Button } from "@/components/ui/button";
import { ProviderDialog } from "./provider-form";
import {
  CliLoginStatus,
  CliSignInDialog,
  useCliLogin,
} from "./provider-sign-in";
import { ProviderUsage } from "./provider-usage";

function ProviderCard({
  provider,
  editable,
  signInNow,
  onEdit,
  onSignInStarted,
}: {
  provider: CloudAiProvider;
  editable: boolean;
  signInNow: boolean;
  onEdit: () => void;
  onSignInStarted: () => void;
}) {
  const login = useCliLogin(provider.signIn ? provider.id : null);
  const [signingIn, setSigningIn] = useState(false);
  const signedIn = login.login?.state === "signed-in";
  function openSignIn() {
    setSigningIn(true);
    if (login.login?.state !== "waiting") void login.start();
  }
  useEffect(() => {
    if (!signInNow) return;
    onSignInStarted();
    openSignIn();
  });
  const Icon = isCloudCliProvider(provider.provider) ? SquareTerminal : Cpu;
  const description = [
    providerLabels[provider.provider] !== provider.name &&
      providerLabels[provider.provider],
    provider.region?.toUpperCase(),
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <section className="cloud-card">
      <span className="cloud-icon-tile">
        <Icon size={20} />
      </span>
      <div className="flex items-center justify-between gap-3">
        <h2>{provider.name}</h2>
        {!provider.enabled && <span>Disabled</span>}
      </div>
      {description && <p>{description}</p>}
      {provider.signIn && <CliLoginStatus login={login.login} />}
      <ul className="cloud-provider-models">
        {provider.models.map((model) => (
          <li key={model}>{model}</li>
        ))}
      </ul>
      <div className="cloud-card-actions">
        {provider.signIn && (
          <Button
            variant={signedIn ? "outline" : "default"}
            disabled={!editable || !login.login}
            onClick={openSignIn}
          >
            {signedIn ? "Switch account" : "Sign in"}
          </Button>
        )}
        <Button variant="outline" disabled={!editable} onClick={onEdit}>
          Edit provider
        </Button>
        <ProviderUsage providerId={provider.id} />
      </div>
      {signingIn && (
        <CliSignInDialog
          providerName={provider.name}
          state={login}
          onClose={() => {
            setSigningIn(false);
            void login.refresh();
          }}
        />
      )}
    </section>
  );
}

export function AiProviderSettings({
  settings,
}: {
  settings: CloudProviderSettings;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<CloudAiProvider | "new" | null>(null);
  const [signInId, setSignInId] = useState<string | null>(null);
  const editable = settings.credentialStorageAvailable;
  return (
    <>
      <header className="cloud-page-header">
        <h1>AI providers</h1>
        <Button disabled={!editable} onClick={() => setEditing("new")}>
          <Plus />
          Add provider
        </Button>
      </header>
      {!editable && (
        <p role="status" className="cloud-error">
          Credential storage is not configured. Contact your administrator.
        </p>
      )}
      {!settings.providers.length ? (
        <div className="cloud-empty">
          <Cpu aria-hidden="true" />
          <p>No AI providers configured.</p>
        </div>
      ) : (
        <div className="cloud-grid">
          {settings.providers.map((provider) => (
            <ProviderCard
              key={provider.id}
              provider={provider}
              editable={editable}
              signInNow={provider.id === signInId}
              onEdit={() => setEditing(provider)}
              onSignInStarted={() => setSignInId(null)}
            />
          ))}
        </div>
      )}
      {editing && (
        <ProviderDialog
          provider={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(id, signIn) => {
            setEditing(null);
            if (editing === "new" && signIn) setSignInId(id);
            router.refresh();
          }}
        />
      )}
    </>
  );
}
