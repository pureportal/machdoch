import { useId, type JSX } from "react";
import type {
  ResearchProjectInput,
  ResearchSourceCheck,
} from "@machdoch/fleet-protocol/workspace-library";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import { Input } from "@machdoch/media-studio/tauri/ui/components/ui/input.js";

const areaClass =
  "min-h-20 w-full rounded-md border border-slate-700 bg-slate-950 p-2 text-sm";
export function ResearchEvidenceEditor({
  project,
  checks,
  onChange,
}: {
  project: ResearchProjectInput;
  checks: ResearchSourceCheck[];
  onChange: (project: ResearchProjectInput) => void;
}): JSX.Element {
  const id = useId();
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">Sources</h3>
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            onChange({
              ...project,
              sources: [
                ...project.sources,
                { id: crypto.randomUUID(), title: "", uri: "", excerpt: "" },
              ],
            })
          }
        >
          Add source
        </Button>
      </div>
      {project.sources.map((source, index) => (
        <fieldset
          key={source.id}
          className="space-y-2 rounded-md border border-slate-800 p-3"
        >
          <legend className="px-1 text-xs text-slate-400">
            Source {index + 1}
          </legend>
          <label className="block text-xs">
            Title
            <Input
              value={source.title}
              maxLength={300}
              onChange={(event) =>
                onChange({
                  ...project,
                  sources: project.sources.map((item) =>
                    item.id === source.id
                      ? { ...item, title: event.target.value }
                      : item,
                  ),
                })
              }
            />
          </label>
          <label className="block text-xs">
            URL or workspace path
            <Input
              value={source.uri}
              maxLength={2048}
              onChange={(event) =>
                onChange({
                  ...project,
                  sources: project.sources.map((item) => {
                    if (item.id !== source.id) return item;
                    const {
                      fingerprint: _fingerprint,
                      checkedAt: _checkedAt,
                      ...rest
                    } = item;
                    return { ...rest, uri: event.target.value };
                  }),
                })
              }
            />
          </label>
          <div className="text-xs">
            <label htmlFor={`${id}-${source.id}-excerpt`}>Excerpt</label>
            <textarea
              id={`${id}-${source.id}-excerpt`}
              className={areaClass}
              value={source.excerpt}
              maxLength={12000}
              onChange={(event) =>
                onChange({
                  ...project,
                  sources: project.sources.map((item) => {
                    if (item.id !== source.id) return item;
                    const {
                      fingerprint: _fingerprint,
                      checkedAt: _checkedAt,
                      ...rest
                    } = item;
                    return { ...rest, excerpt: event.target.value };
                  }),
                })
              }
            />
          </div>
          {checks.find((check) => check.sourceId === source.id)?.state ===
            "changed" && (
            <p className="text-xs text-amber-300">
              Source changed. Review the excerpt before using it.
            </p>
          )}
          {checks.find((check) => check.sourceId === source.id)?.state ===
            "missing" && (
            <p className="text-xs text-red-300">
              Source is missing. Update its path or remove it.
            </p>
          )}
          {checks.find((check) => check.sourceId === source.id)?.state ===
            "unverified" && (
            <p className="text-xs text-amber-300">
              Source has not been verified. Open it to review the evidence.
            </p>
          )}
          {/^https?:\/\//iu.test(source.uri) && (
            <a
              className="mr-3 text-xs text-sky-300"
              href={source.uri}
              target="_blank"
              rel="noreferrer"
            >
              Open source
            </a>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              onChange({
                ...project,
                sources: project.sources.filter(
                  (item) => item.id !== source.id,
                ),
                findings: project.findings.map((finding) => ({
                  ...finding,
                  sourceIds: finding.sourceIds.filter((id) => id !== source.id),
                  status: finding.sourceIds.includes(source.id)
                    ? "uncertain"
                    : finding.status,
                })),
              })
            }
          >
            Remove source
          </Button>
        </fieldset>
      ))}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">Findings</h3>
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            onChange({
              ...project,
              findings: [
                ...project.findings,
                {
                  id: crypto.randomUUID(),
                  claim: "",
                  sourceIds: [],
                  status: "uncertain",
                },
              ],
            })
          }
        >
          Add finding
        </Button>
      </div>
      {project.findings.map((finding, index) => (
        <fieldset
          key={finding.id}
          className="space-y-2 rounded-md border border-slate-800 p-3"
        >
          <legend className="px-1 text-xs text-slate-400">
            Finding {index + 1}
          </legend>
          <div className="text-xs">
            <label htmlFor={`${id}-${finding.id}-claim`}>Claim</label>
            <textarea
              id={`${id}-${finding.id}-claim`}
              className={areaClass}
              value={finding.claim}
              maxLength={4000}
              onChange={(event) =>
                onChange({
                  ...project,
                  findings: project.findings.map((item) =>
                    item.id === finding.id
                      ? { ...item, claim: event.target.value }
                      : item,
                  ),
                })
              }
            />
          </div>
          <label className="flex items-center gap-2 text-xs">
            Status
            <select
              className="rounded border border-slate-700 bg-slate-950 p-2"
              value={finding.status}
              onChange={(event) =>
                onChange({
                  ...project,
                  findings: project.findings.map((item) =>
                    item.id === finding.id
                      ? {
                          ...item,
                          status: event.target.value as typeof finding.status,
                        }
                      : item,
                  ),
                })
              }
            >
              <option value="uncertain">Uncertain</option>
              <option value="supported" disabled={!finding.sourceIds.length}>
                Supported
              </option>
              <option value="contradicted">Contradicted</option>
            </select>
          </label>
          {project.sources.map((source) => (
            <label key={source.id} className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={finding.sourceIds.includes(source.id)}
                onChange={(event) =>
                  onChange({
                    ...project,
                    findings: project.findings.map((item) => {
                      if (item.id !== finding.id) return item;
                      const sourceIds = event.target.checked
                        ? [...item.sourceIds, source.id]
                        : item.sourceIds.filter((id) => id !== source.id);
                      return {
                        ...item,
                        sourceIds,
                        status:
                          item.status === "supported" && !sourceIds.length
                            ? "uncertain"
                            : item.status,
                      };
                    }),
                  })
                }
              />
              {source.title || `Source ${project.sources.indexOf(source) + 1}`}
            </label>
          ))}
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              onChange({
                ...project,
                findings: project.findings.filter(
                  (item) => item.id !== finding.id,
                ),
              })
            }
          >
            Remove finding
          </Button>
        </fieldset>
      ))}
    </div>
  );
}
