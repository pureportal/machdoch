"use client";

import { Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Field } from "@/components/field";
import { FormDialog } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  channelMediaFormats,
  emojiPolicies,
  redditPostTypes,
  webhookFormats,
  type ChannelInput,
  type ChannelKind,
  type ChannelRules,
  type CloudChannel,
  type SocialAccount,
  type SocialTarget,
  type SubredditFlair,
  type SubredditTarget,
} from "@/lib/cloud-release-contract";
import { channelLimits, defaultChannelRules } from "@/lib/release-posts";
import { cloudRequest, createCommandSender } from "./api-client";
import { channelKindLabels } from "@/lib/cloud-release-contract";

const mediaLabels: Record<ChannelRules["media"], string> = {
  landscape: "Landscape image",
  square: "Square image",
  portrait: "Portrait image",
  wide: "Wide image",
  video: "Video",
  none: "No media",
};
const webhookLabels = {
  slack: "Slack",
  discord: "Discord",
  json: "JSON",
} as const;

function initialChannel(
  kind: ChannelKind,
  accounts: SocialAccount[],
): ChannelInput {
  const shape = {
    rules: defaultChannelRules(kind),
    requiresApproval: true,
    enabled: true,
  };
  if (kind === "linkedin")
    return {
      ...shape,
      kind,
      name: "LinkedIn",
      accountId:
        accounts.find((entry) => entry.network === "linkedin")?.id ?? "",
      authorUrn: "",
      authorName: "",
    };
  if (kind === "reddit")
    return {
      ...shape,
      kind,
      name: "Reddit",
      accountId: accounts.find((entry) => entry.network === "reddit")?.id ?? "",
      subreddits: [
        { name: "", flairId: null, flairText: null, postType: "text" },
      ],
    };
  return { ...shape, kind, name: "Team chat", url: "", format: "slack" };
}

function fromChannel(channel: CloudChannel): ChannelInput {
  const {
    id: _,
    productId: __,
    revision: ___,
    position: ____,
    accountName: _____,
    ...rest
  } = channel;
  if (rest.kind === "webhook") {
    const { webhookHost: _host, ...webhook } = rest;
    return { ...webhook, url: null };
  }
  return rest as ChannelInput;
}

function SubredditRow({
  entry,
  accountId,
  onChange,
  onRemove,
}: {
  entry: SubredditTarget;
  accountId: string;
  onChange: (entry: SubredditTarget) => void;
  onRemove: () => void;
}) {
  const [flairs, setFlairs] = useState<SubredditFlair[]>([]);
  const name = entry.name.replace(/^\/?r\//i, "");
  useEffect(() => {
    if (!accountId || !/^[A-Za-z0-9_]{2,21}$/.test(name)) return;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      cloudRequest<SubredditFlair[]>(
        `social/accounts/${accountId}/flairs?subreddit=${name}`,
        { signal: abort.signal },
      )
        .then(setFlairs)
        .catch(() => setFlairs([]));
    }, 400);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [accountId, name]);
  return (
    <div className="cloud-channel-subreddit">
      <Input
        aria-label="Subreddit"
        placeholder="r/programming"
        value={entry.name}
        onChange={(event) => onChange({ ...entry, name: event.target.value })}
      />
      <Select
        aria-label="Post type"
        value={entry.postType}
        onChange={(event) =>
          onChange({
            ...entry,
            postType: event.target.value as SubredditTarget["postType"],
          })
        }
      >
        {redditPostTypes.map((type) => (
          <option key={type} value={type}>
            {type === "text"
              ? "Text post"
              : type === "link"
                ? "Link post"
                : "Image post"}
          </option>
        ))}
      </Select>
      <Select
        aria-label="Flair"
        value={entry.flairId ?? ""}
        onChange={(event) => {
          const flair = flairs.find((item) => item.id === event.target.value);
          onChange({
            ...entry,
            flairId: flair?.id ?? null,
            flairText: flair?.text ?? null,
          });
        }}
      >
        <option value="">No flair</option>
        {entry.flairId && !flairs.some((item) => item.id === entry.flairId) && (
          <option value={entry.flairId}>
            {entry.flairText ?? "Saved flair"}
          </option>
        )}
        {flairs.map((flair) => (
          <option key={flair.id} value={flair.id}>
            {flair.text}
          </option>
        ))}
      </Select>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label="Remove subreddit"
        onClick={onRemove}
      >
        <Trash2 />
      </Button>
    </div>
  );
}

export function ChannelEditor({
  productId,
  kind,
  channel,
  accounts,
  onClose,
  onSaved,
}: {
  productId: string;
  kind: ChannelKind;
  channel?: CloudChannel;
  accounts: SocialAccount[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const sender = useRef(createCommandSender());
  const [input, setInput] = useState<ChannelInput>(
    channel ? fromChannel(channel) : initialChannel(kind, accounts),
  );
  const [targets, setTargets] = useState<SocialTarget[] | null>(null);
  const [targetError, setTargetError] = useState("");
  const update = (patch: Partial<ChannelInput>) =>
    setInput((current) => ({ ...current, ...patch }) as ChannelInput);
  const rules = (patch: Partial<ChannelRules>) =>
    update({ rules: { ...input.rules, ...patch } });
  const networkAccounts = accounts.filter(
    (entry) => entry.network === input.kind,
  );
  const accountId = input.kind === "webhook" ? "" : input.accountId;
  useEffect(() => {
    if (input.kind !== "linkedin" || !accountId) return;
    const abort = new AbortController();
    setTargets(null);
    setTargetError("");
    cloudRequest<SocialTarget[]>(`social/accounts/${accountId}/targets`, {
      signal: abort.signal,
    })
      .then(setTargets)
      .catch((reason: Error) => {
        if (!abort.signal.aborted) setTargetError(reason.message);
      });
    return () => abort.abort();
  }, [input.kind, accountId]);
  const invalid =
    !input.name.trim() ||
    (input.kind === "linkedin" && (!input.accountId || !input.authorUrn)) ||
    (input.kind === "reddit" &&
      (!input.accountId ||
        input.subreddits.some((entry) => !entry.name.trim()))) ||
    (input.kind === "webhook" && !channel && !input.url);
  return (
    <FormDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={
        channel
          ? `Edit ${channelKindLabels[input.kind]} channel`
          : `New ${channelKindLabels[input.kind]} channel`
      }
      submitLabel={channel ? "Save" : "Add channel"}
      submitDisabled={invalid}
      onSubmit={async () => {
        if (channel)
          await sender.current(
            `channels/${channel.id}`,
            { revision: channel.revision, channel: input },
            "PATCH",
          );
        else await sender.current(`products/${productId}/channels`, input);
        await onSaved();
      }}
    >
      <div className="cloud-automation-editor">
        <Field label="Name" htmlFor="channel-name">
          <Input
            id="channel-name"
            value={input.name}
            maxLength={80}
            onChange={(event) => update({ name: event.target.value })}
          />
        </Field>
        {input.kind !== "webhook" && (
          <Field label="Account" htmlFor="channel-account">
            <Select
              id="channel-account"
              value={input.accountId}
              onChange={(event) =>
                update({
                  accountId: event.target.value,
                  ...(input.kind === "linkedin"
                    ? { authorUrn: "", authorName: "" }
                    : {}),
                })
              }
            >
              {!input.accountId && (
                <option value="">Connect an account under Connections</option>
              )}
              {networkAccounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {input.kind === "linkedin" && input.accountId && (
          <Field label="Post as" htmlFor="channel-author">
            <Select
              id="channel-author"
              value={input.authorUrn}
              onChange={(event) => {
                const target = targets?.find(
                  (entry) => entry.urn === event.target.value,
                );
                update({
                  authorUrn: target?.urn ?? "",
                  authorName: target?.name ?? "",
                });
              }}
            >
              <option value="">
                {targets
                  ? "Choose a profile or page"
                  : targetError || "Loading…"}
              </option>
              {input.authorUrn &&
                !targets?.some((entry) => entry.urn === input.authorUrn) && (
                  <option value={input.authorUrn}>{input.authorName}</option>
                )}
              {targets?.map((target) => (
                <option key={target.urn} value={target.urn}>
                  {target.name} ·{" "}
                  {target.kind === "person" ? "Profile" : "Page"}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {input.kind === "reddit" && (
          <section className="cloud-automation-section" aria-label="Subreddits">
            <h3>Subreddits</h3>
            {input.subreddits.map((entry, index) => (
              <SubredditRow
                key={index}
                entry={entry}
                accountId={input.accountId}
                onChange={(next) =>
                  update({
                    subreddits: input.subreddits.map((item, position) =>
                      position === index ? next : item,
                    ),
                  })
                }
                onRemove={() =>
                  update({
                    subreddits: input.subreddits.filter(
                      (_, position) => position !== index,
                    ),
                  })
                }
              />
            ))}
            {input.subreddits.length < 10 && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  update({
                    subreddits: [
                      ...input.subreddits,
                      {
                        name: "",
                        flairId: null,
                        flairText: null,
                        postType: "text",
                      },
                    ],
                  })
                }
              >
                <Plus />
                Add subreddit
              </Button>
            )}
          </section>
        )}
        {input.kind === "webhook" && (
          <div className="grid gap-3 sm:grid-cols-[1fr_160px]">
            <Field label="Webhook URL" htmlFor="channel-url">
              <Input
                id="channel-url"
                type="url"
                value={input.url ?? ""}
                placeholder={
                  channel
                    ? `Keep ${channel.kind === "webhook" ? channel.webhookHost : ""}`
                    : "https://hooks.slack.com/services/…"
                }
                onChange={(event) =>
                  update({ url: event.target.value || null })
                }
              />
            </Field>
            <Field label="Format" htmlFor="channel-format">
              <Select
                id="channel-format"
                value={input.format}
                onChange={(event) =>
                  update({
                    format: event.target
                      .value as (typeof webhookFormats)[number],
                  })
                }
              >
                {webhookFormats.map((format) => (
                  <option key={format} value={format}>
                    {webhookLabels[format]}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        )}
        <section
          className="cloud-automation-section"
          aria-label="Writing rules"
        >
          <h3>Writing rules</h3>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Max characters" htmlFor="channel-length">
              <Input
                id="channel-length"
                type="number"
                min={50}
                max={channelLimits[input.kind].body}
                value={input.rules.maxLength}
                onChange={(event) =>
                  rules({
                    maxLength: Math.min(
                      channelLimits[input.kind].body,
                      Number(event.target.value) || 50,
                    ),
                  })
                }
              />
            </Field>
            <Field label="Emoji" htmlFor="channel-emoji">
              <Select
                id="channel-emoji"
                value={input.rules.emoji}
                onChange={(event) =>
                  rules({ emoji: event.target.value as ChannelRules["emoji"] })
                }
              >
                {emojiPolicies.map((policy) => (
                  <option key={policy} value={policy}>
                    {policy === "none"
                      ? "None"
                      : policy === "light"
                        ? "A few"
                        : "Expressive"}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Media" htmlFor="channel-media">
              <Select
                id="channel-media"
                value={input.rules.media}
                onChange={(event) =>
                  rules({ media: event.target.value as ChannelRules["media"] })
                }
              >
                {channelMediaFormats.map((format) => (
                  <option key={format} value={format}>
                    {mediaLabels[format]}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="Tone" htmlFor="channel-tone">
            <Input
              id="channel-tone"
              value={input.rules.tone}
              maxLength={500}
              placeholder="Professional, customer-focused"
              onChange={(event) => rules({ tone: event.target.value })}
            />
          </Field>
          <Field label="Instructions" htmlFor="channel-instructions">
            <Textarea
              id="channel-instructions"
              rows={3}
              maxLength={2_000}
              value={input.rules.instructions}
              placeholder={
                input.kind === "reddit"
                  ? "No marketing language. Lead with what changed and why."
                  : "Open with the customer benefit. End with a question."
              }
              onChange={(event) => rules({ instructions: event.target.value })}
            />
          </Field>
          <div className="cloud-automation-row">
            {input.kind !== "reddit" && (
              <Label className="cloud-automation-check">
                <input
                  type="checkbox"
                  checked={input.rules.hashtags}
                  onChange={(event) =>
                    rules({ hashtags: event.target.checked })
                  }
                />
                Add product hashtags
              </Label>
            )}
            <Label className="cloud-automation-check">
              <input
                type="checkbox"
                checked={input.rules.includeLink}
                onChange={(event) =>
                  rules({ includeLink: event.target.checked })
                }
              />
              Include link
            </Label>
            <Label className="cloud-automation-check">
              <input
                type="checkbox"
                checked={input.requiresApproval}
                onChange={(event) =>
                  update({ requiresApproval: event.target.checked })
                }
              />
              Requires approval
            </Label>
            <Label className="cloud-automation-check">
              <input
                type="checkbox"
                checked={input.enabled}
                onChange={(event) => update({ enabled: event.target.checked })}
              />
              Enabled
            </Label>
          </div>
        </section>
      </div>
    </FormDialog>
  );
}
