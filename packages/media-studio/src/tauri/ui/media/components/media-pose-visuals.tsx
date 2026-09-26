import type { JSX, PointerEvent } from "react";
import {
  MEDIA_POSE_BONES,
  MEDIA_POSE_JOINT_LABELS,
  mediaPoseJoints,
  type MediaPoseMap,
  type MediaPosePerson,
} from "../../../../core/media/pose-map.js";
export function PoseDrawing({
  person,
  width,
  selected,
  editing,
  activeJoint,
  dimmed,
  onJointPointerDown,
}: {
  person: MediaPosePerson;
  width: number;
  selected?: boolean;
  editing?: boolean;
  activeJoint?: number | null;
  dimmed?: boolean;
  onJointPointerDown?: (
    index: number,
    event: PointerEvent<SVGCircleElement>,
  ) => void;
}): JSX.Element {
  const points = (person.joints ?? mediaPoseJoints(person.pose)).map(
    (point) => ({
      x:
        person.x * width +
        (person.mirror ? 0.5 - point.x : point.x - 0.5) * person.scale * 550,
      y: (person.y + (point.y - 1) * person.scale) * 1000,
    }),
  );
  const radius = Math.max(3, person.scale * 8);
  return (
    <g opacity={dimmed ? 0.35 : 1}>
      {selected ? (
        <rect
          x={person.x * width - person.scale * 310}
          y={(person.y - person.scale) * 1000 - 15}
          width={person.scale * 620}
          height={person.scale * 1000 + 30}
          rx="18"
          fill="none"
          stroke="#7dd3fc"
          strokeWidth="5"
          strokeDasharray="12 10"
          pointerEvents="none"
        />
      ) : null}
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
      {points.map((point, index) => (
        <circle
          key={index}
          cx={point.x}
          cy={point.y}
          r={
            editing ? radius * (activeJoint === index ? 2.7 : 2) : radius * 1.2
          }
          fill={
            activeJoint === index && editing
              ? "#facc15"
              : editing
                ? "#f8fafc"
                : selected
                  ? "#7dd3fc"
                  : "#818cf8"
          }
          onPointerDown={
            editing ? (event) => onJointPointerDown?.(index, event) : undefined
          }
          className={editing ? "cursor-move" : undefined}
        >
          {editing ? <title>{MEDIA_POSE_JOINT_LABELS[index]}</title> : null}
        </circle>
      ))}
    </g>
  );
}

export function PosePreview({
  people,
  aspectRatio = "1:1",
  className = "h-20 w-full rounded bg-black",
}: {
  people: readonly MediaPosePerson[];
  aspectRatio?: MediaPoseMap["aspectRatio"];
  className?: string;
}): JSX.Element {
  const [ratioWidth, ratioHeight] = aspectRatio.split(":").map(Number);
  const width = (1000 * ratioWidth!) / ratioHeight!;
  return (
    <svg viewBox={`0 0 ${width} 1000`} aria-hidden="true" className={className}>
      {people.map((person, index) => (
        <PoseDrawing key={index} person={person} width={width} />
      ))}
    </svg>
  );
}
