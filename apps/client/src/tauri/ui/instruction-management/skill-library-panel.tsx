import { SkillsManagement, type ManagedSkill, type SaveManagedSkillInput } from "@machdoch/product-ui/skills-management";
import type { SkillRequest } from "@machdoch/fleet-protocol/skills";
import { invoke } from "@tauri-apps/api/core";
import { getRemoteInstructionPlatform } from "./instruction-platform";

function run<Result>(input: SkillRequest): Promise<Result> {
  const remote = getRemoteInstructionPlatform();
  return remote ? remote.invoke<Result>("run_skill_command", { input }) : invoke<Result>("run_skill_command", { input });
}

const listSkills = () => run<ManagedSkill[]>({ action: "list" });
const saveSkill = (skill: SaveManagedSkillInput) => run<ManagedSkill>({ action: "save", skill });
const deleteSkill = (name: string, expectedFingerprint: string) => run({ action: "delete", name, expectedFingerprint });

export function SkillLibraryPanel({ onDirtyChange }: { onDirtyChange?: (dirty: boolean) => void }): React.ReactElement {
  return <SkillsManagement listSkills={listSkills} saveSkill={saveSkill} deleteSkill={deleteSkill} onDirtyChange={onDirtyChange} />;
}
