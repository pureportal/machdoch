import { z } from "zod";
import { releaseHighlightSchema } from "../../../lib/cloud-release-contract";
import {
  visualFormatKeys,
  visualTemplates,
} from "../../../lib/cloud-release-media-contract";
import { composePost, releaseTitle } from "../../../lib/release-posts";
import { AgentLookupError } from "./agent-workspace";
import { agentTool, type AgentTool } from "./agent-tool";
import {
  field,
  markdownField,
  pendingOutput,
  reference,
} from "./agent-proposal-helpers";
import type { CloudAgentSession } from "./agent-tools";

const releaseReference = reference.describe(
  'Release ID, version such as "42.1", or product and version such as "machdoch 42.1".',
);

async function resolveRelease(session: CloudAgentSession, value: string) {
  const match = await session.services.releases.find(session.actor, value);
  if (!match)
    throw new AgentLookupError(
      `No release matches ${value}. List releases with get_release using an ID or version.`,
    );
  return session.services.releases.get(session.actor, match.id);
}

export const releaseTools: AgentTool[] = [
  agentTool({
    name: "get_release",
    description:
      "Read a release: product voice and brand rules, notes, highlights, shipped issues, channels with their writing rules, current post drafts and available media.",
    schema: z.strictObject({ release: releaseReference }),
    async run(session, input) {
      const release = await resolveRelease(session, input.release);
      const { product, channels } = await session.services.products.get(
        session.actor,
        release.productId,
      );
      const media = await session.services.releaseMedia.list(session.actor, {
        productId: release.productId,
        releaseId: release.id,
      });
      return {
        label: `Read ${releaseTitle(product, release)}`,
        output: {
          id: release.id,
          title: releaseTitle(product, release),
          status: release.status,
          revision: release.revision,
          summary: release.summary,
          notes: release.notes,
          highlights: release.highlights,
          product: {
            name: product.name,
            tagline: product.tagline,
            description: product.description,
            voice: product.voice,
            audience: product.audience,
            hashtags: product.hashtags,
            callToAction: product.callToAction,
            website: product.website,
            visualStyle: product.visualStyle,
          },
          shipped: release.items
            .filter((item) => item.included)
            .map((item) => ({
              identifier: item.identifier,
              title: item.title,
            })),
          channels: channels.map((channel) => ({
            id: channel.id,
            name: channel.name,
            kind: channel.kind,
            enabled: channel.enabled,
            rules: channel.rules,
            subreddits:
              channel.kind === "reddit" ? channel.subreddits : undefined,
          })),
          posts: release.posts.map((post) => ({
            channel: post.channelName,
            state: post.state,
            title: post.title,
            body: post.body,
            mediaIds: post.mediaIds,
          })),
          media: media.map((entry) => ({
            id: entry.id,
            kind: entry.kind,
            role: entry.role,
            caption: entry.caption,
            size:
              entry.width && entry.height
                ? `${entry.width}×${entry.height}`
                : null,
          })),
        },
      };
    },
  }),
  agentTool({
    name: "propose_release_notes",
    description:
      "Propose the release summary, customer-facing notes in Markdown and 3–6 highlights. Nothing changes until the proposal is applied.",
    schema: z.strictObject({
      release: releaseReference,
      summary: z.string().trim().min(1).max(1_000),
      notes: z.string().trim().min(1).max(40_000),
      highlights: z.array(releaseHighlightSchema).min(1).max(8),
    }),
    async run(session, input) {
      const release = await resolveRelease(session, input.release);
      const label = releaseTitle({ name: release.productName }, release);
      return {
        output: pendingOutput,
        label: `Drafted notes for ${label}`,
        proposal: {
          kind: "release_notes",
          title: `Release notes · ${label}`,
          fields: [
            ...field("Summary", input.summary),
            ...field(
              "Highlights",
              input.highlights.map((entry) => entry.title).join(" · "),
            ),
            ...markdownField("Notes", input.notes),
          ],
          releaseId: release.id,
          releaseLabel: label,
          revision: release.revision,
          summary: input.summary,
          notes: input.notes,
          highlights: input.highlights,
        },
      };
    },
  }),
  agentTool({
    name: "propose_release_post",
    description:
      "Propose the post for one channel of a release, written natively for that network and within its rules. Reddit posts need a title. Nothing is published until a person approves and publishes it.",
    schema: z.strictObject({
      release: releaseReference,
      channel: reference.describe("Channel name or ID."),
      title: z.string().trim().max(300).optional(),
      body: z.string().trim().min(1).max(40_000),
      mediaIds: z.array(z.uuid()).max(9).optional(),
      link: z.url({ protocol: /^https$/ }).optional(),
    }),
    async run(session, input) {
      const release = await resolveRelease(session, input.release);
      const value = input.channel.trim().toLowerCase();
      const post = release.posts.find(
        (entry) =>
          entry.channelId === value ||
          entry.channelName.toLowerCase() === value,
      );
      if (!post)
        throw new AgentLookupError(
          `No channel named ${input.channel}. Channels: ${release.posts.map((entry) => entry.channelName).join(", ")}.`,
        );
      if (["publishing", "published"].includes(post.state))
        throw new AgentLookupError(
          `The ${post.channelName} post is already published.`,
        );
      const { product, channels } = await session.services.products.get(
        session.actor,
        release.productId,
      );
      const channel = channels.find((entry) => entry.id === post.channelId)!;
      if (channel.kind === "reddit" && !input.title?.trim())
        throw new AgentLookupError("Reddit posts need a title.");
      const link = input.link ?? product.website;
      const composed = composePost(
        channel.kind,
        channel.rules,
        { title: input.title ?? "", body: input.body, link },
        product,
        releaseTitle(product, release),
      );
      const label = releaseTitle(product, release);
      return {
        output: {
          ...pendingOutput,
          length: composed.length,
          limit: composed.limit,
          ...(composed.truncated
            ? {
                warning:
                  "The post exceeds the channel limit and will be shortened. Propose a shorter version.",
              }
            : {}),
        },
        label: `Drafted the ${post.channelName} post`,
        proposal: {
          kind: "release_post",
          title: `${post.channelName} post · ${label}`,
          fields: [
            ...field("Title", input.title),
            ...markdownField("Post", input.body),
          ],
          releaseId: release.id,
          releaseLabel: label,
          postId: post.id,
          channelName: post.channelName,
          revision: post.revision,
          postTitle: input.title ?? "",
          body: input.body,
          mediaIds: input.mediaIds ?? post.mediaIds,
          link: link ?? null,
        },
      };
    },
  }),
  agentTool({
    name: "propose_release_visual",
    description:
      "Propose a branded visual rendered from the product's brand kit: announcement, spotlight (frames a screenshot from mediaId), highlights (a numbered list) or quote. Choose the format that matches the channels and attach it to their posts.",
    schema: z.strictObject({
      release: releaseReference,
      template: z.enum(visualTemplates),
      format: z.enum(visualFormatKeys),
      eyebrow: z.string().trim().max(60).optional(),
      headline: z.string().trim().min(1).max(140),
      subline: z.string().trim().max(240).optional(),
      items: z.array(z.string().trim().min(1).max(90)).max(5).optional(),
      mediaId: z
        .uuid()
        .optional()
        .describe("Screenshot for the spotlight template."),
      theme: z.enum(["brand", "dark", "light"]).optional(),
      attachTo: z
        .array(reference)
        .max(10)
        .optional()
        .describe("Channel names whose posts should show this visual."),
    }),
    async run(session, input) {
      const release = await resolveRelease(session, input.release);
      if (input.template === "spotlight" && !input.mediaId)
        throw new AgentLookupError(
          "The spotlight template needs a screenshot mediaId.",
        );
      const attach = (input.attachTo ?? []).map((name) => {
        const post = release.posts.find(
          (entry) =>
            entry.channelName.toLowerCase() === name.trim().toLowerCase(),
        );
        if (!post) throw new AgentLookupError(`No channel named ${name}.`);
        return post;
      });
      const label = releaseTitle({ name: release.productName }, release);
      return {
        output: pendingOutput,
        label: `Designed a ${input.template} visual`,
        proposal: {
          kind: "release_visual",
          title: `${input.template[0]!.toUpperCase()}${input.template.slice(1)} visual · ${label}`,
          fields: [
            ...field("Headline", input.headline),
            ...field("Format", input.format),
            ...field(
              "Attach to",
              attach.map((post) => post.channelName).join(", "),
            ),
          ],
          releaseId: release.id,
          releaseLabel: label,
          visual: {
            template: input.template,
            format: input.format,
            eyebrow: input.eyebrow ?? "",
            headline: input.headline,
            subline: input.subline ?? "",
            items: input.items ?? [],
            mediaId: input.mediaId ?? null,
            theme: input.theme ?? "brand",
          },
          attachPostIds: attach.map((post) => post.id),
        },
      };
    },
  }),
];
