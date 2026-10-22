import {
  InstructionManager as SharedInstructionManager,
  type InstructionManagementControls,
} from "@machdoch/client-ui/instructions";
import { instructionRuntime } from "./instruction-runtime";
import { useState, useCallback } from "react";
import { Tabs } from "radix-ui";
import { SkillLibraryPanel } from "./skill-library-panel";

export function InstructionManager(props: {
  setup: InstructionManagementControls;
  onDirtyChange?: (dirty: boolean) => void;
}): React.ReactElement {
  const [tab, setTab] = useState<"instructions" | "skills">("instructions");
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
      className="flex h-full min-h-0 flex-col"
      onValueChange={(value) => {
        if (!dirty || window.confirm("Discard unsaved changes?")) {
          setTab(value as typeof tab);
          onDirtyChange(false);
        }
      }}
    >
      <Tabs.List
        className="flex shrink-0 gap-2 border-b border-slate-800 p-3"
        aria-label="Library"
      >
        {(["instructions", "skills"] as const).map((value) => (
          <Tabs.Trigger
            key={value}
            value={value}
            className="rounded-md border border-slate-700 px-3 py-2 text-sm aria-selected:bg-slate-800"
          >
            {value === "skills" ? "Skills" : "Instructions"}
          </Tabs.Trigger>
        ))}
      </Tabs.List>
      <Tabs.Content value="skills" className="min-h-0 flex-1 overflow-auto">
        <SkillLibraryPanel onDirtyChange={onDirtyChange} />
      </Tabs.Content>
      <Tabs.Content
        value="instructions"
        className="flex min-h-0 flex-1 data-[state=inactive]:hidden"
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
