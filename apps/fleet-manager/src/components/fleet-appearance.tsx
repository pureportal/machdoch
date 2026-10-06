"use client";

import { AppearanceOptions, useBrowserAppearance } from "@machdoch/product-ui";

export function FleetAppearance(): null {
  useBrowserAppearance();
  return null;
}

export function AppearancePreferences(): React.ReactElement {
  const appearance = useBrowserAppearance();
  return (
    <section className="rounded-xl border bg-card p-6">
      <h2 className="mb-5 font-semibold">Appearance</h2>
      <AppearanceOptions
        settings={appearance.settings}
        onChange={appearance.save}
      />
      {appearance.error ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {appearance.error}
        </p>
      ) : null}
    </section>
  );
}
