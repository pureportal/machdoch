const fieldLabels: Record<string, string> = {
  name: "Name",
  body: "Instruction",
  enabled: "Enabled",
  global: "Global",
  tags: "Tags",
  instructions: "Instructions",
  prompt: "Prompt",
  provider: "Provider",
  model: "Model",
  mode: "Mode",
  reasoning: "Reasoning",
  variables: "Variables",
  defaultValue: "Default",
  triggerPhrases: "Triggers",
  pathPatterns: "Paths",
  promptEnhancementMode: "Prompt enhancement",
  interviewEnabled: "Interview",
  sessionMemoryEnabled: "Session memory",
  useGlobalMemory: "Global memory",
  uiControlEnabled: "UI control",
  relativePath: "Path",
  content: "Prompt",
};

export function SettingsValuePreview({
  value,
  comparison,
  omitName = false,
}: {
  value: unknown;
  comparison?: unknown;
  omitName?: boolean;
}): React.ReactElement {
  if (Array.isArray(value)) {
    return (
      <div className="grid gap-2">
        {value.map((entry, index) => (
          <SettingsValuePreview key={index} value={entry} />
        ))}
      </div>
    );
  }
  if (value !== null && typeof value === "object") {
    const compared =
      comparison !== null && typeof comparison === "object"
        ? (comparison as Record<string, unknown>)
        : null;
    return (
      <dl className="grid gap-2">
        {Object.entries(value)
          .filter(
            ([key, entry]) =>
              fieldLabels[key] &&
              (!omitName || (key !== "name" && key !== "relativePath")) &&
              (!compared ||
                JSON.stringify(entry) !== JSON.stringify(compared[key])),
          )
          .map(([key, entry]) => (
            <div key={key}>
              <dt className="font-medium">{fieldLabels[key]}</dt>
              <dd>
                <SettingsValuePreview value={entry} />
              </dd>
            </div>
          ))}
      </dl>
    );
  }
  return (
    <p className="whitespace-pre-wrap break-words">
      {value === null
        ? "—"
        : typeof value === "boolean"
          ? value
            ? "On"
            : "Off"
          : String(value)}
    </p>
  );
}
