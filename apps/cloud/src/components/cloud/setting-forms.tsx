"use client";

import { useRef, useState, type FormEvent } from "react";
import {
  projectUpdateCadences,
  type ProjectUpdateCadence,
} from "@/lib/cloud-contract";
import type { SettingScope } from "@/lib/cloud-settings-contract";
import {
  loopHarnesses,
  loopPlacements,
  type LoopHarness,
  type LoopPlacement,
} from "@/lib/cloud-loop-contract";
import { harnessLabels, placementLabels } from "@/lib/loop-capabilities";
import { projectUpdateCadenceLabels } from "@/lib/project-status";
import { Field } from "@/components/field";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { createCommandSender, formText } from "./api-client";
import { MarkdownTextarea } from "./markdown-textarea";
import { agentModelValue, parseAgentModelValue } from "./use-agent-models";
import { useToast } from "./toast";

function useSettingWriter() {
  const sender = useRef(createCommandSender());
  const toast = useToast();
  const [pending, setPending] = useState(false);
  async function write(
    entries: {
      scope: SettingScope;
      teamId?: string;
      key: string;
      value: unknown;
    }[],
  ) {
    setPending(true);
    try {
      for (const entry of entries)
        await sender.current("settings", entry, "PUT");
      toast("Saved");
    } catch (reason) {
      toast((reason as Error).message, "error");
    } finally {
      sender.current = createCommandSender();
      setPending(false);
    }
  }
  return { pending, write };
}

export function ReviewPreferences({
  diffLayout,
  showWhitespace,
}: {
  diffLayout: "unified" | "split";
  showWhitespace: boolean;
}) {
  const { pending, write } = useSettingWriter();
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void write([
      {
        scope: "user",
        key: "review.diffLayout",
        value: formText(form, "diffLayout"),
      },
      {
        scope: "user",
        key: "review.showWhitespace",
        value: form.has("showWhitespace"),
      },
    ]);
  }
  return (
    <form
      className="cloud-settings-section cloud-setting-form"
      onSubmit={submit}
    >
      <Field label="Diff layout" htmlFor="setting-diff-layout">
        <Select
          id="setting-diff-layout"
          name="diffLayout"
          defaultValue={diffLayout}
        >
          <option value="unified">Unified</option>
          <option value="split">Split</option>
        </Select>
      </Field>
      <label className="cloud-setting-check">
        <input
          type="checkbox"
          name="showWhitespace"
          defaultChecked={showWhitespace}
        />
        Show whitespace changes
      </label>
      <Button type="submit" disabled={pending}>
        Save
      </Button>
    </form>
  );
}

export function AgentInstructionsSetting({
  label,
  scope,
  teamId,
  initial,
  writable,
}: {
  label: string;
  scope: SettingScope;
  teamId?: string;
  initial: string;
  writable: boolean;
}) {
  const { pending, write } = useSettingWriter();
  const [text, setText] = useState(initial);
  const id = `agent-instructions-${scope}-${teamId ?? "all"}`;
  return (
    <form
      className="cloud-settings-section cloud-setting-form"
      onSubmit={(event) => {
        event.preventDefault();
        void write([{ scope, teamId, key: "agent.instructions", value: text }]);
      }}
    >
      <Field label={label} htmlFor={id}>
        <MarkdownTextarea
          id={id}
          value={text}
          readOnly={!writable}
          maxLength={20000}
          rows={8}
          onChange={(event) => setText(event.target.value)}
        />
      </Field>
      {writable && (
        <Button type="submit" disabled={pending}>
          Save
        </Button>
      )}
    </form>
  );
}

export function AgentDefaultsSetting({
  providers,
  model,
  harness,
  placement,
}: {
  providers: { id: string; name: string; models: string[] }[];
  model: { providerId: string; model: string } | null;
  harness: LoopHarness;
  placement: LoopPlacement;
}) {
  const { pending, write } = useSettingWriter();
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void write([
      {
        scope: "user",
        key: "agent.model",
        value: parseAgentModelValue(formText(form, "model")),
      },
      { scope: "user", key: "agent.harness", value: formText(form, "harness") },
      {
        scope: "user",
        key: "agent.placement",
        value: formText(form, "placement"),
      },
    ]);
  }
  return (
    <form
      className="cloud-settings-section cloud-setting-form"
      onSubmit={submit}
    >
      <Field label="Model" htmlFor="setting-agent-model">
        <Select
          id="setting-agent-model"
          name="model"
          defaultValue={
            model ? agentModelValue(model.providerId, model.model) : ""
          }
        >
          <option value="">{placementLabels.automatic}</option>
          {providers.flatMap((provider) =>
            provider.models.map((entry) => (
              <option
                key={agentModelValue(provider.id, entry)}
                value={agentModelValue(provider.id, entry)}
              >
                {`${provider.name} · ${entry}`}
              </option>
            )),
          )}
        </Select>
      </Field>
      <Field label="Harness" htmlFor="setting-agent-harness">
        <Select
          id="setting-agent-harness"
          name="harness"
          defaultValue={harness}
        >
          {loopHarnesses.map((entry) => (
            <option key={entry} value={entry}>
              {harnessLabels[entry]}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Placement" htmlFor="setting-agent-placement">
        <Select
          id="setting-agent-placement"
          name="placement"
          defaultValue={placement}
        >
          {loopPlacements.map((entry) => (
            <option key={entry} value={entry}>
              {placementLabels[entry]}
            </option>
          ))}
        </Select>
      </Field>
      <Button type="submit" disabled={pending}>
        Save
      </Button>
    </form>
  );
}

export function ProjectUpdateCadenceSetting({
  cadence,
  writable,
}: {
  cadence: ProjectUpdateCadence;
  writable: boolean;
}) {
  const { pending, write } = useSettingWriter();
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void write([
      {
        scope: "organization",
        key: "projects.updateCadence",
        value: formText(form, "cadence"),
      },
    ]);
  }
  return (
    <form
      className="cloud-settings-section cloud-setting-form"
      onSubmit={submit}
    >
      <Field label="Default update cadence" htmlFor="setting-update-cadence">
        <Select
          id="setting-update-cadence"
          name="cadence"
          defaultValue={cadence}
          disabled={!writable}
        >
          {projectUpdateCadences.map((value) => (
            <option key={value} value={value}>
              {projectUpdateCadenceLabels[value]}
            </option>
          ))}
        </Select>
      </Field>
      {writable && (
        <Button type="submit" disabled={pending}>
          Save
        </Button>
      )}
    </form>
  );
}
