import {
  SkillsManagement,
  type ManagedSkill,
  type SaveManagedSkillInput,
} from "@machdoch/product-ui/skills-management";
import type { SkillRequest } from "@machdoch/fleet-protocol/skills";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getRemoteInstructionPlatform } from "./instruction-platform";
import { runPreviewSkillRequest } from "./skill-preview-library";

async function run<Result>(input: SkillRequest): Promise<Result> {
  const remote = getRemoteInstructionPlatform();
  if (remote) return remote.invoke<Result>("run_skill_command", { input });
  if (!isTauri()) return runPreviewSkillRequest(input) as Result;
  return invoke<Result>("run_skill_command", { input });
}

const listSkills = () => run<ManagedSkill[]>({ action: "list" });
const saveSkill = (skill: SaveManagedSkillInput) =>
  run<ManagedSkill>({ action: "save", skill });
const deleteSkill = (name: string, expectedFingerprint: string) =>
  run({ action: "delete", name, expectedFingerprint });

export function SkillLibraryPanel({
  onDirtyChange,
}: {
  onDirtyChange?: (dirty: boolean) => void;
}): React.ReactElement {
  return (
    <SkillsManagement
      listSkills={listSkills}
      saveSkill={saveSkill}
      deleteSkill={deleteSkill}
      onDirtyChange={onDirtyChange}
    />
  );
}
