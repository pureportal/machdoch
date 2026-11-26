import type { SkillRequest } from "@machdoch/fleet-protocol/skills";
import type { ManagedSkill } from "@machdoch/product-ui/skills-management";

const previewFingerprint = (revision: number): string =>
  revision.toString(16).padStart(64, "0");

let revision = 2;

let previewSkills: ManagedSkill[] = [
  {
    name: "code-review",
    description: "Review a diff for correctness bugs and risky changes.",
    content:
      "# Code review\n\n1. Read the diff.\n2. Flag correctness issues first.\n3. Suggest focused fixes.",
    enabled: true,
    fingerprint: previewFingerprint(1),
    path: "skills/code-review/SKILL.md",
  },
  {
    name: "release-notes",
    description: "Draft release notes from merged changes.",
    content: "# Release notes\n\nGroup changes by feature, fix, and chore.",
    enabled: false,
    fingerprint: previewFingerprint(2),
    path: "skills/release-notes/SKILL.md",
  },
];

export const runPreviewSkillRequest = (request: SkillRequest): unknown => {
  if (request.action === "list") return structuredClone(previewSkills);
  const current = previewSkills.find(
    ({ name }) =>
      name === (request.action === "save" ? request.skill.name : request.name),
  );
  const expectedFingerprint =
    request.action === "save"
      ? request.skill.expectedFingerprint
      : request.expectedFingerprint;
  if (current && current.fingerprint !== expectedFingerprint) {
    throw new Error("The skill changed. Reload and retry.");
  }
  if (request.action === "delete") {
    previewSkills = previewSkills.filter(({ name }) => name !== request.name);
    return null;
  }
  revision += 1;
  const { expectedFingerprint: _expected, ...skill } = request.skill;
  const saved: ManagedSkill = {
    ...skill,
    fingerprint: previewFingerprint(revision),
    path: `skills/${skill.name}/SKILL.md`,
  };
  previewSkills = [
    ...previewSkills.filter(({ name }) => name !== saved.name),
    saved,
  ];
  return structuredClone(saved);
};
