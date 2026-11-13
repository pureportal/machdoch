"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cloudRequest } from "./api-client";
import { agentModelValue, storedAgentModel } from "./use-agent-models";
import { useToast } from "./toast";
import type { AgentModelOption } from "./use-automation-options";

export function automationRequestPrompt(description: string): string {
  return [
    `Build an automation for this team: ${description.trim()}`,
    "",
    "Read the IDs with get_automation_options and existing automations with list_automations when the request refers to them. Then call propose_automation once with the complete definition. Ask only if something essential is missing.",
  ].join("\n");
}

export function AutomationDescribe({
  teamId,
  models,
}: {
  teamId: string;
  models: AgentModelOption[];
}) {
  const router = useRouter();
  const toast = useToast();
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const stored = storedAgentModel();
    const model =
      models.find(
        (entry) => agentModelValue(entry.providerId, entry.model) === stored,
      ) ?? models[0];
    if (!model || !text.trim() || pending) return;
    setPending(true);
    void cloudRequest<{ chatId: string }>("chats", {
      method: "POST",
      key: crypto.randomUUID(),
      body: {
        chatId: null,
        revision: null,
        providerId: model.providerId,
        model: model.model,
        prompt: automationRequestPrompt(text),
        context: [{ kind: "team", id: teamId }],
      },
    })
      .then((submission) => router.push(`/cloud/chat/${submission.chatId}`))
      .catch((reason: Error) => {
        toast(reason.message, "error");
        setPending(false);
      });
  };
  return (
    <form className="cloud-automation-describe" onSubmit={submit}>
      <Textarea
        aria-label="Describe the automation"
        placeholder="When a bug is marked urgent, assign it to me and ask Agent for a fix plan"
        value={text}
        maxLength={4000}
        rows={2}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey))
            submit(event);
        }}
      />
      <Button type="submit" disabled={!text.trim() || pending}>
        <Sparkles aria-hidden="true" />
        {pending ? "Starting…" : "Build with Agent"}
      </Button>
    </form>
  );
}
