import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { getUserConfigPath } from "../env.js";
import { writeFileAtomically } from "./write-file-atomically.helper.js";
import { withCooperativeFileLock } from "./with-cooperative-file-lock.helper.js";
import {
  isMediaPoseMap,
  mediaPoseJoints,
  type MediaPoseJoint,
  type MediaPoseKind,
  type MediaPoseMap,
  type MediaPosePerson,
} from "@machdoch/media-studio/core/media/contracts.js";
import {
  createToolErrorResult,
  type AgentToolDefinition,
  type ConversationMemoryRuntime,
} from "./agent-tools-shared.js";

const jointNames = [
  "nose",
  "neck",
  "right shoulder",
  "right elbow",
  "right wrist",
  "left shoulder",
  "left elbow",
  "left wrist",
  "right hip",
  "right knee",
  "right ankle",
  "left hip",
  "left knee",
  "left ankle",
  "right eye",
  "left eye",
  "right ear",
  "left ear",
];

const scenePath = (sessionId: string): string => {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(sessionId)) {
    throw new Error("The pose chat has an invalid session id.");
  }
  return join(dirname(getUserConfigPath()), "pose-scenes", `${sessionId}.json`);
};

const readScene = async (
  memory: ConversationMemoryRuntime,
): Promise<MediaPoseMap | null> => {
  const path = scenePath(memory.sourceSessionId!);
  let scene: MediaPoseMap | null;
  try {
    const stored: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isMediaPoseMap(stored))
      throw new Error("The saved pose scene is invalid.");
    scene = stored;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    scene =
      memory.poseScene && isMediaPoseMap(memory.poseScene)
        ? memory.poseScene
        : null;
  }
  if (!Object.hasOwn(memory, "poseSceneOriginal"))
    memory.poseSceneOriginal = scene;
  return scene;
};

const saveScene = async (
  memory: ConversationMemoryRuntime,
  map: MediaPoseMap,
): Promise<{ map: MediaPoseMap }> => {
  const path = scenePath(memory.sourceSessionId!);
  await writeFileAtomically(path, JSON.stringify(map), "utf8", { mode: 0o600 });
  memory.poseScene = map;
  memory.poseSceneSaved = !isDeepStrictEqual(map, memory.poseSceneOriginal);
  return { map };
};

const poseTool = (
  name: string,
  description: string,
  effect: "read" | "write",
  properties: Record<string, unknown>,
  required: string[],
  memory: ConversationMemoryRuntime,
  run: (
    args: Record<string, unknown>,
    scene: MediaPoseMap | null,
  ) => MediaPoseMap | null,
): AgentToolDefinition => ({
  spec: {
    name,
    description,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties,
      required,
    },
  },
  backingTool: "utilities",
  riskLevel: effect === "read" ? "low" : "medium",
  effect,
  execute: async (args) => {
    try {
      const path = scenePath(memory.sourceSessionId!);
      const result = await withCooperativeFileLock(path, async () => {
        const map = run(args, await readScene(memory));
        if (!map) return { map: null, joints: jointNames };
        if (!isMediaPoseMap(map))
          throw new Error(
            "A pose scene needs one to four valid people with 18 valid joints per custom pose.",
          );
        return effect === "write"
          ? saveScene(memory, map)
          : { map, joints: jointNames };
      });
      return {
        toolResult: { callId: "", name, output: JSON.stringify(result) },
        sections: [],
        traceLines: [name],
      };
    } catch (error) {
      return createToolErrorResult(
        "",
        name,
        error instanceof Error ? error.message : String(error),
      );
    }
  },
});

export const createPoseSceneToolDefinitions = (
  memory: ConversationMemoryRuntime,
): AgentToolDefinition[] => {
  if (!memory.sourceSessionId || !Object.hasOwn(memory, "poseScene")) return [];
  const pointSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      x: { type: "number", minimum: 0, maximum: 1 },
      y: { type: "number", minimum: 0, maximum: 1 },
    },
    required: ["x", "y"],
  };
  const personSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      pose: {
        type: "string",
        enum: ["standing", "sitting", "walking", "waving", "arms-up", "climbing"],
      },
      x: { type: "number", minimum: 0.1, maximum: 0.9 },
      y: { type: "number", minimum: 0.35, maximum: 1 },
      scale: { type: "number", minimum: 0.2, maximum: 0.9 },
      mirror: { type: "boolean" },
      joints: {
        type: "array",
        minItems: 18,
        maxItems: 18,
        items: pointSchema,
        description: "OpenPose joints in the order returned by pose_scene_get.",
      },
    },
    required: ["pose", "x", "y", "scale", "mirror"],
  };
  const mapSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      aspectRatio: { type: "string", enum: ["1:1", "4:5", "16:9", "9:16"] },
      people: { type: "array", minItems: 1, maxItems: 4, items: personSchema },
    },
    required: ["aspectRatio", "people"],
  };
  const indexSchema = { type: "integer", minimum: 0, maximum: 3 };
  const coordinateSchema = { type: "number", minimum: 0, maximum: 1 };
  return [
    poseTool(
      "pose_scene_get",
      "Read the current pose scene and its joint order.",
      "read",
      {},
      [],
      memory,
      (_args, scene) => scene,
    ),
    poseTool(
      "pose_scene_replace",
      "Create or replace a scene of one to four characters. Choose a base pose that matches the requested action, including climbing, or provide distinct custom joints for each character. Use custom joints to reconstruct a reference image.",
      "write",
      { map: mapSchema },
      ["map"],
      memory,
      (args) => {
        if (!isMediaPoseMap(args.map))
          throw new Error("The pose map is invalid.");
        return args.map;
      },
    ),
    poseTool(
      "pose_person_add",
      "Add a character to the scene.",
      "write",
      {
        person: personSchema,
        aspectRatio: { type: "string", enum: ["1:1", "4:5", "16:9", "9:16"] },
      },
      ["person"],
      memory,
      (args, scene) => {
        const map: MediaPoseMap = {
          aspectRatio:
            scene?.aspectRatio ??
            (args.aspectRatio as MediaPoseMap["aspectRatio"] | undefined) ??
            "1:1",
          people: [...(scene?.people ?? []), args.person as MediaPosePerson],
        };
        if (!isMediaPoseMap(map))
          throw new Error("The character or scene is invalid.");
        return map;
      },
    ),
    poseTool(
      "pose_person_update",
      "Move, resize, mirror, or change a character's base pose.",
      "write",
      {
        personIndex: indexSchema,
        x: { type: "number", minimum: 0.1, maximum: 0.9 },
        y: { type: "number", minimum: 0.35, maximum: 1 },
        scale: { type: "number", minimum: 0.2, maximum: 0.9 },
        mirror: { type: "boolean" },
        pose: {
          type: "string",
          enum: ["standing", "sitting", "walking", "waving", "arms-up", "climbing"],
        },
      },
      ["personIndex"],
      memory,
      (args, scene) => {
        if (!scene?.people[args.personIndex as number])
          throw new Error("Choose an existing character index.");
        const people = scene.people.map((person, index) => {
          if (index !== args.personIndex) return person;
          const updated: MediaPosePerson = {
            ...person,
            ...(args.x !== undefined ? { x: args.x as number } : {}),
            ...(args.y !== undefined ? { y: args.y as number } : {}),
            ...(args.scale !== undefined
              ? { scale: args.scale as number }
              : {}),
            ...(args.mirror !== undefined
              ? { mirror: args.mirror as boolean }
              : {}),
            ...(args.pose !== undefined
              ? { pose: args.pose as MediaPoseKind }
              : {}),
          };
          if (args.pose !== undefined) delete updated.joints;
          return updated;
        });
        return { ...scene, people };
      },
    ),
    poseTool(
      "pose_joint_set",
      "Move one body joint on one character. Joint positions are normalized within the person.",
      "write",
      {
        personIndex: indexSchema,
        jointIndex: { type: "integer", minimum: 0, maximum: 17 },
        x: coordinateSchema,
        y: coordinateSchema,
      },
      ["personIndex", "jointIndex", "x", "y"],
      memory,
      (args, scene) => {
        const personIndex = args.personIndex as number;
        const person = scene?.people[personIndex];
        if (!scene || !person)
          throw new Error("Choose an existing character index.");
        const joints: MediaPoseJoint[] = (
          person.joints ?? mediaPoseJoints(person.pose)
        ).map((joint) => ({ ...joint }));
        joints[args.jointIndex as number] = {
          x: args.x as number,
          y: args.y as number,
        };
        return {
          ...scene,
          people: scene.people.map((entry, index) =>
            index === personIndex ? { ...entry, joints } : entry,
          ),
        };
      },
    ),
    poseTool(
      "pose_person_remove",
      "Remove a character from a scene with at least two characters.",
      "write",
      { personIndex: indexSchema },
      ["personIndex"],
      memory,
      (args, scene) => {
        if (!scene?.people[args.personIndex as number])
          throw new Error("Choose an existing character index.");
        return {
          ...scene,
          people: scene.people.filter((_, index) => index !== args.personIndex),
        };
      },
    ),
  ];
};
