import { useRef, useState, type JSX, type PointerEvent } from "react";
import {
  MEDIA_POSE_BONES,
  mediaPoseJoints,
  type MediaPoseJoint,
  type MediaPoseMap,
} from "@machdoch/media-studio/core/media/contracts.js";

type Drag = {
  personIndex: number;
  jointIndex?: number;
  offsetX: number;
  offsetY: number;
  moved: boolean;
};

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

export function PoseSceneCanvas({
  scene,
  onChange,
  onCommit,
}: {
  scene: MediaPoseMap;
  onChange: (scene: MediaPoseMap) => void;
  onCommit: (scene: MediaPoseMap) => void;
}): JSX.Element {
  const [selected, setSelected] = useState<number | null>(null);
  const [editing, setEditing] = useState(false);
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<Drag | null>(null);
  const latestScene = useRef(scene);
  latestScene.current = scene;
  const [ratioWidth, ratioHeight] = scene.aspectRatio.split(":").map(Number);
  const width = (1000 * ratioWidth!) / ratioHeight!;

  const pointerPosition = (
    event: PointerEvent<SVGSVGElement>,
  ): { x: number; y: number } => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: ((event.clientX - bounds.left) / bounds.width) * width,
      y: ((event.clientY - bounds.top) / bounds.height) * 1000,
    };
  };

  const movePointer = (event: PointerEvent<SVGSVGElement>): void => {
    const active = drag.current;
    if (!active) return;
    if (!event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.setPointerCapture(event.pointerId);
    active.moved = true;
    const current = latestScene.current;
    const person = current.people[active.personIndex];
    if (!person) return;
    const position = pointerPosition(event);
    const people = [...current.people];
    if (active.jointIndex === undefined) {
      people[active.personIndex] = {
        ...person,
        x:
          Math.round(
            clamp((position.x - active.offsetX) / width, 0.1, 0.9) * 1000,
          ) / 1000,
        y:
          Math.round(
            clamp((position.y - active.offsetY) / 1000, 0.35, 1) * 1000,
          ) / 1000,
      };
    } else {
      const joints: MediaPoseJoint[] = (
        person.joints ?? mediaPoseJoints(person.pose)
      ).map((joint) => ({ ...joint }));
      joints[active.jointIndex] = {
        x:
          Math.round(
            clamp(
              0.5 +
                ((position.x - person.x * width) / (person.scale * 550)) *
                  (person.mirror ? -1 : 1),
              0,
              1,
            ) * 1000,
          ) / 1000,
        y:
          Math.round(
            clamp(1 + (position.y / 1000 - person.y) / person.scale, 0, 1) *
              1000,
          ) / 1000,
      };
      people[active.personIndex] = { ...person, joints };
    }
    const next = { ...current, people };
    latestScene.current = next;
    onChange(next);
  };

  const finishDrag = (): void => {
    const active = drag.current;
    if (!active) return;
    drag.current = null;
    if (active.moved) onCommit(latestScene.current);
  };

  return (
    <div className="flex w-full flex-col items-center gap-3">
      <svg
        ref={svgRef}
        role="img"
        aria-label="Editable pose scene"
        viewBox={`0 0 ${width} 1000`}
        width={Math.round(width)}
        height={1000}
        className="block max-h-[55vh] w-auto max-w-full rounded bg-black touch-none"
        style={{ aspectRatio: `${width} / 1000` }}
        onPointerMove={movePointer}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
      >
        {scene.people.map((person, personIndex) => {
          const points = (person.joints ?? mediaPoseJoints(person.pose)).map(
            (joint) => ({
              x:
                person.x * width +
                (person.mirror ? 0.5 - joint.x : joint.x - 0.5) *
                  person.scale *
                  550,
              y: (person.y + (joint.y - 1) * person.scale) * 1000,
            }),
          );
          const radius = Math.max(3, person.scale * 8);
          const isEditing = selected === personIndex && editing;
          return (
            <g
              key={personIndex}
              role="button"
              aria-label={`Figure ${personIndex + 1}`}
              tabIndex={0}
              className={isEditing ? "cursor-default" : "cursor-grab"}
              onClick={() => setSelected(personIndex)}
              onDoubleClick={() => {
                setSelected(personIndex);
                setEditing(true);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  setSelected(personIndex);
                  setEditing(true);
                }
              }}
              onPointerDown={(event) => {
                if (
                  isEditing &&
                  event.target instanceof SVGElement &&
                  event.target.tagName.toLowerCase() === "circle"
                )
                  return;
                const bounds = svgRef.current!.getBoundingClientRect();
                const x =
                  ((event.clientX - bounds.left) / bounds.width) * width;
                const y = ((event.clientY - bounds.top) / bounds.height) * 1000;
                drag.current = {
                  personIndex,
                  offsetX: x - person.x * width,
                  offsetY: y - person.y * 1000,
                  moved: false,
                };
                setSelected(personIndex);
                if (selected !== personIndex) setEditing(false);
              }}
            >
              {MEDIA_POSE_BONES.map(([start, end, color]) => (
                <line
                  key={`${start}-${end}`}
                  x1={points[start]!.x}
                  y1={points[start]!.y}
                  x2={points[end]!.x}
                  y2={points[end]!.y}
                  stroke={color}
                  strokeWidth={radius * 2}
                  strokeLinecap="round"
                />
              ))}
              {points.map((point, jointIndex) => (
                <circle
                  key={jointIndex}
                  cx={point.x}
                  cy={point.y}
                  r={isEditing ? radius * 2 : radius * 1.2}
                  fill={
                    isEditing
                      ? "#fff"
                      : selected === personIndex
                        ? "#7dd3fc"
                        : "#fff"
                  }
                  className={isEditing ? "cursor-move" : undefined}
                  onPointerDown={
                    isEditing
                      ? (event) => {
                          event.stopPropagation();
                          drag.current = {
                            personIndex,
                            jointIndex,
                            offsetX: 0,
                            offsetY: 0,
                            moved: false,
                          };
                          svgRef.current?.setPointerCapture(event.pointerId);
                        }
                      : undefined
                  }
                />
              ))}
            </g>
          );
        })}
      </svg>
      {selected !== null && scene.people[selected] ? (
        <div className="flex items-center gap-2 text-xs text-slate-200">
          <span>Figure {selected + 1}</span>
          <button
            type="button"
            onClick={() => setEditing(!editing)}
            className="rounded border border-slate-600 px-2 py-1 text-sky-300"
          >
            {editing ? "Done" : "Edit joints"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
