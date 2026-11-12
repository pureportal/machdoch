import type {
  SocialNetwork,
  SocialTarget,
  SubredditFlair,
} from "../../../lib/cloud-release-contract";

export const linkedInVersion = "202610";
const linkedInApi = "https://api.linkedin.com";
const redditApi = "https://oauth.reddit.com";
const redditUserAgent = "web:machdoch-cloud:42 (release publishing)";
const requestTimeoutMs = 30_000;

export class SocialApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface SocialTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
}

export interface OAuthApp {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  organizationPages: boolean;
}

export interface SocialIdentity {
  externalId: string;
  name: string;
}

type Transport = typeof fetch;

async function request(
  transport: Transport,
  url: string,
  init: RequestInit,
): Promise<Response> {
  let response: Response;
  try {
    response = await transport(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
  } catch {
    throw new SocialApiError(503, "The network could not be reached.");
  }
  if (response.ok) return response;
  const body = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  const detail =
    body?.message ??
    body?.error_description ??
    body?.error ??
    body?.explanation;
  throw new SocialApiError(
    response.status,
    typeof detail === "string" && detail.trim()
      ? detail.trim().slice(0, 300)
      : `The network responded with status ${response.status}.`,
  );
}

function tokens(body: Record<string, unknown>): SocialTokens {
  if (typeof body.access_token !== "string")
    throw new SocialApiError(502, "The network returned no access token.");
  return {
    accessToken: body.access_token,
    refreshToken:
      typeof body.refresh_token === "string" ? body.refresh_token : null,
    expiresAt:
      typeof body.expires_in === "number"
        ? Date.now() + body.expires_in * 1000
        : null,
  };
}

export const linkedInScopes = (app: OAuthApp) =>
  [
    "openid",
    "profile",
    "w_member_social",
    ...(app.organizationPages
      ? ["w_organization_social", "r_organization_admin"]
      : []),
  ].join(" ");

export const redditScopes = "identity submit read flair";

export function authorizeUrl(
  network: SocialNetwork,
  app: OAuthApp,
  state: string,
): string {
  const url = new URL(
    network === "linkedin"
      ? "https://www.linkedin.com/oauth/v2/authorization"
      : "https://www.reddit.com/api/v1/authorize",
  );
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", app.clientId);
  url.searchParams.set("redirect_uri", app.redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set(
    "scope",
    network === "linkedin" ? linkedInScopes(app) : redditScopes,
  );
  if (network === "reddit") url.searchParams.set("duration", "permanent");
  return url.toString();
}

export class LinkedInClient {
  constructor(private readonly transport: Transport) {}

  private headers(token: string, json = true): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      "LinkedIn-Version": linkedInVersion,
      "X-Restli-Protocol-Version": "2.0.0",
      ...(json ? { "Content-Type": "application/json" } : {}),
    };
  }

  private async token(
    app: OAuthApp,
    form: Record<string, string>,
  ): Promise<SocialTokens> {
    const response = await request(
      this.transport,
      "https://www.linkedin.com/oauth/v2/accessToken",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          ...form,
          client_id: app.clientId,
          client_secret: app.clientSecret,
        }),
      },
    );
    return tokens((await response.json()) as Record<string, unknown>);
  }

  exchange(app: OAuthApp, code: string): Promise<SocialTokens> {
    return this.token(app, {
      grant_type: "authorization_code",
      code,
      redirect_uri: app.redirectUri,
    });
  }

  refresh(app: OAuthApp, refreshToken: string): Promise<SocialTokens> {
    return this.token(app, {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
  }

  async identity(token: string): Promise<SocialIdentity> {
    const response = await request(
      this.transport,
      `${linkedInApi}/v2/userinfo`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const body = (await response.json()) as { sub?: string; name?: string };
    if (!body.sub)
      throw new SocialApiError(502, "LinkedIn returned no member ID.");
    return {
      externalId: body.sub,
      name: body.name?.trim() || "LinkedIn member",
    };
  }

  async targets(
    token: string,
    identity: SocialIdentity,
  ): Promise<SocialTarget[]> {
    const person: SocialTarget = {
      urn: `urn:li:person:${identity.externalId}`,
      name: identity.name,
      kind: "person",
    };
    let acl: Response;
    try {
      acl = await request(
        this.transport,
        `${linkedInApi}/rest/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED&count=50`,
        { headers: this.headers(token, false) },
      );
    } catch (error) {
      if (error instanceof SocialApiError && error.status === 403)
        return [person];
      throw error;
    }
    const organizations = (
      ((await acl.json()) as { elements?: { organization?: string }[] })
        .elements ?? []
    )
      .map((entry) => entry.organization)
      .filter((urn): urn is string => typeof urn === "string");
    const pages: SocialTarget[] = [];
    for (const urn of organizations) {
      const id = urn.split(":").at(-1)!;
      const response = await request(
        this.transport,
        `${linkedInApi}/rest/organizations/${encodeURIComponent(id)}`,
        { headers: this.headers(token, false) },
      );
      const body = (await response.json()) as { localizedName?: string };
      pages.push({
        urn,
        name: body.localizedName?.trim() || urn,
        kind: "organization",
      });
    }
    return [person, ...pages];
  }

  async uploadImage(
    token: string,
    owner: string,
    bytes: Buffer,
  ): Promise<string> {
    const init = await request(
      this.transport,
      `${linkedInApi}/rest/images?action=initializeUpload`,
      {
        method: "POST",
        headers: this.headers(token),
        body: JSON.stringify({ initializeUploadRequest: { owner } }),
      },
    );
    const { value } = (await init.json()) as {
      value?: { uploadUrl?: string; image?: string };
    };
    if (!value?.uploadUrl || !value.image)
      throw new SocialApiError(502, "LinkedIn returned no image upload.");
    await request(this.transport, value.uploadUrl, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/octet-stream",
      },
      body: new Uint8Array(bytes),
    });
    return value.image;
  }

  async uploadVideo(
    token: string,
    owner: string,
    bytes: Buffer,
  ): Promise<string> {
    const init = await request(
      this.transport,
      `${linkedInApi}/rest/videos?action=initializeUpload`,
      {
        method: "POST",
        headers: this.headers(token),
        body: JSON.stringify({
          initializeUploadRequest: {
            owner,
            fileSizeBytes: bytes.length,
            uploadCaptions: false,
            uploadThumbnail: false,
          },
        }),
      },
    );
    const { value } = (await init.json()) as {
      value?: {
        video?: string;
        uploadToken?: string;
        uploadInstructions?: {
          uploadUrl: string;
          firstByte: number;
          lastByte: number;
        }[];
      };
    };
    if (!value?.video || !value.uploadInstructions?.length)
      throw new SocialApiError(502, "LinkedIn returned no video upload.");
    const partIds: string[] = [];
    for (const part of value.uploadInstructions) {
      const response = await request(this.transport, part.uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(bytes.subarray(part.firstByte, part.lastByte + 1)),
      });
      const etag = response.headers.get("etag");
      if (!etag)
        throw new SocialApiError(502, "LinkedIn did not confirm a video part.");
      partIds.push(etag.replaceAll('"', ""));
    }
    await request(
      this.transport,
      `${linkedInApi}/rest/videos?action=finalizeUpload`,
      {
        method: "POST",
        headers: this.headers(token),
        body: JSON.stringify({
          finalizeUploadRequest: {
            video: value.video,
            uploadToken: value.uploadToken ?? "",
            uploadedPartIds: partIds,
          },
        }),
      },
    );
    return value.video;
  }

  async createPost(
    token: string,
    post: {
      author: string;
      commentary: string;
      media:
        | { kind: "none" }
        | { kind: "single"; id: string; title: string; altText: string }
        | { kind: "multi"; images: { id: string; altText: string }[] };
    },
  ): Promise<{ id: string; url: string }> {
    const content =
      post.media.kind === "single"
        ? {
            media: {
              id: post.media.id,
              title: post.media.title,
              ...(post.media.altText ? { altText: post.media.altText } : {}),
            },
          }
        : post.media.kind === "multi"
          ? {
              multiImage: {
                images: post.media.images.map((image) => ({
                  id: image.id,
                  ...(image.altText ? { altText: image.altText } : {}),
                })),
              },
            }
          : undefined;
    const response = await request(
      this.transport,
      `${linkedInApi}/rest/posts`,
      {
        method: "POST",
        headers: this.headers(token),
        body: JSON.stringify({
          author: post.author,
          commentary: post.commentary,
          visibility: "PUBLIC",
          distribution: {
            feedDistribution: "MAIN_FEED",
            targetEntities: [],
            thirdPartyDistributionChannels: [],
          },
          ...(content ? { content } : {}),
          lifecycleState: "PUBLISHED",
          isReshareDisabledByAuthor: false,
        }),
      },
    );
    const id = response.headers.get("x-restli-id");
    if (!id) throw new SocialApiError(502, "LinkedIn returned no post ID.");
    return { id, url: `https://www.linkedin.com/feed/update/${id}/` };
  }
}

export class RedditClient {
  constructor(private readonly transport: Transport) {}

  private headers(token: string): Record<string, string> {
    return { Authorization: `Bearer ${token}`, "User-Agent": redditUserAgent };
  }

  private async token(
    app: OAuthApp,
    form: Record<string, string>,
  ): Promise<SocialTokens> {
    const response = await request(
      this.transport,
      "https://www.reddit.com/api/v1/access_token",
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": redditUserAgent,
        },
        body: new URLSearchParams(form),
      },
    );
    const body = (await response.json()) as Record<string, unknown>;
    if (typeof body.error === "string")
      throw new SocialApiError(
        400,
        `Reddit rejected the sign-in (${body.error}).`,
      );
    return tokens(body);
  }

  exchange(app: OAuthApp, code: string): Promise<SocialTokens> {
    return this.token(app, {
      grant_type: "authorization_code",
      code,
      redirect_uri: app.redirectUri,
    });
  }

  refresh(app: OAuthApp, refreshToken: string): Promise<SocialTokens> {
    return this.token(app, {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
  }

  async identity(token: string): Promise<SocialIdentity> {
    const response = await request(this.transport, `${redditApi}/api/v1/me`, {
      headers: this.headers(token),
    });
    const body = (await response.json()) as { name?: string };
    if (!body.name)
      throw new SocialApiError(502, "Reddit returned no account name.");
    return { externalId: body.name, name: `u/${body.name}` };
  }

  async flairs(token: string, subreddit: string): Promise<SubredditFlair[]> {
    try {
      const response = await request(
        this.transport,
        `${redditApi}/r/${encodeURIComponent(subreddit)}/api/link_flair_v2`,
        { headers: this.headers(token) },
      );
      return ((await response.json()) as { id?: string; text?: string }[])
        .filter((flair) => flair.id && flair.text)
        .map((flair) => ({ id: flair.id!, text: flair.text! }));
    } catch (error) {
      if (error instanceof SocialApiError && [403, 404].includes(error.status))
        return [];
      throw error;
    }
  }

  async uploadImage(
    token: string,
    bytes: Buffer,
    name: string,
    mime: string,
  ): Promise<string> {
    const lease = await request(
      this.transport,
      `${redditApi}/api/media/asset.json`,
      {
        method: "POST",
        headers: {
          ...this.headers(token),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ filepath: name, mimetype: mime }),
      },
    );
    const body = (await lease.json()) as {
      args?: { action?: string; fields?: { name: string; value: string }[] };
    };
    const action = body.args?.action;
    const fields = body.args?.fields ?? [];
    const key = fields.find((field) => field.name === "key")?.value;
    if (!action || !key)
      throw new SocialApiError(502, "Reddit returned no image upload.");
    const uploadUrl = action.startsWith("//") ? `https:${action}` : action;
    const form = new FormData();
    for (const field of fields) form.append(field.name, field.value);
    form.append(
      "file",
      new Blob([new Uint8Array(bytes)], { type: mime }),
      name,
    );
    await request(this.transport, uploadUrl, { method: "POST", body: form });
    return `${uploadUrl}/${key}`;
  }

  async submit(
    token: string,
    post: {
      subreddit: string;
      kind: "self" | "link" | "image";
      title: string;
      text?: string;
      url?: string;
      flairId: string | null;
      flairText: string | null;
    },
  ): Promise<{ id: string; url: string }> {
    const form = new URLSearchParams({
      api_type: "json",
      sr: post.subreddit,
      kind: post.kind,
      title: post.title,
      resubmit: "true",
      sendreplies: "true",
    });
    if (post.kind === "self") form.set("text", post.text ?? "");
    else form.set("url", post.url ?? "");
    if (post.flairId) form.set("flair_id", post.flairId);
    if (post.flairText) form.set("flair_text", post.flairText);
    const response = await request(this.transport, `${redditApi}/api/submit`, {
      method: "POST",
      headers: {
        ...this.headers(token),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form,
    });
    const body = (await response.json()) as {
      json?: {
        errors?: [string, string, string?][];
        data?: {
          id?: string;
          name?: string;
          url?: string;
          user_submitted_page?: string;
        };
      };
    };
    const errors = body.json?.errors ?? [];
    if (errors.length)
      throw new SocialApiError(
        422,
        errors
          .map((entry) => entry[1] || entry[0])
          .join(" ")
          .slice(0, 300),
      );
    const data = body.json?.data ?? {};
    return {
      id: data.name ?? data.id ?? "",
      url:
        data.url ??
        data.user_submitted_page ??
        `https://www.reddit.com/r/${post.subreddit}/new/`,
    };
  }
}
