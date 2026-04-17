import { ArrowUpRight } from "lucide-react";
import type { JSX } from "react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { ScrollArea } from "../../components/ui/scroll-area";
import { Separator } from "../../components/ui/separator";
import { cn } from "../../lib/utils";
import { getProviderLabel } from "../../model-catalog";
import {
  USER_API_KEY_PROVIDER_ORDER,
  USER_WEB_SEARCH_PROVIDER_ORDER,
  type UserApiKeyProvider,
  type UserMemorySettings,
  type UserWebSearchApiKeyProvider,
  type WebSearchProvider,
} from "../../runtime";
import {
  SETTINGS_SECTIONS,
  getWebSearchProviderLabel,
  type SettingsSection,
} from "../_helpers/session-shell.ts";

export interface SettingsStatusMessage {
  tone: "success" | "error";
  text: string;
}

export interface ProviderSetupControls {
  provider: UserApiKeyProvider;
  keyValue: string;
  saving: boolean;
  message: SettingsStatusMessage | null;
  onProviderChange: (provider: UserApiKeyProvider) => void;
  onOpenProviderPortal: (provider: UserApiKeyProvider) => Promise<void> | void;
  onKeyChange: (value: string) => void;
  onSave: () => Promise<void> | void;
}

export interface WebSearchSetupControls {
  activeProvider: WebSearchProvider;
  provider: UserWebSearchApiKeyProvider;
  keyValue: string;
  saving: boolean;
  message: SettingsStatusMessage | null;
  onActiveProviderChange: (provider: WebSearchProvider) => Promise<void> | void;
  onProviderChange: (provider: UserWebSearchApiKeyProvider) => void;
  onKeyChange: (value: string) => void;
  onSave: () => Promise<void> | void;
}

export interface MemorySettingsControls {
  settings: UserMemorySettings;
  saving: boolean;
  message: SettingsStatusMessage | null;
  onGlobalEnabledChange: (enabled: boolean) => Promise<void> | void;
}

export interface SettingsDialogProps {
  settingsSection: SettingsSection;
  onSettingsSectionChange: (section: SettingsSection) => void;
  providerSetup: ProviderSetupControls;
  webSearchSetup: WebSearchSetupControls;
  memorySetup: MemorySettingsControls;
}

export const SettingsDialog = ({
  settingsSection,
  onSettingsSectionChange,
  providerSetup,
  webSearchSetup,
  memorySetup,
}: SettingsDialogProps): JSX.Element => {
  return (
    <DialogContent className="max-h-[85vh] max-w-2xl overflow-hidden rounded-3xl border-slate-800 bg-slate-950/96 p-0 text-slate-100 shadow-2xl">
      <div className="flex max-h-[85vh] flex-col overflow-hidden">
        <DialogHeader className="border-b border-slate-800 px-6 py-5 text-left">
          <DialogTitle className="text-xl font-semibold text-white">
            Settings
          </DialogTitle>
          <DialogDescription className="text-sm leading-6 text-slate-400">
            Provider API keys, web search connectors, and memory controls.
          </DialogDescription>
        </DialogHeader>

        <div className="border-b border-slate-800 px-6 py-4">
          <div className="flex flex-wrap gap-2">
            {SETTINGS_SECTIONS.map((section) => (
              <Button
                key={section.id}
                type="button"
                variant="outline"
                onClick={() => onSettingsSectionChange(section.id)}
                className={cn(
                  "h-9 rounded-full border-slate-800 bg-slate-950 px-3 text-xs text-slate-300 hover:bg-slate-900 hover:text-slate-100",
                  settingsSection === section.id &&
                    "border-sky-500/30 bg-sky-500/10 text-sky-100",
                )}
              >
                {section.label}
              </Button>
            ))}
          </div>
        </div>

        <ScrollArea className="min-h-0 flex-1" type="always">
          <div className="grid gap-6 px-6 py-6 pr-8">
            {settingsSection === "providers" ? (
              <div className="grid gap-4 rounded-2xl border border-slate-800 bg-slate-900/70 p-4">
                <div className="grid gap-1">
                  <p className="text-sm font-semibold text-slate-100">
                    Model providers
                  </p>
                  <p className="text-sm leading-6 text-slate-400">
                    Save the API keys the desktop shell can reuse for model
                    access.
                  </p>
                </div>

                <div className="flex flex-wrap gap-2">
                  {USER_API_KEY_PROVIDER_ORDER.map((provider) => (
                    <Button
                      key={provider}
                      type="button"
                      variant="outline"
                      onClick={() => providerSetup.onProviderChange(provider)}
                      className={cn(
                        "h-9 rounded-full border-slate-800 bg-slate-950 px-3 text-xs text-slate-300 hover:bg-slate-900 hover:text-slate-100",
                        providerSetup.provider === provider &&
                          "border-sky-500/30 bg-sky-500/10 text-sky-100",
                      )}
                    >
                      {getProviderLabel(provider)}
                    </Button>
                  ))}
                </div>

                <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
                  <Input
                    type="text"
                    value={providerSetup.keyValue}
                    onChange={(event) => {
                      providerSetup.onKeyChange(event.target.value);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void providerSetup.onSave();
                      }
                    }}
                    placeholder={`Paste your ${getProviderLabel(providerSetup.provider)} API key`}
                    autoComplete="off"
                    spellCheck={false}
                    className="h-11 rounded-2xl border-slate-800 bg-slate-950 text-slate-100 placeholder:text-slate-500"
                  />
                  <div className="flex items-center gap-2 md:justify-end">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Open ${getProviderLabel(providerSetup.provider)} API key settings`}
                      title={`Open ${getProviderLabel(providerSetup.provider)} API key settings`}
                      onClick={() => {
                        void providerSetup.onOpenProviderPortal(
                          providerSetup.provider,
                        );
                      }}
                      className="h-11 w-11 rounded-2xl border border-slate-800 bg-slate-950 text-slate-400 hover:bg-slate-900 hover:text-slate-100"
                    >
                      <ArrowUpRight className="h-4 w-4" />
                    </Button>
                    <Button
                      type="button"
                      onClick={() => {
                        void providerSetup.onSave();
                      }}
                      disabled={
                        !providerSetup.keyValue.trim() || providerSetup.saving
                      }
                      className="h-11 rounded-2xl bg-sky-600 px-5 text-white hover:bg-sky-500 disabled:opacity-50"
                    >
                      {providerSetup.saving ? "Saving…" : "Save key"}
                    </Button>
                  </div>
                </div>

                {providerSetup.message ? (
                  <p
                    className={cn(
                      "text-xs leading-6",
                      providerSetup.message.tone === "error"
                        ? "text-rose-300"
                        : "text-emerald-300",
                    )}
                  >
                    {providerSetup.message.text}
                  </p>
                ) : null}
              </div>
            ) : null}

            {settingsSection === "web-search" ? (
              <div className="grid gap-4 rounded-2xl border border-slate-800 bg-slate-900/70 p-4">
                <div className="grid gap-1">
                  <p className="text-sm font-semibold text-slate-100">
                    Web search
                  </p>
                  <p className="text-sm leading-6 text-slate-400">
                    Choose one active provider at a time. The executor hides web
                    search until the active provider has a configured key.
                  </p>
                </div>

                <div className="grid gap-2">
                  <p className="text-xs font-semibold tracking-[0.18em] text-slate-500 uppercase">
                    Active web search provider
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {(["none", ...USER_WEB_SEARCH_PROVIDER_ORDER] as const).map(
                      (provider) => (
                        <Button
                          key={provider}
                          type="button"
                          variant="outline"
                          onClick={() => {
                            void webSearchSetup.onActiveProviderChange(
                              provider,
                            );
                          }}
                          disabled={webSearchSetup.saving}
                          className={cn(
                            "h-9 rounded-full border-slate-800 bg-slate-950 px-3 text-xs text-slate-300 hover:bg-slate-900 hover:text-slate-100",
                            webSearchSetup.activeProvider === provider &&
                              "border-sky-500/30 bg-sky-500/10 text-sky-100",
                          )}
                        >
                          {getWebSearchProviderLabel(provider)}
                        </Button>
                      ),
                    )}
                  </div>
                </div>

                <Separator className="bg-slate-800" />

                <div className="grid gap-2">
                  <p className="text-xs font-semibold tracking-[0.18em] text-slate-500 uppercase">
                    API keys
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {USER_WEB_SEARCH_PROVIDER_ORDER.map((provider) => (
                      <Button
                        key={provider}
                        type="button"
                        variant="outline"
                        onClick={() =>
                          webSearchSetup.onProviderChange(provider)
                        }
                        className={cn(
                          "h-9 rounded-full border-slate-800 bg-slate-950 px-3 text-xs text-slate-300 hover:bg-slate-900 hover:text-slate-100",
                          webSearchSetup.provider === provider &&
                            "border-sky-500/30 bg-sky-500/10 text-sky-100",
                        )}
                      >
                        {getWebSearchProviderLabel(provider)}
                      </Button>
                    ))}
                  </div>
                </div>

                <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
                  <Input
                    type="text"
                    value={webSearchSetup.keyValue}
                    onChange={(event) => {
                      webSearchSetup.onKeyChange(event.target.value);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void webSearchSetup.onSave();
                      }
                    }}
                    placeholder={`Paste your ${getWebSearchProviderLabel(webSearchSetup.provider)} API key`}
                    autoComplete="off"
                    spellCheck={false}
                    className="h-11 rounded-2xl border-slate-800 bg-slate-950 text-slate-100 placeholder:text-slate-500"
                  />
                  <Button
                    type="button"
                    onClick={() => {
                      void webSearchSetup.onSave();
                    }}
                    disabled={
                      !webSearchSetup.keyValue.trim() || webSearchSetup.saving
                    }
                    className="h-11 rounded-2xl bg-sky-600 px-5 text-white hover:bg-sky-500 disabled:opacity-50"
                  >
                    {webSearchSetup.saving ? "Saving…" : "Save key"}
                  </Button>
                </div>

                {webSearchSetup.message ? (
                  <p
                    className={cn(
                      "text-xs leading-6",
                      webSearchSetup.message.tone === "error"
                        ? "text-rose-300"
                        : "text-emerald-300",
                    )}
                  >
                    {webSearchSetup.message.text}
                  </p>
                ) : null}
              </div>
            ) : null}

            {settingsSection === "memory" ? (
              <div className="grid gap-4 rounded-2xl border border-slate-800 bg-slate-900/70 p-4">
                <div className="grid gap-1">
                  <p className="text-sm font-semibold text-slate-100">
                    Global memory
                  </p>
                  <p className="text-sm leading-6 text-slate-400">
                    Cross-session facts the assistant can reuse later. Keep this
                    off if you want every session to start fresh.
                  </p>
                </div>

                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={memorySetup.saving}
                    onClick={() => {
                      void memorySetup.onGlobalEnabledChange(true);
                    }}
                    className={cn(
                      "h-9 rounded-full border-slate-800 bg-slate-950 px-3 text-xs text-slate-300 hover:bg-slate-900 hover:text-slate-100",
                      memorySetup.settings.globalEnabled &&
                        "border-sky-500/30 bg-sky-500/10 text-sky-100",
                    )}
                  >
                    Enabled
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={memorySetup.saving}
                    onClick={() => {
                      void memorySetup.onGlobalEnabledChange(false);
                    }}
                    className={cn(
                      "h-9 rounded-full border-slate-800 bg-slate-950 px-3 text-xs text-slate-300 hover:bg-slate-900 hover:text-slate-100",
                      !memorySetup.settings.globalEnabled &&
                        "border-slate-600 bg-slate-900 text-slate-100",
                    )}
                  >
                    Disabled
                  </Button>
                  <Badge className="border-slate-700 bg-slate-950 text-slate-300">
                    {memorySetup.settings.entries.length} saved fact
                    {memorySetup.settings.entries.length === 1 ? "" : "s"}
                  </Badge>
                </div>

                {memorySetup.settings.entries.length === 0 ? (
                  <p className="text-sm leading-6 text-slate-500">
                    No global memories have been saved yet.
                  </p>
                ) : (
                  <div className="grid gap-2">
                    {memorySetup.settings.entries.map((entry) => (
                      <div
                        key={entry.id}
                        className="rounded-2xl border border-slate-800 bg-slate-950 px-4 py-3 text-sm leading-6 text-slate-300"
                      >
                        {entry.content}
                      </div>
                    ))}
                  </div>
                )}

                {memorySetup.message ? (
                  <p
                    className={cn(
                      "text-xs leading-6",
                      memorySetup.message.tone === "error"
                        ? "text-rose-300"
                        : "text-emerald-300",
                    )}
                  >
                    {memorySetup.message.text}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        </ScrollArea>
      </div>
    </DialogContent>
  );
};
