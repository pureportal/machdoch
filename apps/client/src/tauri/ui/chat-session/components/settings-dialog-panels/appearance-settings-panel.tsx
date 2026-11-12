import { useState, type JSX } from "react";
import { Minus, Plus } from "lucide-react";
import { AppearanceOptions } from "@machdoch/product-ui";
import { SettingsCard, SettingsStatus } from "./shared";
import type { AppearanceSettingsControls } from "./types";
import { useSettingsNavigationGuard } from "./navigation-guard";
import { stepChatZoomPercent } from "../../_helpers/chat-zoom";
import type { ChatZoomController } from "../../_helpers/use-chat-zoom";
import {
  DEFAULT_CHAT_ZOOM_PERCENT,
  MAX_CHAT_ZOOM_PERCENT,
  MIN_CHAT_ZOOM_PERCENT,
} from "../../../lib/shell-store";

const ChatZoomOptions = ({
  chatZoom: { zoomPercent, onZoomPercentChange },
}: {
  chatZoom: ChatZoomController;
}): JSX.Element => (
  <div className="m-appearance-options">
    <fieldset>
      <legend>Chat zoom</legend>
      <div>
        <button
          type="button"
          aria-label="Zoom out chat"
          disabled={zoomPercent <= MIN_CHAT_ZOOM_PERCENT}
          onClick={() =>
            onZoomPercentChange(stepChatZoomPercent(zoomPercent, -1))
          }
        >
          <Minus aria-hidden="true" className="size-4" />
        </button>
        <output
          aria-label="Chat zoom"
          aria-live="polite"
          className="inline-flex min-w-14 items-center justify-center text-sm tabular-nums text-(--app-text)"
        >
          {zoomPercent}%
        </output>
        <button
          type="button"
          aria-label="Zoom in chat"
          disabled={zoomPercent >= MAX_CHAT_ZOOM_PERCENT}
          onClick={() =>
            onZoomPercentChange(stepChatZoomPercent(zoomPercent, 1))
          }
        >
          <Plus aria-hidden="true" className="size-4" />
        </button>
        <button
          type="button"
          disabled={zoomPercent === DEFAULT_CHAT_ZOOM_PERCENT}
          onClick={() => onZoomPercentChange(DEFAULT_CHAT_ZOOM_PERCENT)}
        >
          Reset
        </button>
      </div>
    </fieldset>
  </div>
);

export const AppearanceSettingsPanel = ({
  setup,
  chatZoom,
}: {
  setup: AppearanceSettingsControls;
  chatZoom?: ChatZoomController;
}): JSX.Element => {
  const [saveError, setSaveError] = useState<string | null>(null);
  useSettingsNavigationGuard({
    dirty: setup.saving,
    title: "Saving appearance",
    description:
      "Wait for the appearance change to finish saving before leaving this section.",
    canDiscard: false,
    onDiscard: () => undefined,
  });
  return (
    <SettingsCard title="Interface">
      <div className="grid gap-5 py-4">
        <AppearanceOptions
          settings={setup.settings}
          disabled={setup.saving}
          onChange={(settings) => {
            setSaveError(null);
            void Promise.resolve(setup.onSave(settings)).catch(
              (cause: unknown) => {
                console.error("Failed to save appearance settings", cause);
                setSaveError(
                  "Appearance settings could not be saved. Try again.",
                );
              },
            );
          }}
        />
        {chatZoom ? <ChatZoomOptions chatZoom={chatZoom} /> : null}
      </div>
      {setup.saving ? <p role="status">Saving…</p> : null}
      <SettingsStatus
        message={saveError ? { tone: "error", text: saveError } : null}
      />
    </SettingsCard>
  );
};
