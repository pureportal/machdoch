"use client";

import { ImagePlus, Package, Pencil, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ConfirmButton } from "@/components/confirm-button";
import { Field } from "@/components/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { CloudWorkspace } from "@/lib/cloud-contract";
import type {
  ChannelKind,
  CloudChannel,
  CloudProduct,
  ProductInput,
  SocialAccount,
} from "@/lib/cloud-release-contract";
import type { ReleaseMedia } from "@/lib/cloud-release-media-contract";
import { cloudRequest, cloudUpload, createCommandSender } from "./api-client";
import { channelKindLabels } from "@/lib/cloud-release-contract";
import { ChannelEditor } from "./channel-editor";
import { ChannelMark, mediaUrl, ReleaseSections } from "./release-display";
import { PropertyMenu } from "./property-menu";
import { useToast } from "./toast";

const colorFields = [
  ["primary", "Primary"],
  ["accent", "Accent"],
  ["background", "Background"],
  ["foreground", "Text"],
] as const;

export const emptyProduct: ProductInput = {
  name: "",
  key: "",
  tagline: "",
  description: "",
  website: null,
  voice: "",
  audience: "",
  hashtags: [],
  callToAction: "",
  brand: {
    primary: "#6356cf",
    accent: "#7bc8ef",
    background: "#141519",
    foreground: "#eeedf2",
  },
  logoMediaId: null,
  teamIds: [],
  captureBrief: "",
  visualStyle: "",
  video: { introSeconds: 2.5, outroSeconds: 3 },
  membersCanPublish: false,
};

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

function definition(product: CloudProduct): ProductInput {
  const {
    id: _,
    revision: __,
    archived: ___,
    channelCount: ____,
    releaseCount: _____,
    createdAt: ______,
    ...input
  } = product;
  return input;
}

function ProductForm({
  workspace,
  product,
  onSaved,
}: {
  workspace: CloudWorkspace;
  product: CloudProduct | null;
  onSaved: (id: string) => Promise<void>;
}) {
  const toast = useToast();
  const sender = useRef(createCommandSender());
  const logoInput = useRef<HTMLInputElement>(null);
  const [input, setInput] = useState<ProductInput>(
    product ? definition(product) : emptyProduct,
  );
  const [hashtags, setHashtags] = useState(
    input.hashtags.map((tag) => `#${tag}`).join(" "),
  );
  const [saving, setSaving] = useState(false);
  const update = (patch: Partial<ProductInput>) =>
    setInput((current) => ({ ...current, ...patch }));
  async function save() {
    setSaving(true);
    try {
      const body = {
        ...input,
        website: input.website || null,
        hashtags: hashtags
          .split(/[\s,]+/)
          .map((tag) => tag.replace(/^#/, ""))
          .filter(Boolean)
          .slice(0, 10),
      };
      const { id } = product
        ? await sender.current<{ id: string }>(
            `products/${product.id}`,
            { revision: product.revision, product: body },
            "PATCH",
          )
        : await sender.current<{ id: string }>("products", body);
      await onSaved(id);
      toast(product ? "Product saved" : "Product created");
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "Try again.", "error");
    } finally {
      setSaving(false);
    }
  }
  async function uploadLogo(file: File) {
    if (!product) return;
    try {
      const media = await cloudUpload<ReleaseMedia>(
        `release-media?${new URLSearchParams({ productId: product.id, name: file.name.slice(0, 200), role: "logo" })}`,
        file,
      );
      update({ logoMediaId: media.id });
    } catch (reason) {
      toast(
        reason instanceof Error ? reason.message : "The upload failed.",
        "error",
      );
    }
  }
  return (
    <div className="cloud-product-form">
      <section className="cloud-release-panel" aria-label="Brand kit">
        <h3>Brand kit</h3>
        <div className="grid gap-3 sm:grid-cols-[auto_1fr_1fr]">
          <div className="grid gap-2">
            <span className="text-xs font-medium">Logo</span>
            <button
              type="button"
              className="cloud-product-logo"
              style={{
                backgroundImage: `linear-gradient(135deg, ${input.brand.primary}, ${input.brand.accent})`,
              }}
              disabled={!product}
              title={
                product
                  ? "Upload logo"
                  : "Save the product before adding a logo."
              }
              onClick={() => logoInput.current?.click()}
            >
              {input.logoMediaId ? (
                <img src={mediaUrl(input.logoMediaId)} alt="Logo" />
              ) : (
                <ImagePlus size={18} aria-hidden="true" />
              )}
            </button>
            <input
              ref={logoInput}
              type="file"
              hidden
              accept="image/png,image/jpeg,image/webp"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void uploadLogo(file);
                event.target.value = "";
              }}
            />
          </div>
          <Field label="Name" htmlFor="product-name">
            <Input
              id="product-name"
              value={input.name}
              maxLength={80}
              onChange={(event) =>
                update({
                  name: event.target.value,
                  ...(product ? {} : { key: slug(event.target.value) }),
                })
              }
            />
          </Field>
          <Field label="Key" htmlFor="product-key">
            <Input
              id="product-key"
              value={input.key}
              maxLength={40}
              onChange={(event) => update({ key: slug(event.target.value) })}
            />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Tagline" htmlFor="product-tagline">
            <Input
              id="product-tagline"
              value={input.tagline}
              maxLength={160}
              onChange={(event) => update({ tagline: event.target.value })}
            />
          </Field>
          <Field label="Website" htmlFor="product-website">
            <Input
              id="product-website"
              type="url"
              value={input.website ?? ""}
              placeholder="https://"
              onChange={(event) =>
                update({ website: event.target.value || null })
              }
            />
          </Field>
        </div>
        <div className="cloud-product-colors">
          {colorFields.map(([key, label]) => (
            <label key={key}>
              <input
                type="color"
                value={input.brand[key]}
                onChange={(event) =>
                  update({
                    brand: { ...input.brand, [key]: event.target.value },
                  })
                }
              />
              <span>
                <strong>{label}</strong>
                <code>{input.brand[key]}</code>
              </span>
            </label>
          ))}
          <div
            className="cloud-product-swatch"
            style={{
              background: input.brand.background,
              color: input.brand.foreground,
              backgroundImage: `radial-gradient(circle at 90% 0%, ${input.brand.primary}88, transparent 60%)`,
            }}
          >
            <small style={{ color: input.brand.accent }}>NEW</small>
            <strong>{input.name || "Product"}</strong>
          </div>
        </div>
        <Field label="Description" htmlFor="product-description">
          <Textarea
            id="product-description"
            rows={2}
            maxLength={4_000}
            value={input.description}
            onChange={(event) => update({ description: event.target.value })}
          />
        </Field>
      </section>
      <section className="cloud-release-panel" aria-label="Voice">
        <h3>Voice</h3>
        <Field label="Style rules" htmlFor="product-voice">
          <Textarea
            id="product-voice"
            rows={4}
            maxLength={4_000}
            value={input.voice}
            placeholder={
              "Confident and concrete. No hype words.\nLead with the customer benefit.\nUse “you”, not “users”."
            }
            onChange={(event) => update({ voice: event.target.value })}
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Audience" htmlFor="product-audience">
            <Input
              id="product-audience"
              value={input.audience}
              maxLength={1_000}
              placeholder="Engineering leads at software teams"
              onChange={(event) => update({ audience: event.target.value })}
            />
          </Field>
          <Field label="Call to action" htmlFor="product-cta">
            <Input
              id="product-cta"
              value={input.callToAction}
              maxLength={200}
              placeholder="Try it free"
              onChange={(event) => update({ callToAction: event.target.value })}
            />
          </Field>
        </div>
        <Field label="Hashtags" htmlFor="product-hashtags">
          <Input
            id="product-hashtags"
            value={hashtags}
            placeholder="#machdoch #DevTools"
            onChange={(event) => setHashtags(event.target.value)}
          />
        </Field>
      </section>
      <section className="cloud-release-panel" aria-label="Production">
        <h3>Production</h3>
        <div className="grid gap-2">
          <span className="text-xs font-medium">Shipped work from</span>
          <div
            className="cloud-automation-chips"
            role="group"
            aria-label="Teams"
          >
            {workspace.teams.map((team) => (
              <button
                key={team.id}
                type="button"
                className="cloud-automation-chip"
                aria-pressed={input.teamIds.includes(team.id)}
                onClick={() =>
                  update({
                    teamIds: input.teamIds.includes(team.id)
                      ? input.teamIds.filter((id) => id !== team.id)
                      : [...input.teamIds, team.id],
                  })
                }
              >
                {team.name}
              </button>
            ))}
          </div>
        </div>
        <Field label="Sandbox brief" htmlFor="product-capture">
          <Textarea
            id="product-capture"
            rows={4}
            maxLength={8_000}
            value={input.captureBrief}
            placeholder={
              "Run `pnpm dev:ui` — it starts with fixture data.\nSign in as demo@example.test.\nUse the dark theme at 1920×1080."
            }
            onChange={(event) => update({ captureBrief: event.target.value })}
          />
        </Field>
        <Field label="Visual style" htmlFor="product-style">
          <Textarea
            id="product-style"
            rows={2}
            maxLength={4_000}
            value={input.visualStyle}
            placeholder="Calm dark surfaces, one accent color, product UI in focus."
            onChange={(event) => update({ visualStyle: event.target.value })}
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Video intro seconds" htmlFor="product-intro">
            <Input
              id="product-intro"
              type="number"
              min={0}
              max={8}
              step={0.5}
              value={input.video.introSeconds}
              onChange={(event) =>
                update({
                  video: {
                    ...input.video,
                    introSeconds: Number(event.target.value),
                  },
                })
              }
            />
          </Field>
          <Field label="Video outro seconds" htmlFor="product-outro">
            <Input
              id="product-outro"
              type="number"
              min={0}
              max={8}
              step={0.5}
              value={input.video.outroSeconds}
              onChange={(event) =>
                update({
                  video: {
                    ...input.video,
                    outroSeconds: Number(event.target.value),
                  },
                })
              }
            />
          </Field>
        </div>
        <Label className="cloud-automation-check">
          <input
            type="checkbox"
            checked={input.membersCanPublish}
            onChange={(event) =>
              update({ membersCanPublish: event.target.checked })
            }
          />
          Members can schedule and publish posts
        </Label>
      </section>
      <div className="cloud-release-actions">
        <Button
          disabled={saving || !input.name.trim() || input.key.length < 2}
          onClick={() => void save()}
        >
          {product ? "Save product" : "Create product"}
        </Button>
      </div>
    </div>
  );
}

export function ProductList({
  workspace,
  initial,
}: {
  workspace: CloudWorkspace;
  initial: CloudProduct[];
}) {
  const toast = useToast();
  const [products, setProducts] = useState(initial);
  const [selectedId, setSelectedId] = useState<string | "new" | null>(
    initial[0]?.id ?? "new",
  );
  const [channels, setChannels] = useState<CloudChannel[]>([]);
  const [accounts, setAccounts] = useState<SocialAccount[]>([]);
  const [editor, setEditor] = useState<{
    kind: ChannelKind;
    channel?: CloudChannel;
  } | null>(null);
  const admin = ["owner", "admin"].includes(workspace.actor.role);
  const selected =
    products.find((product) => product.id === selectedId) ?? null;
  const loadChannels = useCallback(async (id: string) => {
    const result = await cloudRequest<{ channels: CloudChannel[] }>(
      `products/${id}`,
    );
    setChannels(result.channels);
  }, []);
  useEffect(() => {
    if (!selected) {
      setChannels([]);
      return;
    }
    void loadChannels(selected.id).catch((reason: Error) =>
      toast(reason.message, "error"),
    );
  }, [selected, loadChannels, toast]);
  useEffect(() => {
    void cloudRequest<SocialAccount[]>("social/accounts")
      .then(setAccounts)
      .catch(() => setAccounts([]));
  }, []);
  async function reload(id: string) {
    const next = await cloudRequest<CloudProduct[]>("products");
    setProducts(next);
    setSelectedId(id);
  }
  return (
    <>
      <header className="cloud-page-header">
        <h1>Products</h1>
        {admin && (
          <Button onClick={() => setSelectedId("new")}>
            <Plus />
            New product
          </Button>
        )}
      </header>
      <ReleaseSections admin={admin} />
      <div className="cloud-automation-layout cloud-product-layout">
        <ul className="cloud-automation-list" aria-label="Products">
          {products.map((product) => (
            <li
              key={product.id}
              aria-current={product.id === selectedId || undefined}
            >
              <button
                type="button"
                className="cloud-automation-row-button"
                onClick={() => setSelectedId(product.id)}
              >
                <span
                  className="cloud-release-badge"
                  style={{
                    backgroundImage: `linear-gradient(135deg, ${product.brand.primary}, ${product.brand.accent})`,
                  }}
                >
                  {product.name.slice(0, 1).toUpperCase()}
                </span>
                <span className="cloud-automation-row-text">
                  <strong>{product.name}</strong>
                  <span>
                    {product.channelCount}{" "}
                    {product.channelCount === 1 ? "channel" : "channels"} ·{" "}
                    {product.releaseCount}{" "}
                    {product.releaseCount === 1 ? "release" : "releases"}
                  </span>
                </span>
              </button>
            </li>
          ))}
          {!products.length && (
            <li className="cloud-product-empty">
              <Package size={16} aria-hidden="true" />
              <span>No products yet.</span>
            </li>
          )}
        </ul>
        <div className="cloud-product-detail">
          {admin && (selectedId === "new" || selected) && (
            <ProductForm
              key={selected?.id ?? "new"}
              workspace={workspace}
              product={selected}
              onSaved={reload}
            />
          )}
          {!admin && selected && (
            <p className="cloud-automation-muted">
              Ask an administrator to change {selected.name}.
            </p>
          )}
          {selected && (
            <section className="cloud-release-panel" aria-label="Channels">
              <div className="cloud-automation-template-heading">
                <h3>Channels</h3>
                {admin && (
                  <PropertyMenu
                    label="Add channel"
                    options={(["linkedin", "reddit", "webhook"] as const).map(
                      (kind) => ({
                        value: kind,
                        label: channelKindLabels[kind],
                        icon: <ChannelMark kind={kind} />,
                      }),
                    )}
                    onSelect={(kind) =>
                      setEditor({ kind: kind as ChannelKind })
                    }
                    align="end"
                  >
                    <Button variant="outline" size="sm">
                      <Plus />
                      Add channel
                    </Button>
                  </PropertyMenu>
                )}
              </div>
              {channels.length ? (
                <ul className="cloud-channel-list">
                  {channels.map((channel) => (
                    <li
                      key={channel.id}
                      data-enabled={channel.enabled || undefined}
                    >
                      <ChannelMark kind={channel.kind} />
                      <div>
                        <strong>{channel.name}</strong>
                        <span>
                          {channel.kind === "linkedin"
                            ? channel.authorName
                            : channel.kind === "reddit"
                              ? channel.subreddits
                                  .map((entry) => `r/${entry.name}`)
                                  .join(", ")
                              : channel.webhookHost}
                          {!channel.enabled && " · Disabled"}
                          {channel.requiresApproval && " · Needs approval"}
                        </span>
                      </div>
                      <span className="cloud-automation-spacer" />
                      {admin && (
                        <>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Edit ${channel.name}`}
                            onClick={() =>
                              setEditor({ kind: channel.kind, channel })
                            }
                          >
                            <Pencil />
                          </Button>
                          <ConfirmButton
                            trigger={
                              <Button
                                variant="ghost"
                                size="icon"
                                aria-label={`Delete ${channel.name}`}
                              >
                                <Trash2 />
                              </Button>
                            }
                            title="Delete channel?"
                            description="Its draft posts are deleted too."
                            actionLabel="Delete"
                            onConfirm={async () => {
                              await cloudRequest(`channels/${channel.id}`, {
                                method: "DELETE",
                              });
                              await loadChannels(selected.id);
                            }}
                          />
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="cloud-automation-muted">No channels yet.</p>
              )}
            </section>
          )}
        </div>
      </div>
      {editor && selected && (
        <ChannelEditor
          productId={selected.id}
          kind={editor.kind}
          channel={editor.channel}
          accounts={accounts}
          onClose={() => setEditor(null)}
          onSaved={async () => {
            await loadChannels(selected.id);
            await reload(selected.id);
          }}
        />
      )}
    </>
  );
}
