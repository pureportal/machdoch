import { createRoot } from "react-dom/client";
import { SettingsManager } from "../../apps/fleet-manager/src/app/(dashboard)/settings/settings-manager";
import "../../apps/fleet-manager/src/app/globals.css";

createRoot(document.getElementById("root")!).render(
  <div className="fleet-dashboard min-h-dvh lg:grid lg:grid-cols-[240px_minmax(0,1fr)]">
    <aside aria-hidden="true" />
    <main className="min-w-0">
      <div className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:px-10 lg:py-10">
        <SettingsManager />
      </div>
    </main>
  </div>,
);
