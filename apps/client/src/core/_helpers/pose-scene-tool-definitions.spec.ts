import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  mediaPoseJoints,
  renderMediaPoseSvg,
  type MediaPoseMap,
} from "@machdoch/media-studio/core/media/contracts.js";
import type {
  AgentToolExecutionContext,
  ConversationMemoryRuntime,
} from "./agent-tools-shared.js";
import { createPoseSceneToolDefinitions } from "./pose-scene-tool-definitions.js";

const directories: string[] = [];
afterEach(async () => {
  delete process.env.MACHDOCH_USER_CONFIG_DIR;
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("pose scene tools", () => {
  it("starts with the chat scene, adjusts joints and characters, and persists the map", async () => {
    const directory = await mkdtemp(join(tmpdir(), "machdoch-pose-scene-"));
    directories.push(directory);
    process.env.MACHDOCH_USER_CONFIG_DIR = directory;
    const sessionId = randomUUID();
    const initial: MediaPoseMap = {
      aspectRatio: "4:5",
      people: [
        { pose: "standing", x: 0.5, y: 0.92, scale: 0.8, mirror: false },
      ],
    };
    const memory: ConversationMemoryRuntime = {
      sourceSessionId: sessionId,
      poseScene: initial,
      sessionEnabled: false,
      sessionEntries: [],
      globalEnabled: false,
      globalEntries: [],
    };
    const tools = new Map(
      createPoseSceneToolDefinitions(memory).map((tool) => [
        tool.spec.name,
        tool,
      ]),
    );
    const context: AgentToolExecutionContext = {
      workspaceRoot: directory,
      memory,
    };
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await tools.get(name)!.execute(args, context);
      expect(result.toolResult.isError).not.toBe(true);
      return JSON.parse(result.toolResult.output) as {
        map: MediaPoseMap;
        joints?: string[];
      };
    };

    expect((await call("pose_scene_get")).map).toEqual(initial);
    const equivalent: MediaPoseMap = {
      people: [
        { mirror: false, scale: 0.8, y: 0.92, x: 0.5, pose: "standing" },
      ],
      aspectRatio: "4:5",
    };
    expect((await call("pose_scene_replace", { map: equivalent })).map).toEqual(
      initial,
    );
    expect(memory.poseSceneSaved).toBe(false);
    expect(
      (
        await call("pose_joint_set", {
          personIndex: 0,
          jointIndex: 4,
          x: 0.48,
          y: 0.4,
        })
      ).map.people[0]?.joints?.[4],
    ).toEqual({ x: 0.48, y: 0.4 });
    const added = await call("pose_person_add", {
      person: { pose: "walking", x: 0.7, y: 0.92, scale: 0.8, mirror: false },
    });
    expect(added.map.people).toHaveLength(2);
    expect(memory.poseSceneSaved).toBe(true);
    expect(memory.poseScene?.people).toHaveLength(2);
    expect(
      (await call("pose_person_update", { personIndex: 1, x: 0.65 })).map
        .people[1]?.x,
    ).toBe(0.65);
    expect(
      (await call("pose_person_remove", { personIndex: 0 })).map.people,
    ).toHaveLength(1);
    expect((await call("pose_scene_get")).map.people[0]?.pose).toBe("walking");
    expect(
      await readFile(
        join(directory, "pose-scenes", `${sessionId}.json`),
        "utf8",
      ),
    ).toContain("walking");
    expect(renderMediaPoseSvg(added.map)).toContain("<svg");
    await call("pose_scene_replace", { map: initial });
    expect(memory.poseSceneSaved).toBe(false);
  });

  it("rejects invalid scenes and exposes a fresh scene in an empty pose chat", async () => {
    const directory = await mkdtemp(join(tmpdir(), "machdoch-pose-scene-"));
    directories.push(directory);
    process.env.MACHDOCH_USER_CONFIG_DIR = directory;
    const memory: ConversationMemoryRuntime = {
      sourceSessionId: randomUUID(),
      poseScene: undefined,
      sessionEnabled: false,
      sessionEntries: [],
      globalEnabled: false,
      globalEntries: [],
    };
    const tools = new Map(
      createPoseSceneToolDefinitions(memory).map((tool) => [
        tool.spec.name,
        tool,
      ]),
    );
    const context: AgentToolExecutionContext = {
      workspaceRoot: directory,
      memory,
    };
    expect(
      JSON.parse(
        (await tools.get("pose_scene_get")!.execute({}, context)).toolResult
          .output,
      ).map,
    ).toBeNull();
    const bad = await tools
      .get("pose_scene_replace")!
      .execute(
        { map: { aspectRatio: "1:1", people: [{ pose: "standing", x: 0.5 }] } },
        context,
      );
    expect(bad.toolResult.isError).toBe(true);
    const good = await tools.get("pose_scene_replace")!.execute(
      {
        map: {
          aspectRatio: "1:1",
          people: [
            {
              pose: "standing",
              x: 0.5,
              y: 0.92,
              scale: 0.8,
              mirror: false,
              joints: mediaPoseJoints("standing"),
            },
          ],
        },
      },
      context,
    );
    expect(good.toolResult.isError).not.toBe(true);
  });
});
