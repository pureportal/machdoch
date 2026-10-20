import type {
  SpeechProject,
  SpeechSceneOverride,
  SpeechNode,
} from "@machdoch/speech";
import { Field } from "./controls.tsx";

export function SceneCasting({
  project,
  scopes,
  edit,
  report,
}: {
  project: SpeechProject;
  scopes: SpeechNode[];
  edit(update: (value: SpeechProject) => SpeechProject): void;
  report(error: unknown): void;
}) {
  if (
    !project.cast.length ||
    (!scopes.length &&
      !project.cast.some((member) => member.sceneOverrides?.length))
  )
    return null;
  const change = (
    memberId: string,
    scopeId: string,
    patch: Partial<SpeechSceneOverride>,
  ) =>
    edit((value) => ({
      ...value,
      cast: value.cast.map((member) =>
        member.id === memberId
          ? {
              ...member,
              sceneOverrides: member.sceneOverrides?.map((binding) =>
                binding.sceneId === scopeId
                  ? { ...binding, ...patch }
                  : binding,
              ),
            }
          : member,
      ),
    }));
  return (
    <details className="tts-stack">
      <summary>Scene casting</summary>
      {!!scopes.length && (
        <form
          className="tts-row"
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            try {
              const memberId = String(data.get("member")),
                scopeId = String(data.get("scope"));
              edit((value) => {
                const member = value.cast.find(
                  (member) => member.id === memberId,
                );
                if (!member || !scopes.some((scope) => scope.id === scopeId))
                  throw new Error("Choose a speaker and a chapter or scene.");
                if (
                  member.sceneOverrides?.some(
                    (binding) => binding.sceneId === scopeId,
                  )
                )
                  throw new Error(
                    "Edit the existing override for this speaker and scene.",
                  );
                const binding: SpeechSceneOverride = {
                  sceneId: scopeId,
                  direction: member.direction,
                  referenceAssetIds: [...member.referenceAssetIds],
                  ...(member.voiceId ? { voiceId: member.voiceId } : {}),
                  ...(member.rightsEvidence
                    ? { rightsEvidence: member.rightsEvidence }
                    : {}),
                };
                return {
                  ...value,
                  cast: value.cast.map((item) =>
                    item.id === memberId
                      ? {
                          ...item,
                          sceneOverrides: [
                            ...(item.sceneOverrides ?? []),
                            binding,
                          ],
                        }
                      : item,
                  ),
                };
              });
            } catch (error) {
              report(error);
            }
          }}
        >
          <Field label="Override speaker">
            <select name="member" required defaultValue="">
              <option value="">Choose speaker</option>
              {project.cast.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Override scene">
            <select name="scope" required defaultValue="">
              <option value="">Choose chapter or scene</option>
              {scopes.map((scope) => (
                <option key={scope.id} value={scope.id}>
                  {scope.value}
                </option>
              ))}
            </select>
          </Field>
          <button>Add cast override</button>
        </form>
      )}
      {project.cast.flatMap((member) =>
        (member.sceneOverrides ?? []).map((binding) => (
          <fieldset
            className="tts-grid"
            key={`${member.id}:${binding.sceneId}`}
          >
            <legend>
              {member.name} ·{" "}
              {scopes.find((scope) => scope.id === binding.sceneId)?.value ??
                "Removed scene"}
            </legend>
            <Field label="Scene voice ID">
              <input
                value={binding.voiceId ?? ""}
                onChange={(event) =>
                  change(member.id, binding.sceneId, {
                    voiceId: event.target.value || undefined,
                    referenceAssetIds: [],
                  })
                }
              />
            </Field>
            <Field label="Scene reference asset IDs">
              <input
                key={binding.referenceAssetIds.join(",")}
                defaultValue={binding.referenceAssetIds.join(", ")}
                onBlur={(event) => {
                  const ids = event.target.value
                    .split(",")
                    .map((value) => value.trim())
                    .filter(Boolean);
                  change(member.id, binding.sceneId, {
                    referenceAssetIds: ids,
                    ...(ids.length ? { voiceId: undefined } : {}),
                  });
                }}
              />
            </Field>
            <Field label="Scene direction">
              <input
                dir="auto"
                value={binding.direction}
                onChange={(event) =>
                  change(member.id, binding.sceneId, {
                    direction: event.target.value,
                  })
                }
              />
            </Field>
            {!!binding.referenceAssetIds.length && (
              <Field label="Scene rights evidence">
                <input
                  value={binding.rightsEvidence ?? ""}
                  onChange={(event) =>
                    change(member.id, binding.sceneId, {
                      rightsEvidence: event.target.value,
                    })
                  }
                />
              </Field>
            )}
            <button
              onClick={() =>
                edit((value) => ({
                  ...value,
                  cast: value.cast.map((item) =>
                    item.id === member.id
                      ? {
                          ...item,
                          sceneOverrides: item.sceneOverrides?.filter(
                            (override) => override.sceneId !== binding.sceneId,
                          ),
                        }
                      : item,
                  ),
                }))
              }
            >
              Remove cast override
            </button>
          </fieldset>
        )),
      )}
    </details>
  );
}
