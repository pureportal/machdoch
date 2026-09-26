export type MediaPoseKind =
  | "standing"
  | "sitting"
  | "walking"
  | "waving"
  | "arms-up"
  | "climbing";

export interface MediaPosePerson {
  pose: MediaPoseKind;
  x: number;
  y: number;
  scale: number;
  mirror: boolean;
  joints?: MediaPoseJoint[];
}

export interface MediaPoseJoint {
  x: number;
  y: number;
}

export interface MediaPoseMap {
  aspectRatio: "1:1" | "4:5" | "16:9" | "9:16";
  people: MediaPosePerson[];
}

export interface MediaSavedPoseScene {
  id: string;
  label: string;
  map?: MediaPoseMap;
}

export interface MediaPoseGuidance {
  strength: number;
  start: number;
  end: number;
}

export function isMediaOpenPoseAsset(asset: {
  kind: string;
  tags: readonly { value: string }[];
}): boolean {
  return (
    asset.kind === "image" && asset.tags.some((tag) => tag.value === "openpose")
  );
}

export const MEDIA_POSE_PRESETS: ReadonlyArray<{
  id: string;
  label: string;
  people: MediaPosePerson[];
}> = [
  {
    id: "standing",
    label: "Standing",
    people: [{ pose: "standing", x: 0.5, y: 0.92, scale: 0.8, mirror: false }],
  },
  {
    id: "sitting",
    label: "Sitting",
    people: [{ pose: "sitting", x: 0.48, y: 0.92, scale: 0.78, mirror: false }],
  },
  {
    id: "walking",
    label: "Walking",
    people: [{ pose: "walking", x: 0.5, y: 0.92, scale: 0.8, mirror: false }],
  },
  {
    id: "waving",
    label: "Waving",
    people: [{ pose: "waving", x: 0.5, y: 0.92, scale: 0.8, mirror: false }],
  },
  {
    id: "climbing",
    label: "Climbing",
    people: [{ pose: "climbing", x: 0.5, y: 0.92, scale: 0.8, mirror: false }],
  },
];

const standingJoints: readonly [number, number][] = [
  [0.5, 0.1],
  [0.5, 0.21],
  [0.4, 0.24],
  [0.37, 0.42],
  [0.35, 0.59],
  [0.6, 0.24],
  [0.63, 0.42],
  [0.65, 0.59],
  [0.45, 0.53],
  [0.43, 0.74],
  [0.42, 0.98],
  [0.55, 0.53],
  [0.57, 0.74],
  [0.58, 0.98],
  [0.47, 0.08],
  [0.53, 0.08],
  [0.44, 0.1],
  [0.56, 0.1],
];

export const MEDIA_POSE_BONES: readonly [number, number, string][] = [
  [1, 2, "#ff0000"],
  [1, 5, "#ff5500"],
  [2, 3, "#ffaa00"],
  [3, 4, "#ffff00"],
  [5, 6, "#aaff00"],
  [6, 7, "#55ff00"],
  [1, 8, "#00ff00"],
  [8, 9, "#00ff55"],
  [9, 10, "#00ffaa"],
  [1, 11, "#00ffff"],
  [11, 12, "#00aaff"],
  [12, 13, "#0055ff"],
  [1, 0, "#0000ff"],
  [0, 14, "#5500ff"],
  [14, 16, "#aa00ff"],
  [0, 15, "#ff00ff"],
  [15, 17, "#ff00aa"],
];

export const MEDIA_POSE_JOINT_LABELS = [
  "Nose",
  "Neck",
  "Right shoulder",
  "Right elbow",
  "Right wrist",
  "Left shoulder",
  "Left elbow",
  "Left wrist",
  "Right hip",
  "Right knee",
  "Right ankle",
  "Left hip",
  "Left knee",
  "Left ankle",
  "Right eye",
  "Left eye",
  "Right ear",
  "Left ear",
] as const;

export function mediaPoseJoints(pose: MediaPoseKind): MediaPoseJoint[] {
  const points = standingJoints.map(([x, y]) => ({ x, y }));
  if (pose === "sitting") {
    points[9] = { x: 0.68, y: 0.57 };
    points[10] = { x: 0.68, y: 0.88 };
    points[12] = { x: 0.82, y: 0.58 };
    points[13] = { x: 0.82, y: 0.88 };
  } else if (pose === "walking") {
    points[3] = { x: 0.31, y: 0.39 };
    points[4] = { x: 0.22, y: 0.49 };
    points[6] = { x: 0.7, y: 0.4 };
    points[7] = { x: 0.77, y: 0.53 };
    points[9] = { x: 0.34, y: 0.72 };
    points[10] = { x: 0.2, y: 0.94 };
    points[12] = { x: 0.66, y: 0.73 };
    points[13] = { x: 0.81, y: 0.97 };
  } else if (pose === "waving") {
    points[6] = { x: 0.67, y: 0.15 };
    points[7] = { x: 0.66, y: 0.02 };
  } else if (pose === "arms-up") {
    points[3] = { x: 0.31, y: 0.16 };
    points[4] = { x: 0.27, y: 0.02 };
    points[6] = { x: 0.69, y: 0.16 };
    points[7] = { x: 0.73, y: 0.02 };
  } else if (pose === "climbing") {
    points[0] = { x: 0.56, y: 0.11 };
    points[1] = { x: 0.52, y: 0.24 };
    points[2] = { x: 0.42, y: 0.28 };
    points[3] = { x: 0.26, y: 0.17 };
    points[4] = { x: 0.16, y: 0.05 };
    points[5] = { x: 0.61, y: 0.25 };
    points[6] = { x: 0.72, y: 0.12 };
    points[7] = { x: 0.78, y: 0.02 };
    points[8] = { x: 0.44, y: 0.55 };
    points[9] = { x: 0.29, y: 0.47 };
    points[10] = { x: 0.18, y: 0.63 };
    points[11] = { x: 0.57, y: 0.56 };
    points[12] = { x: 0.73, y: 0.74 };
    points[13] = { x: 0.68, y: 0.94 };
    points[14] = { x: 0.53, y: 0.09 };
    points[15] = { x: 0.59, y: 0.09 };
    points[16] = { x: 0.49, y: 0.11 };
    points[17] = { x: 0.63, y: 0.1 };
  }
  return points;
}

export function isMediaPoseMap(value: unknown): value is MediaPoseMap {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const map = value as Record<string, unknown>;
  if (
    !["1:1", "4:5", "16:9", "9:16"].includes(String(map.aspectRatio)) ||
    !Array.isArray(map.people) ||
    map.people.length < 1 ||
    map.people.length > 4 ||
    Object.keys(map).some((key) => !["aspectRatio", "people"].includes(key))
  )
    return false;
  return map.people.every((value: unknown) => {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      return false;
    const person = value as Record<string, unknown>;
    return (
      Object.keys(person).every((key) =>
        ["pose", "x", "y", "scale", "mirror", "joints"].includes(key),
      ) &&
      [
        "standing",
        "sitting",
        "walking",
        "waving",
        "arms-up",
        "climbing",
      ].includes(String(person.pose)) &&
      typeof person.mirror === "boolean" &&
      typeof person.x === "number" &&
      Number.isFinite(person.x) &&
      person.x >= 0.1 &&
      person.x <= 0.9 &&
      typeof person.y === "number" &&
      Number.isFinite(person.y) &&
      person.y >= 0.35 &&
      person.y <= 1 &&
      typeof person.scale === "number" &&
      Number.isFinite(person.scale) &&
      person.scale >= 0.2 &&
      person.scale <= 0.9 &&
      (person.joints === undefined ||
        (Array.isArray(person.joints) &&
          person.joints.length === 18 &&
          person.joints.every((joint: unknown) => {
            if (
              typeof joint !== "object" ||
              joint === null ||
              Array.isArray(joint)
            )
              return false;
            const point = joint as Record<string, unknown>;
            return (
              Object.keys(point).length === 2 &&
              typeof point.x === "number" &&
              Number.isFinite(point.x) &&
              point.x >= 0 &&
              point.x <= 1 &&
              typeof point.y === "number" &&
              Number.isFinite(point.y) &&
              point.y >= 0 &&
              point.y <= 1
            );
          })))
    );
  });
}

export function renderMediaPoseSvg(map: MediaPoseMap): string {
  const [ratioWidth, ratioHeight] = map.aspectRatio.split(":").map(Number);
  const width = (1000 * ratioWidth!) / ratioHeight!;
  const people = map.people
    .map((person) => {
      const points = (person.joints ?? mediaPoseJoints(person.pose)).map(
        (point) => ({
          x:
            person.x * width +
            (person.mirror ? 0.5 - point.x : point.x - 0.5) *
              person.scale *
              550,
          y: (person.y + (point.y - 1) * person.scale) * 1000,
        }),
      );
      const radius = Math.max(3, person.scale * 8);
      return [
        ...MEDIA_POSE_BONES.map(
          ([start, end, color]) =>
            `<line x1="${points[start]!.x}" y1="${points[start]!.y}" x2="${points[end]!.x}" y2="${points[end]!.y}" stroke="${color}" stroke-width="${radius * 2}" stroke-linecap="round"/>`,
        ),
        ...points.map(
          (point) =>
            `<circle cx="${point.x}" cy="${point.y}" r="${radius * 1.2}" fill="#ffffff"/>`,
        ),
      ].join("");
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(width)}" height="1000" viewBox="0 0 ${width} 1000"><rect width="100%" height="100%" fill="#000000"/>${people}</svg>`;
}
