import { invoke, isTauri } from "@tauri-apps/api/core";
import { PoseDrawing } from "./media-pose-visuals.js";
import { MediaPoseLibrary } from "./media-pose-library.js";
import {
  STORAGE_KEY,
  addPeopleToScene,
  arrangePeople,
  clamp,
  copyName,
  copyPeople,
  readTemplates,
  type Guidance,
  type PoseTemplate,
} from "./media-pose-templates.js";
import {
  useEffect,
  useRef,
  useState,
  type JSX,
  type PointerEvent,
  type ReactNode,
} from "react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "../../components/ui/dialog.js";
import {
  MEDIA_POSE_PRESETS,
  MEDIA_POSE_JOINT_LABELS,
  isMediaPoseMap,
  mediaPoseJoints,
  type MediaPoseJoint,
  type MediaPoseMap,
  type MediaPosePerson,
  type MediaSavedPoseScene,
} from "../../../../core/media/pose-map.js";

type Drag = {
  person: number;
  joint?: number;
  offsetX: number;
  offsetY: number;
};

interface MediaPoseWorkspaceProps {
  aspectRatio: MediaPoseMap["aspectRatio"];
  disabled?: boolean;
  externalPoseSelected?: boolean;
  appliedPreview?: ReactNode;
  onRemoveApplied?: () => void;
  savedScenes?: readonly MediaSavedPoseScene[];
  onRenamePoseScene?: (id: string, title: string) => void;
  onLoadScene?: (scene: MediaPoseMap, guidance?: Guidance) => void;
  guidance?: Guidance;
  onGuidanceChange?: (guidance: Guidance) => void;
  onGenerate: (map: MediaPoseMap | null) => void | Promise<void>;
  onApply: (map: MediaPoseMap) => void | Promise<void>;
}

const EMPTY_SAVED_SCENES: readonly MediaSavedPoseScene[] = [];
export function MediaPoseWorkspace({
  aspectRatio,
  disabled = false,
  externalPoseSelected = false,
  appliedPreview,
  onRemoveApplied,
  savedScenes = EMPTY_SAVED_SCENES,
  onRenamePoseScene,
  onLoadScene,
  guidance,
  onGuidanceChange,
  onGenerate,
  onApply,
}: MediaPoseWorkspaceProps): JSX.Element {
  const [templates, setTemplates] = useState(readTemplates);
  const [resolvedScenes, setResolvedScenes] = useState(() =>
    savedScenes.filter(
      (scene): scene is MediaSavedPoseScene & { map: MediaPoseMap } =>
        isMediaPoseMap(scene.map),
    ),
  );
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [sceneAspectRatio, setSceneAspectRatio] = useState<
    MediaPoseMap["aspectRatio"] | null
  >(null);
  const [people, setPeople] = useState<MediaPosePerson[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [selectedJoint, setSelectedJoint] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const [focusSelected, setFocusSelected] = useState(false);
  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(
    null,
  );
  const [name, setName] = useState("");
  const [naming, setNaming] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [localGuidance, setLocalGuidance] = useState<Guidance>({
    strength: 1,
    start: 0,
    end: 1,
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<Drag | null>(null);
  const ignoreCanvasClick = useRef(false);
  useEffect(() => setSceneAspectRatio(null), [aspectRatio]);
  useEffect(() => setSelectedJoint(null), [editing, selected]);
  const currentAspectRatio = sceneAspectRatio ?? aspectRatio;
  const [ratioWidth, ratioHeight] = currentAspectRatio.split(":").map(Number);
  const width = (1000 * ratioWidth!) / ratioHeight!;
  const control = guidance ?? localGuidance;
  const map: MediaPoseMap = {
    aspectRatio: currentAspectRatio,
    people: copyPeople(people),
  };
  const activeJoint =
    selected !== null && selectedJoint !== null && people[selected]
      ? (people[selected].joints ?? mediaPoseJoints(people[selected].pose))[
          selectedJoint
        ]
      : null;
  useEffect(() => {
    if (!isTauri()) {
      setResolvedScenes(
        savedScenes.filter(
          (scene): scene is MediaSavedPoseScene & { map: MediaPoseMap } =>
            isMediaPoseMap(scene.map),
        ),
      );
      return;
    }
    let active = true;
    void Promise.allSettled(
      savedScenes.map(async (scene) => {
        const map = await invoke<unknown>("media_read_pose_scene", {
          sessionId: scene.id,
        });
        if (map === null) return null;
        if (!isMediaPoseMap(map))
          throw new Error("A saved pose scene is invalid.");
        return { ...scene, map };
      }),
    ).then((results) => {
      if (!active) return;
      setResolvedScenes(
        results.flatMap((result) =>
          result.status === "fulfilled" && result.value ? [result.value] : [],
        ),
      );
      const failure = results.find((result) => result.status === "rejected");
      setLibraryError(
        failure?.status === "rejected" ? String(failure.reason) : null,
      );
    });
    return () => {
      active = false;
    };
  }, [savedScenes]);
  const availableTemplates: PoseTemplate[] = [
    ...MEDIA_POSE_PRESETS,
    ...templates,
  ];

  const loadScene = (
    scene: MediaSavedPoseScene & { map: MediaPoseMap },
  ): void => {
    setPeople(copyPeople(scene.map.people));
    setSelected(0);
    setEditing(0);
    setFocusSelected(false);
    setEditingTemplateId(null);
    setName(copyName(scene.label, templates));
    setNaming(true);
    setRenaming(false);
    setSceneAspectRatio(scene.map.aspectRatio);
    onLoadScene?.(scene.map);
  };

  const duplicateTemplate = (template: PoseTemplate): void => {
    try {
      persist([
        ...templates,
        {
          ...template,
          id: crypto.randomUUID(),
          label: copyName(template.label, templates),
          people: copyPeople(template.people),
          ...(template.guidance ? { guidance: { ...template.guidance } } : {}),
        },
      ]);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const persist = (next: PoseTemplate[]): void => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    setTemplates(next);
  };
  const applyTemplateGuidance = (template: PoseTemplate): void => {
    if (!template.guidance) return;
    if (onGuidanceChange) onGuidanceChange(template.guidance);
    else setLocalGuidance(template.guidance);
  };
  const addTemplate = (template: PoseTemplate): void => {
    const additions = copyPeople(template.people);
    setPeople((current) => addPeopleToScene(current, additions));
    setSelected(people.length);
    setEditing(null);
    setFocusSelected(false);
    setEditingTemplateId(null);
    applyTemplateGuidance(template);
  };
  const editTemplate = (template: PoseTemplate, isDefault: boolean): void => {
    setPeople(copyPeople(template.people));
    setSelected(0);
    setEditing(0);
    setFocusSelected(false);
    setEditingTemplateId(isDefault ? null : template.id);
    if (template.aspectRatio) {
      setSceneAspectRatio(template.aspectRatio);
      onLoadScene?.(
        {
          aspectRatio: template.aspectRatio,
          people: copyPeople(template.people),
        },
        template.guidance,
      );
    }
    setName(isDefault ? copyName(template.label, templates) : template.label);
    setNaming(isDefault);
    setRenaming(false);
    if (!template.aspectRatio || !onLoadScene) applyTemplateGuidance(template);
  };
  const deleteTemplate = (template: PoseTemplate): void => {
    try {
      persist(templates.filter((item) => item.id !== template.id));
      if (editingTemplateId === template.id) {
        setEditingTemplateId(null);
        setNaming(false);
        setRenaming(false);
      }
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const updatePerson = (
    index: number,
    update: Partial<MediaPosePerson>,
  ): void => {
    setPeople((current) =>
      current.map((person, personIndex) =>
        personIndex === index ? { ...person, ...update } : person,
      ),
    );
  };
  const updateJoint = (index: number, axis: "x" | "y", value: number): void => {
    const person = people[index];
    if (!person || selectedJoint === null) return;
    const joints = (person.joints ?? mediaPoseJoints(person.pose)).map(
      (joint) => ({ ...joint }),
    );
    joints[selectedJoint] = { ...joints[selectedJoint]!, [axis]: value };
    updatePerson(index, { joints });
  };
  const run = async (action: () => void | Promise<void>): Promise<void> => {
    setPending(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  };
  const saveTemplate = (): void => {
    const label = name.trim();
    if (!label || people.length === 0) return;
    if (
      templates.some(
        (template) =>
          template.id !== (naming ? null : editingTemplateId) &&
          template.label.toLocaleLowerCase() === label.toLocaleLowerCase(),
      )
    ) {
      setError("A saved pose already uses this name.");
      return;
    }
    try {
      const template = {
        id: naming
          ? crypto.randomUUID()
          : (editingTemplateId ?? crypto.randomUUID()),
        label,
        people: copyPeople(people),
        aspectRatio: currentAspectRatio,
        guidance: { ...control },
      };
      persist(
        editingTemplateId && !naming
          ? templates.map((item) =>
              item.id === editingTemplateId ? template : item,
            )
          : [...templates, template],
      );
      setEditingTemplateId(template.id);
      setNaming(false);
      setRenaming(false);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const pointerPosition = (
    clientX: number,
    clientY: number,
  ): { x: number; y: number } | null => {
    const svg = svgRef.current;
    const transform = svg?.getScreenCTM();
    if (!svg || !transform) return null;
    const point = svg.createSVGPoint();
    point.x = clientX;
    point.y = clientY;
    const position = point.matrixTransform(transform.inverse());
    return { x: position.x, y: position.y };
  };
  const movePointer = (event: PointerEvent<SVGSVGElement>): void => {
    const active = drag.current;
    if (!active) return;
    if (!event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.setPointerCapture(event.pointerId);
    const position = pointerPosition(event.clientX, event.clientY);
    if (!position) return;
    const person = people[active.person];
    if (!person) return;
    if (active.joint === undefined) {
      updatePerson(active.person, {
        x:
          Math.round(
            clamp((position.x - active.offsetX) / width, 0.1, 0.9) * 1000,
          ) / 1000,
        y:
          Math.round(
            clamp((position.y - active.offsetY) / 1000, 0.35, 1) * 1000,
          ) / 1000,
      });
      return;
    }
    const joints: MediaPoseJoint[] = (
      person.joints ?? mediaPoseJoints(person.pose)
    ).map((joint) => ({ ...joint }));
    joints[active.joint] = {
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
          clamp(1 + (position.y / 1000 - person.y) / person.scale, 0, 1) * 1000,
        ) / 1000,
    };
    updatePerson(active.person, { joints });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-700 bg-slate-900/50 p-3">
        {appliedPreview ? (
          <div className="h-40 w-40 shrink-0 overflow-hidden rounded-md bg-black">
            {appliedPreview}
          </div>
        ) : null}
        <div className="min-w-0 flex-1 text-sm text-slate-200">
          {appliedPreview
            ? "Pose image selected"
            : people.length > 0
              ? `${people.length} ${people.length === 1 ? "figure" : "figures"} · Draft`
              : "No pose map"}
        </div>
        {appliedPreview && onRemoveApplied ? (
          <button
            type="button"
            onClick={onRemoveApplied}
            className="rounded-lg px-3 py-2 text-sm text-slate-300 hover:bg-slate-800"
          >
            Remove pose image
          </button>
        ) : null}
        <button
          type="button"
          disabled={disabled}
          onClick={() => setOpen(true)}
          className="rounded-lg border border-sky-700 px-4 py-2 text-sm font-medium text-sky-200 hover:bg-sky-900/30 disabled:opacity-40"
        >
          {people.length > 0 ? "Edit pose map" : "Create pose map"}
        </button>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="block max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-[1500px] space-y-4 overflow-y-auto p-5 sm:max-w-[1500px]">
          <DialogTitle>Pose map</DialogTitle>
          <MediaPoseLibrary
            templates={availableTemplates}
            savedScenes={resolvedScenes}
            peopleCount={people.length}
            disabled={disabled}
            pending={pending}
            onAdd={addTemplate}
            onEdit={editTemplate}
            onDuplicate={duplicateTemplate}
            onDelete={deleteTemplate}
            onEditScene={loadScene}
            onRenameScene={onRenamePoseScene}
            onDuplicateScene={(scene) =>
              duplicateTemplate({
                id: scene.id,
                label: scene.label,
                people: scene.map.people,
                aspectRatio: scene.map.aspectRatio,
              })
            }
          />
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(270px,330px)]">
            <div className="flex items-center justify-center rounded-xl border border-slate-700 bg-slate-950 p-3">
              <svg
                ref={svgRef}
                viewBox={`0 0 ${width} 1000`}
                aria-label="Pose canvas"
                role="img"
                className="mx-auto block max-h-[60dvh] w-full max-w-2xl rounded-lg border border-slate-700 bg-black touch-none"
                style={{ aspectRatio: `${width} / 1000` }}
                onClick={(event) => {
                  if (ignoreCanvasClick.current) {
                    ignoreCanvasClick.current = false;
                    return;
                  }
                  if (event.target === event.currentTarget) {
                    setSelected(null);
                    setEditing(null);
                    setFocusSelected(false);
                  }
                }}
                onPointerDown={(event) => {
                  if (event.target === event.currentTarget)
                    ignoreCanvasClick.current = false;
                }}
                onPointerMove={movePointer}
                onPointerUp={() => {
                  drag.current = null;
                }}
                onPointerCancel={() => {
                  drag.current = null;
                }}
              >
                {people.map(
                  (person, index) =>
                    (!focusSelected || selected === index) && (
                      <g
                        key={index}
                        role="button"
                        aria-label={`Pose ${index + 1}`}
                        tabIndex={0}
                        className={
                          editing === index ? "cursor-default" : "cursor-grab"
                        }
                        onClick={() => {
                          setSelected(index);
                          if (editing !== index) setEditing(null);
                        }}
                        onDoubleClick={() => {
                          setSelected(index);
                          setEditing(index);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            setSelected(index);
                            setEditing(null);
                          }
                        }}
                        onPointerDown={(event) => {
                          if (
                            disabled ||
                            (event.target instanceof SVGElement &&
                              event.target.tagName.toLowerCase() === "circle" &&
                              editing === index)
                          )
                            return;
                          const position = pointerPosition(
                            event.clientX,
                            event.clientY,
                          );
                          if (!position) return;
                          drag.current = {
                            person: index,
                            offsetX: position.x - person.x * width,
                            offsetY: position.y - person.y * 1000,
                          };
                          ignoreCanvasClick.current = true;
                          setSelected(index);
                        }}
                      >
                        <PoseDrawing
                          person={person}
                          width={width}
                          selected={selected === index}
                          editing={editing === index}
                          activeJoint={editing === index ? selectedJoint : null}
                          dimmed={selected !== null && selected !== index}
                          onJointPointerDown={(joint, event) => {
                            if (disabled) return;
                            event.stopPropagation();
                            setSelectedJoint(joint);
                            drag.current = {
                              person: index,
                              joint,
                              offsetX: 0,
                              offsetY: 0,
                            };
                            ignoreCanvasClick.current = true;
                            svgRef.current?.setPointerCapture(event.pointerId);
                            event.preventDefault();
                          }}
                        />
                      </g>
                    ),
                )}
              </svg>
            </div>
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-medium text-slate-200">Figures</h3>
                <div className="flex items-center gap-1">
                  {people.length > 1 ? (
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() =>
                        setPeople((current) => arrangePeople(current))
                      }
                      className="rounded-md px-2 py-1 text-sm text-slate-300 hover:bg-slate-800 disabled:opacity-40"
                    >
                      Arrange
                    </button>
                  ) : null}
                  {selected !== null ? (
                    <button
                      type="button"
                      onClick={() => {
                        setSelected(null);
                        setEditing(null);
                        setFocusSelected(false);
                      }}
                      className="rounded-md px-2 py-1 text-sm text-slate-300 hover:bg-slate-800"
                    >
                      Deselect
                    </button>
                  ) : null}
                </div>
              </div>
              {people.length > 0 ? (
                <div className="grid grid-cols-2 gap-2">
                  {people.map((person, index) => (
                    <button
                      key={index}
                      type="button"
                      aria-label={`Select pose ${index + 1}`}
                      aria-pressed={selected === index}
                      onClick={() => {
                        setSelected(index);
                        setEditing(null);
                      }}
                      className={`rounded-lg border px-3 py-2 text-left text-sm ${selected === index ? "border-sky-400 bg-sky-900/40 text-sky-100" : "border-slate-700 text-slate-300 hover:bg-slate-800"}`}
                    >
                      {index + 1}.{" "}
                      {person.pose.charAt(0).toUpperCase() +
                        person.pose.slice(1)}
                    </button>
                  ))}
                </div>
              ) : null}
              {selected !== null && people[selected] ? (
                <div className="space-y-3 rounded-lg border border-sky-800/70 bg-sky-950/20 p-3 text-sm text-slate-300">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-slate-200">
                      Pose {selected + 1}
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        setEditing(editing === selected ? null : selected)
                      }
                      aria-pressed={editing === selected}
                      className="rounded-md border border-slate-700 px-2.5 py-1.5 text-sky-300 hover:bg-slate-800"
                    >
                      {editing === selected ? "Done" : "Edit joints"}
                    </button>
                    <button
                      type="button"
                      aria-pressed={focusSelected}
                      onClick={() => setFocusSelected((current) => !current)}
                      className="rounded-md border border-slate-700 px-2.5 py-1.5 text-slate-200 hover:bg-slate-800"
                    >
                      {focusSelected ? "Show all" : "Focus"}
                    </button>
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() =>
                        updatePerson(selected, {
                          mirror: !people[selected]!.mirror,
                        })
                      }
                      className="rounded-md border border-slate-700 px-2.5 py-1.5 text-slate-200 hover:bg-slate-800 disabled:opacity-40"
                    >
                      Mirror
                    </button>
                    <button
                      type="button"
                      disabled={disabled || people.length >= 4}
                      onClick={() => {
                        const original = people[selected]!;
                        setPeople((current) => [
                          ...current,
                          {
                            ...copyPeople([original])[0]!,
                            x: clamp(original.x + 0.12, 0.1, 0.9),
                          },
                        ]);
                        setSelected(people.length);
                        setEditing(null);
                        setFocusSelected(false);
                      }}
                      className="rounded-md border border-slate-700 px-2.5 py-1.5 text-slate-200 hover:bg-slate-800 disabled:opacity-40"
                    >
                      Duplicate
                    </button>
                    {people[selected]!.joints ? (
                      <button
                        type="button"
                        disabled={disabled}
                        onClick={() =>
                          updatePerson(selected, { joints: undefined })
                        }
                        className="rounded-md border border-slate-700 px-2.5 py-1.5 text-slate-200 hover:bg-slate-800 disabled:opacity-40"
                      >
                        Reset joints
                      </button>
                    ) : null}
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => {
                        setPeople((current) =>
                          current.filter((_, index) => index !== selected),
                        );
                        setSelected(null);
                        setEditing(null);
                        setFocusSelected(false);
                      }}
                      className="rounded-md border border-slate-700 px-2.5 py-1.5 text-red-300 hover:bg-red-950/30 disabled:opacity-40"
                    >
                      Remove
                    </button>
                  </div>
                  <label className="flex items-center gap-2">
                    <span className="w-14">Size</span>
                    <input
                      aria-label="Pose size"
                      type="range"
                      disabled={disabled}
                      min="0.2"
                      max="0.9"
                      step="0.01"
                      value={people[selected]!.scale}
                      onChange={(event) =>
                        updatePerson(selected, {
                          scale: Number(event.target.value),
                        })
                      }
                      className="min-w-0 flex-1"
                    />
                  </label>
                  {editing === selected ? (
                    <div className="space-y-3 border-t border-sky-800/50 pt-3">
                      <select
                        aria-label="Joint"
                        value={selectedJoint ?? ""}
                        onChange={(event) =>
                          setSelectedJoint(Number(event.target.value))
                        }
                        className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100"
                      >
                        <option value="" disabled>
                          Choose joint
                        </option>
                        {MEDIA_POSE_JOINT_LABELS.map((label, index) => (
                          <option key={label} value={index}>
                            {label}
                          </option>
                        ))}
                      </select>
                      {activeJoint ? (
                        <>
                          {(["x", "y"] as const).map((axis) => (
                            <label
                              key={axis}
                              className="flex items-center gap-2"
                            >
                              <span className="w-20">
                                {axis === "x" ? "Horizontal" : "Vertical"}
                              </span>
                              <input
                                aria-label={`Joint ${axis === "x" ? "horizontal" : "vertical"}`}
                                type="range"
                                disabled={disabled}
                                min="0"
                                max="1"
                                step="0.01"
                                value={activeJoint[axis]}
                                onChange={(event) =>
                                  updateJoint(
                                    selected,
                                    axis,
                                    Number(event.target.value),
                                  )
                                }
                                className="min-w-0 flex-1"
                              />
                              <span className="w-9 text-right tabular-nums">
                                {activeJoint[axis].toFixed(2)}
                              </span>
                            </label>
                          ))}
                          <button
                            type="button"
                            disabled={disabled}
                            onClick={() => {
                              const person = people[selected]!;
                              const joints = (
                                person.joints ?? mediaPoseJoints(person.pose)
                              ).map((joint) => ({ ...joint }));
                              joints[selectedJoint!] = mediaPoseJoints(
                                person.pose,
                              )[selectedJoint!]!;
                              updatePerson(selected, { joints });
                            }}
                            className="rounded-md border border-slate-700 px-2.5 py-1.5 text-sm text-slate-200 hover:bg-slate-800 disabled:opacity-40"
                          >
                            Reset joint
                          </button>
                        </>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ) : null}
              {people.length > 0 || externalPoseSelected ? (
                <div className="space-y-3 text-sm text-slate-300">
                  <div className="font-medium text-slate-200">Map guidance</div>
                  {(
                    [
                      { label: "Strength", field: "strength", min: 0, max: 2 },
                      {
                        label: "Start",
                        field: "start",
                        min: 0,
                        max: Math.max(0, control.end - 0.01),
                      },
                      {
                        label: "End",
                        field: "end",
                        min: Math.min(1, control.start + 0.01),
                        max: 1,
                      },
                    ] as const
                  ).map((item) => (
                    <label key={item.field} className="flex items-center gap-2">
                      <span className="w-14">{item.label}</span>
                      <input
                        aria-label={`Map ${item.label}`}
                        type="range"
                        disabled={disabled}
                        min={item.min}
                        max={item.max}
                        step="0.01"
                        value={control[item.field]}
                        onChange={(event) => {
                          const next = {
                            ...control,
                            [item.field]: Number(event.target.value),
                          };
                          if (next.start >= next.end) return;
                          if (onGuidanceChange) onGuidanceChange(next);
                          else setLocalGuidance(next);
                        }}
                        className="min-w-0 flex-1"
                      />
                      <span className="w-8 text-right tabular-nums">
                        {control[item.field].toFixed(2)}
                      </span>
                    </label>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={disabled || pending || people.length === 0}
              onClick={() =>
                void run(async () => {
                  await onApply(map);
                  setOpen(false);
                })
              }
              className="rounded-md bg-sky-500 px-4 py-2 text-sm font-medium text-slate-950 hover:bg-sky-400 disabled:opacity-40"
            >
              Use pose map
            </button>
            <button
              type="button"
              disabled={disabled || pending}
              onClick={() =>
                void run(async () => {
                  await onGenerate(people.length ? map : null);
                  setOpen(false);
                })
              }
              className="rounded-md border border-sky-700 px-4 py-2 text-sm font-medium text-sky-200 hover:bg-sky-900/30 disabled:opacity-40"
            >
              Open in Pose chat
            </button>
            {people.length > 0 && !naming ? (
              <button
                type="button"
                disabled={disabled || pending}
                onClick={() => {
                  setName("");
                  setNaming(true);
                }}
                className="rounded-md border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:border-sky-500 disabled:opacity-40"
              >
                Save as new pose
              </button>
            ) : null}
            {editingTemplateId && !naming ? (
              <>
                {!renaming ? (
                  <button
                    type="button"
                    disabled={disabled || pending}
                    onClick={saveTemplate}
                    className="rounded-md border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:border-sky-500 disabled:opacity-40"
                  >
                    Save
                  </button>
                ) : null}
                {!renaming ? (
                  <button
                    type="button"
                    disabled={disabled || pending}
                    onClick={() => setRenaming(true)}
                    className="rounded-md border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:border-sky-500 disabled:opacity-40"
                  >
                    Rename
                  </button>
                ) : null}
              </>
            ) : null}
          </div>
          {naming || renaming ? (
            <div className="flex gap-2">
              <input
                aria-label="Pose name"
                autoFocus
                value={name}
                maxLength={60}
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") saveTemplate();
                }}
                className="min-w-0 flex-1 rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
              />
              <button
                type="button"
                disabled={!name.trim() || pending}
                onClick={saveTemplate}
                className="rounded-md border border-sky-700 px-3 py-2 text-sm text-sky-300 disabled:opacity-40"
              >
                Save
              </button>
              <button
                type="button"
                onClick={() => {
                  setNaming(false);
                  setRenaming(false);
                  if (editingTemplateId)
                    setName(
                      templates.find(
                        (template) => template.id === editingTemplateId,
                      )?.label ?? "",
                    );
                }}
                className="rounded-md border border-slate-700 px-3 py-2 text-sm text-slate-300"
              >
                Cancel
              </button>
            </div>
          ) : null}
          {error ? (
            <p role="alert" className="text-xs text-red-300">
              {error}
            </p>
          ) : null}
          {libraryError ? (
            <p role="alert" className="text-xs text-red-300">
              {libraryError}
            </p>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
