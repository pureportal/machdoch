import type { AppearanceSettings } from "./appearance";

const options = {
  theme: [
    { value: "dark", label: "Dark" },
    { value: "light", label: "Light" },
  ],
  density: [
    { value: "comfortable", label: "Comfortable" },
    { value: "compact", label: "Compact" },
  ],
  accent: [
    { value: "sky", label: "Sky" },
    { value: "emerald", label: "Sage" },
    { value: "violet", label: "Violet" },
    { value: "amber", label: "Amber" },
  ],
} as const;

export function AppearanceOptions({
  settings,
  disabled = false,
  onChange,
}: {
  settings: AppearanceSettings;
  disabled?: boolean;
  onChange: (settings: AppearanceSettings) => void;
}): React.ReactElement {
  return (
    <div className="m-appearance-options">
      {(["theme", "density", "accent"] as const).map((field) => (
        <fieldset key={field} disabled={disabled}>
          <legend>
            {field === "theme"
              ? "Theme"
              : field === "density"
                ? "Density"
                : "Accent"}
          </legend>
          <div>
            {options[field].map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={settings[field] === option.value}
                onClick={() => onChange({ ...settings, [field]: option.value })}
              >
                {field === "accent" ? (
                  <span aria-hidden="true" data-accent={option.value} />
                ) : null}
                {option.label}
              </button>
            ))}
          </div>
        </fieldset>
      ))}
    </div>
  );
}
