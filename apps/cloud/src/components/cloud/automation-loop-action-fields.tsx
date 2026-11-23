"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import {
  notifyChannels,
  type AutomationAction,
} from "@/lib/cloud-automation-contract";
import { notifyChannelLabels } from "./automation-display";
import { TemplateText } from "./automation-template-text";
import type { AutomationOptions } from "./use-automation-options";

export type LoopAction = Extract<
  AutomationAction,
  {
    kind:
      | "request_input"
      | "goal"
      | "fan_out"
      | "remember"
      | "append_document_section"
      | "notify";
  }
>;

const loopActionKinds = new Set<AutomationAction["kind"]>([
  "request_input",
  "goal",
  "fan_out",
  "remember",
  "append_document_section",
  "notify",
]);

export function isLoopAction(action: AutomationAction): action is LoopAction {
  return loopActionKinds.has(action.kind);
}

function clampedNumber(value: string, maximum: number): number {
  return Math.min(maximum, Math.max(1, Math.floor(Number(value) || 1)));
}

export function LoopActionFields({
  action,
  index,
  options,
  variables,
  automations,
  onChange,
}: {
  action: LoopAction;
  index: number;
  options: AutomationOptions;
  variables: string[];
  automations: { id: string; name: string }[];
  onChange: (action: AutomationAction) => void;
}) {
  switch (action.kind) {
    case "request_input":
      return (
        <>
          <TemplateText
            label="Question"
            value={action.prompt}
            variables={variables}
            rows={2}
            maxLength={2_000}
            onChange={(prompt) => onChange({ ...action, prompt })}
          />
          <Input
            aria-label="Save answer as"
            placeholder="answer_key"
            maxLength={64}
            value={action.key}
            onChange={(event) =>
              onChange({ ...action, key: event.target.value })
            }
          />
        </>
      );
    case "goal":
      return (
        <>
          <TemplateText
            label="Objective"
            value={action.objective}
            variables={variables}
            rows={3}
            maxLength={8_000}
            onChange={(objective) => onChange({ ...action, objective })}
          />
          <TemplateText
            label="Done when"
            value={action.successCriteria}
            variables={variables}
            rows={2}
            maxLength={4_000}
            onChange={(successCriteria) =>
              onChange({ ...action, successCriteria })
            }
          />
          <div className="cloud-automation-row">
            <Select
              aria-label="Model"
              value={`${action.providerId}/${action.model}`}
              onChange={(event) => {
                const [providerId, ...model] = event.target.value.split("/");
                onChange({
                  ...action,
                  providerId: providerId ?? "",
                  model: model.join("/"),
                });
              }}
            >
              {!options.models.some(
                (option) =>
                  option.providerId === action.providerId &&
                  option.model === action.model,
              ) && <option value={`${action.providerId}/${action.model}`} />}
              {options.models.map((option) => (
                <option
                  key={`${option.providerId}/${option.model}`}
                  value={`${option.providerId}/${option.model}`}
                >
                  {option.label}
                </option>
              ))}
            </Select>
            <Label htmlFor={`loop-iterations-${index}`}>Iterations</Label>
            <Input
              id={`loop-iterations-${index}`}
              type="number"
              min={1}
              max={10}
              value={action.maxIterations}
              onChange={(event) =>
                onChange({
                  ...action,
                  maxIterations: clampedNumber(event.target.value, 10),
                })
              }
            />
          </div>
        </>
      );
    case "fan_out":
      return (
        <div className="cloud-automation-row">
          <Select
            aria-label="Automation"
            value={action.automationId}
            onChange={(event) =>
              onChange({ ...action, automationId: event.target.value })
            }
          >
            {!action.automationId && (
              <option value="">Choose automation</option>
            )}
            {automations.map((automation) => (
              <option key={automation.id} value={automation.id}>
                {automation.name}
              </option>
            ))}
          </Select>
          <Label htmlFor={`loop-concurrency-${index}`}>At a time</Label>
          <Input
            id={`loop-concurrency-${index}`}
            type="number"
            min={1}
            max={10}
            value={action.concurrency}
            onChange={(event) =>
              onChange({
                ...action,
                concurrency: clampedNumber(event.target.value, 10),
              })
            }
          />
        </div>
      );
    case "remember":
      return (
        <>
          <Input
            aria-label="Key"
            placeholder="key"
            maxLength={64}
            value={action.key}
            onChange={(event) =>
              onChange({ ...action, key: event.target.value })
            }
          />
          <TemplateText
            label="Value"
            value={action.value}
            variables={variables}
            rows={2}
            maxLength={4_000}
            onChange={(value) => onChange({ ...action, value })}
          />
        </>
      );
    case "append_document_section":
      return (
        <>
          <Select
            aria-label="Document"
            value={action.documentId}
            onChange={(event) =>
              onChange({ ...action, documentId: event.target.value })
            }
          >
            {!action.documentId && <option value="">Choose document</option>}
            {options.documents.map((document) => (
              <option key={document.id} value={document.id}>
                {document.title}
              </option>
            ))}
          </Select>
          <TemplateText
            label="Heading"
            value={action.heading}
            variables={variables}
            rows={1}
            maxLength={200}
            onChange={(heading) => onChange({ ...action, heading })}
          />
          <TemplateText
            label="Body"
            value={action.body}
            variables={variables}
            rows={4}
            maxLength={50_000}
            onChange={(body) => onChange({ ...action, body })}
          />
        </>
      );
    case "notify":
      return (
        <>
          <div className="cloud-automation-row">
            <Select
              aria-label="Channel"
              value={action.channel}
              onChange={(event) =>
                onChange({
                  ...action,
                  channel: event.target.value as typeof action.channel,
                  target: "",
                })
              }
            >
              {notifyChannels.map((channel) => (
                <option key={channel} value={channel}>
                  {notifyChannelLabels[channel]}
                </option>
              ))}
            </Select>
            <Input
              type={action.channel === "email" ? "email" : "url"}
              aria-label={
                action.channel === "email" ? "Email address" : "Webhook URL"
              }
              placeholder={
                action.channel === "email" ? "team@example.com" : "https://"
              }
              maxLength={2_000}
              value={action.target}
              onChange={(event) =>
                onChange({ ...action, target: event.target.value })
              }
            />
          </div>
          {action.channel === "email" && (
            <TemplateText
              label="Subject"
              value={action.subject}
              variables={variables}
              rows={1}
              maxLength={200}
              onChange={(subject) => onChange({ ...action, subject })}
            />
          )}
          <TemplateText
            label="Message"
            value={action.body}
            variables={variables}
            rows={3}
            maxLength={20_000}
            onChange={(body) => onChange({ ...action, body })}
          />
        </>
      );
  }
}
