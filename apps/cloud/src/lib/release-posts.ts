import type {
  ChannelKind,
  ChannelRules,
  PostState,
  ReleaseStatus,
} from "./cloud-release-contract";

export const channelLimits: Record<
  ChannelKind,
  { body: number; title: number | null; media: number }
> = {
  linkedin: { body: 3_000, title: null, media: 9 },
  reddit: { body: 40_000, title: 300, media: 1 },
  webhook: { body: 4_000, title: null, media: 4 },
};

export const discordContentLimit = 2_000;

export function defaultChannelRules(kind: ChannelKind): ChannelRules {
  if (kind === "linkedin")
    return {
      tone: "",
      maxLength: 1_300,
      hashtags: true,
      emoji: "light",
      includeLink: true,
      media: "landscape",
      instructions: "",
    };
  if (kind === "reddit")
    return {
      tone: "",
      maxLength: 4_000,
      hashtags: false,
      emoji: "none",
      includeLink: true,
      media: "wide",
      instructions: "",
    };
  return {
    tone: "",
    maxLength: 1_500,
    hashtags: false,
    emoji: "light",
    includeLink: true,
    media: "landscape",
    instructions: "",
  };
}

export interface ComposedPost {
  text: string;
  title: string;
  length: number;
  limit: number;
  truncated: boolean;
}

function hashtagLine(text: string, hashtags: string[]): string {
  const present = new Set(
    [...text.matchAll(/#([\p{L}\p{N}_]+)/gu)].map((match) =>
      match[1]!.toLowerCase(),
    ),
  );
  return hashtags
    .filter((tag) => !present.has(tag.toLowerCase()))
    .map((tag) => `#${tag}`)
    .join(" ");
}

export function composePost(
  kind: ChannelKind,
  rules: Pick<ChannelRules, "maxLength" | "hashtags" | "includeLink">,
  post: { title: string; body: string; link: string | null },
  product: { hashtags: string[] },
  fallbackTitle: string,
): ComposedPost {
  const limit = Math.min(rules.maxLength, channelLimits[kind].body);
  const titleLimit = channelLimits[kind].title;
  const title = (post.title.trim() || fallbackTitle).slice(
    0,
    titleLimit ?? 300,
  );
  if (!post.body.trim())
    return { text: "", title, length: 0, limit, truncated: false };
  const link =
    rules.includeLink && post.link && !post.body.includes(post.link)
      ? post.link
      : "";
  const tags =
    rules.hashtags && kind !== "reddit"
      ? hashtagLine(post.body, product.hashtags)
      : "";
  const suffix = [link, tags].filter(Boolean).join("\n\n");
  const reserved = suffix ? suffix.length + 2 : 0;
  let body = post.body.trim();
  let truncated = false;
  if (body.length + reserved > limit) {
    truncated = true;
    const room = Math.max(0, limit - reserved - 1);
    const cut = body.slice(0, room);
    const boundary = Math.max(cut.lastIndexOf("\n"), cut.lastIndexOf(" "));
    body = `${(boundary > room * 0.6 ? cut.slice(0, boundary) : cut).trimEnd()}…`;
  }
  const text = [body, suffix].filter(Boolean).join("\n\n");
  return { text, title, length: text.length, limit, truncated };
}

const littleTextReserved = /[\\|{}@[\]()<>#*_~]/g;

export function linkedInCommentary(text: string): string {
  return text
    .split(/(#[\p{L}\p{N}_]+)/u)
    .map((part) =>
      /^#[\p{L}\p{N}_]+$/u.test(part)
        ? `{hashtag|\\#|${part.slice(1)}}`
        : part.replace(littleTextReserved, (character) => `\\${character}`),
    )
    .join("");
}

export function releaseStatus(
  posts: { state: PostState; scheduledAt: string | null }[],
): ReleaseStatus {
  if (!posts.length) return "draft";
  const states = posts.map((post) => post.state);
  if (states.includes("failed")) return "attention";
  if (states.includes("publishing")) return "publishing";
  if (states.every((state) => state === "published")) return "published";
  if (states.includes("scheduled")) return "scheduled";
  if (states.every((state) => state === "approved" || state === "published"))
    return "ready";
  return states.some((state) => state !== "draft") ? "review" : "draft";
}

export function releaseTitle(
  product: { name: string },
  release: { version: string; name: string },
): string {
  const base = `${product.name} ${release.version}`.trim();
  return release.name ? `${base}: ${release.name}` : base;
}
