import {
  isMediaPoseMap,
  type MediaPoseGuidance,
  type MediaPoseMap,
  type MediaPosePerson,
} from "../../../../core/media/pose-map.js";

export const STORAGE_KEY = "machdoch.pose-templates.v1";
export type PoseTemplate = {
  id: string;
  label: string;
  people: MediaPosePerson[];
  aspectRatio?: MediaPoseMap["aspectRatio"];
  guidance?: Guidance;
};
export type Guidance = MediaPoseGuidance;
export const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));
export const copyName = (
  label: string,
  templates: readonly PoseTemplate[],
): string => {
  const base = `${label} copy`;
  let name = base;
  for (
    let number = 2;
    templates.some((template) => template.label === name);
    number++
  )
    name = `${base} ${number}`;
  return name;
};
export const copyPeople = (
  people: readonly MediaPosePerson[],
): MediaPosePerson[] =>
  people.map((person) => ({
    ...person,
    ...(person.joints
      ? { joints: person.joints.map((joint) => ({ ...joint })) }
      : {}),
  }));

export const arrangePeople = (
  people: readonly MediaPosePerson[],
): MediaPosePerson[] => {
  if (people.length < 2) return copyPeople(people);
  const positions =
    {
      2: [0.31, 0.69],
      3: [0.2, 0.5, 0.8],
      4: [0.14, 0.38, 0.62, 0.86],
    }[people.length] ?? [];
  const baseScale = { 2: 0.55, 3: 0.4, 4: 0.3 }[people.length] ?? 0.3;
  return copyPeople(people).map((person, index) => ({
    ...person,
    x: positions[index]!,
    scale: Math.min(person.scale, baseScale),
  }));
};

export const addPeopleToScene = (
  existing: readonly MediaPosePerson[],
  additions: readonly MediaPosePerson[],
): MediaPosePerson[] => {
  const people = copyPeople(existing);
  if (people.length === 0) return copyPeople(additions);

  for (const addition of copyPeople(additions)) {
    const candidates = [addition.x, 0.18, 0.82, 0.35, 0.65, 0.5];
    const separation = (x: number): number =>
      Math.min(...people.map((person) => Math.abs(x - person.x)));
    const x = candidates.reduce((best, candidate) =>
      separation(candidate) > separation(best) ? candidate : best,
    );
    people.push({ ...addition, x, scale: Math.min(addition.scale, 0.4) });
  }

  return people;
};

export function readTemplates(): PoseTemplate[] {
  try {
    const value = JSON.parse(
      localStorage.getItem(STORAGE_KEY) ?? "[]",
    ) as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is PoseTemplate => {
      if (typeof item !== "object" || item === null) return false;
      const template = item as Partial<PoseTemplate>;
      return (
        typeof template.id === "string" &&
        typeof template.label === "string" &&
        isMediaPoseMap({
          aspectRatio: template.aspectRatio ?? "1:1",
          people: template.people,
        }) &&
        (template.guidance === undefined ||
          (template.guidance !== null &&
            typeof template.guidance === "object" &&
            typeof template.guidance.strength === "number" &&
            template.guidance.strength >= 0 &&
            template.guidance.strength <= 2 &&
            typeof template.guidance.start === "number" &&
            typeof template.guidance.end === "number" &&
            template.guidance.start >= 0 &&
            template.guidance.start < template.guidance.end &&
            template.guidance.end <= 1))
      );
    });
  } catch {
    return [];
  }
}
