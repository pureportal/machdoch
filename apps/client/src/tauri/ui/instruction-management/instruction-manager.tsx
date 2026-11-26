import {
  InstructionManager as SharedInstructionManager,
  type InstructionManagementControls,
} from "@machdoch/client-ui/instructions";
import { instructionRuntime } from "./instruction-runtime";
import { useState, useCallback } from "react";
import { Tabs } from "radix-ui";
import { SkillLibraryPanel } from "./skill-library-panel";

const LIBRARY_TABS = [
  { value: "instructions", label: "Instructions" },
  { value: "skills", label: "Skills" },
] as const;

type LibraryTab = (typeof LIBRARY_TABS)[number]["value"];

export function InstructionManager(props: {
  setup: InstructionManagementControls;
  onDirtyChange?: (dirty: boolean) => void;
}): React.ReactElement {
  const [tab, setTab] = useState<LibraryTab>("instructions");
  const [dirty, setDirty] = useState(false);
  const onDirtyChange = useCallback(
    (value: boolean) => {
      setDirty(value);
      props.onDirtyChange?.(value);
    },
    [props.onDirtyChange],
  );
  return (
    <Tabs.Root
      value={tab}
      activationMode="manual"
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-slate-950"
      onValueChange={(value) => {
        if (!dirty || window.confirm("Discard unsaved changes?")) {
          setTab(value as LibraryTab);
          onDirtyChange(false);
        }
      }}
    >
      <Tabs.List
        className="flex shrink-0 items-end gap-1 border-b border-slate-900 px-4"
        aria-label="Library"
      >
        {LIBRARY_TABS.map(({ value, label }) => (
          <Tabs.Trigger
            key={value}
            value={value}
            className="relative h-11 px-3 text-sm font-medium text-slate-400 outline-none transition-colors hover:text-slate-200 focus-visible:text-slate-100 aria-selected:text-slate-100 aria-selected:after:absolute aria-selected:after:inset-x-2 aria-selected:after:bottom-0 aria-selected:after:h-0.5 aria-selected:after:rounded-full aria-selected:after:bg-sky-400"
          >
            {label}
          </Tabs.Trigger>
        ))}
      </Tabs.List>
      <Tabs.Content
        value="skills"
        className="flex min-h-0 min-w-0 flex-1 data-[state=inactive]:hidden"
      >
        <SkillLibraryPanel onDirtyChange={onDirtyChange} />
      </Tabs.Content>
      <Tabs.Content
        value="instructions"
        className="flex min-h-0 min-w-0 flex-1 data-[state=inactive]:hidden"
      >
        <SharedInstructionManager
          {...props}
          onDirtyChange={onDirtyChange}
          runtime={instructionRuntime}
        />
      </Tabs.Content>
    </Tabs.Root>
  );
}
