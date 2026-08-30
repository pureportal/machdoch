import { Boxes, FileClock, FolderGit2, ImagePlus } from "lucide-react";

export type MediaStudioSection = "generate" | "flow" | "library" | "runs";

const sections: readonly {
  id: MediaStudioSection;
  label: string;
  icon: typeof ImagePlus;
  separated?: boolean;
}[] = [
  { id: "generate", label: "Basic", icon: ImagePlus },
  { id: "flow", label: "Advanced", icon: FolderGit2 },
  { id: "library", label: "Assets", icon: Boxes, separated: true },
  { id: "runs", label: "Activity", icon: FileClock },
] as const;

export function MediaStudioNavigation({
  activeSection,
  availableSections = sections.map((section) => section.id),
  onSelect,
}: {
  activeSection: MediaStudioSection;
  availableSections?: readonly MediaStudioSection[];
  onSelect: (section: MediaStudioSection) => void;
}): React.ReactElement {
  const available = new Set(availableSections);
  return (
    <aside className="m-media-navigation">
      <nav aria-label="Media Studio">
        {sections.flatMap((section) => {
          if (!available.has(section.id)) return [];
          const Icon = section.icon;
          const active = activeSection === section.id;
          return [
            <div
              key={section.id}
              className={
                section.separated ? "m-media-navigation-separated" : undefined
              }
            >
              <button
                type="button"
                aria-label={section.label}
                aria-current={active ? "page" : undefined}
                data-active={active}
                onClick={() => onSelect(section.id)}
              >
                <Icon aria-hidden="true" />
                <span>{section.label}</span>
              </button>
            </div>,
          ];
        })}
      </nav>
    </aside>
  );
}
