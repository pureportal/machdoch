import { useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_SPEECH_EXPORT,
  parseSpeechTemplate,
  resolveSpeechTemplate,
  type SpeechProject,
  type SpeechProjectTemplate,
  type SpeechRuntime,
} from "@machdoch/speech";
import { errorText, Field } from "./controls.tsx";

export interface TemplatesProps {
  runtime: SpeechRuntime;
  project: SpeechProject;
  onChange: (project: SpeechProject) => void;
}

type TemplateContent = Pick<
  SpeechProjectTemplate,
  "source" | "cast" | "profileId" | "exportSettings"
>;

export function Templates({ runtime, project, onChange }: TemplatesProps) {
  const [templates, setTemplates] = useState<SpeechProjectTemplate[]>([]);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<SpeechProjectTemplate | null>(null);
  const [name, setName] = useState("");
  const [source, setSource] = useState(project.source);
  const [values, setValues] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<TemplateContent | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const previewGeneration = useRef(0);
  const mounted = useRef(true);
  const parsed = useMemo(() => parseSpeechTemplate(source), [source]);
  const variableNames = useMemo(
    () => [...new Set(parsed.variables.map((variable) => variable.name))],
    [parsed],
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      previewGeneration.current += 1;
    };
  }, []);

  useEffect(() => {
    let current = true;
    void runtime
      .execute("listTemplates", { search })
      .then((result) => {
        if (current) setTemplates(result);
      })
      .catch((error) => {
        if (current) setFailure(errorText(error));
      });
    return () => {
      current = false;
    };
  }, [runtime, search, refresh]);

  useEffect(() => {
    previewGeneration.current += 1;
    setPreview(null);
  }, [project]);

  const invalidatePreview = () => {
    previewGeneration.current += 1;
    setPreview(null);
    setFailure("");
    setConfirmDelete(false);
  };

  const openTemplate = (template: SpeechProjectTemplate | null) => {
    invalidatePreview();
    setSelected(template);
    setName(template?.name ?? "");
    setSource(template?.source ?? project.source);
    setValues({});
  };

  const contentFor = (): TemplateContent => {
    const exportSettings = selected
      ? selected.exportSettings
      : (project.exportSettings ?? { ...DEFAULT_SPEECH_EXPORT });
    return structuredClone({
      source,
      cast: selected ? selected.cast : project.cast,
      profileId: selected ? selected.profileId : project.profileId,
      exportSettings,
    });
  };

  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setFailure("");
    try {
      await action();
    } catch (error) {
      if (mounted.current) setFailure(errorText(error));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const save = () =>
    run(async () => {
      if (!name.trim()) throw new Error("Enter a template name.");
      if (parsed.diagnostics.length)
        throw new Error(
          parsed.diagnostics.map((diagnostic) => diagnostic.message).join("\n"),
        );
      const validation = resolveSpeechTemplate(
        source,
        Object.fromEntries(
          variableNames.map((variable) => [variable, "value"]),
        ),
      );
      if (validation.diagnostics.length)
        throw new Error(
          validation.diagnostics
            .map((diagnostic) => diagnostic.message)
            .join("\n"),
        );
      const now = new Date().toISOString();
      const template: SpeechProjectTemplate = {
        ...contentFor(),
        id: selected?.id ?? crypto.randomUUID(),
        name: name.trim(),
        revisionId: selected?.revisionId ?? crypto.randomUUID(),
        parentRevisionId: selected?.parentRevisionId ?? null,
        createdAt: selected?.createdAt ?? now,
        updatedAt: now,
      };
      const saved = await runtime.execute("saveTemplate", {
        template,
        expectedRevisionId: selected?.revisionId ?? null,
      });
      if (!mounted.current) return;
      invalidatePreview();
      setSelected(saved);
      setName(saved.name);
      setSource(saved.source);
      setRefresh((value) => value + 1);
    });

  const resolvePreview = () =>
    run(async () => {
      invalidatePreview();
      const generation = previewGeneration.current;
      const resolved = resolveSpeechTemplate(source, values);
      if (resolved.diagnostics.length)
        throw new Error(
          resolved.diagnostics
            .map((diagnostic) => diagnostic.message)
            .join("\n"),
        );
      const content = { ...contentFor(), source: resolved.source };
      if (mounted.current && generation === previewGeneration.current)
        setPreview(content);
    });

  const reopen = () =>
    run(async () => {
      if (!selected) return;
      const available = await runtime.execute("listTemplates", {});
      if (!mounted.current) return;
      setTemplates(available);
      const current = available.find((template) => template.id === selected.id);
      if (!current)
        throw new Error(
          "Template was deleted. Choose New template before saving.",
        );
      openTemplate(current);
    });

  const remove = () =>
    run(async () => {
      if (!selected) return;
      await runtime.execute("deleteTemplate", {
        id: selected.id,
        expectedRevisionId: selected.revisionId,
      });
      if (!mounted.current) return;
      openTemplate(null);
      setRefresh((value) => value + 1);
    });

  return (
    <section aria-label="Templates">
      <Field label="Search templates">
        <input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </Field>
      <Field label="Template">
        <select
          disabled={busy}
          value={selected?.id ?? ""}
          onChange={(event) => {
            if (!event.target.value) openTemplate(null);
            else {
              const template = templates.find(
                (candidate) => candidate.id === event.target.value,
              );
              if (template) openTemplate(template);
            }
          }}
        >
          <option value="">New template</option>
          {selected &&
            !templates.some((template) => template.id === selected.id) && (
              <option value={selected.id}>{selected.name}</option>
            )}
          {templates.map((template) => (
            <option key={template.id} value={template.id}>
              {template.name}
            </option>
          ))}
        </select>
      </Field>
      <button type="button" disabled={busy} onClick={() => openTemplate(null)}>
        Use current script
      </button>
      <Field label="Template name">
        <input
          value={name}
          disabled={busy}
          maxLength={256}
          onChange={(event) => {
            invalidatePreview();
            setName(event.target.value);
          }}
        />
      </Field>
      <Field label="Template source">
        <textarea
          value={source}
          disabled={busy}
          onChange={(event) => {
            invalidatePreview();
            setSource(event.target.value);
          }}
        />
      </Field>
      {variableNames.map((variable) => (
        <Field key={variable} label={variable}>
          <input
            value={Object.hasOwn(values, variable) ? values[variable] : ""}
            disabled={busy}
            onChange={(event) => {
              invalidatePreview();
              setValues((previous) => ({
                ...previous,
                [variable]: event.target.value,
              }));
            }}
          />
        </Field>
      ))}
      <div className="tts-actions">
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            void save();
          }}
        >
          Save template
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            void resolvePreview();
          }}
        >
          Preview template
        </button>
        <button
          type="button"
          disabled={busy || !preview}
          onClick={() => {
            if (!preview) return;
            onChange({ ...project, ...structuredClone(preview) });
            invalidatePreview();
          }}
        >
          Apply template
        </button>
        {selected && (
          <button
            type="button"
            disabled={busy}
            onClick={() => setConfirmDelete(true)}
          >
            Delete template
          </button>
        )}
      </div>
      {confirmDelete && selected && (
        <div role="alertdialog" aria-label="Delete template">
          <p>Delete “{selected.name}”?</p>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              void remove();
            }}
          >
            Delete
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setConfirmDelete(false)}
          >
            Cancel
          </button>
        </div>
      )}
      {preview && (
        <Field label="Resolved preview">
          <textarea readOnly value={preview.source} />
        </Field>
      )}
      {failure && <p role="alert">{failure}</p>}
      {failure && selected && (
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            void reopen();
          }}
        >
          Reopen template
        </button>
      )}
    </section>
  );
}
