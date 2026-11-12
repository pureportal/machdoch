import { describe, expect, it } from "vitest";
import {
  composePost,
  defaultChannelRules,
  linkedInCommentary,
  releaseStatus,
  releaseTitle,
} from "./release-posts";
import { imageDimensions } from "./media-dimensions";

describe("composePost", () => {
  const product = { hashtags: ["machdoch", "AI"] };

  it("appends the link and missing hashtags for LinkedIn", () => {
    const post = composePost(
      "linkedin",
      defaultChannelRules("linkedin"),
      {
        title: "",
        body: "Automations are here. #AI",
        link: "https://machdoch.app",
      },
      product,
      "machdoch 42.1",
    );
    expect(post.text).toBe(
      "Automations are here. #AI\n\nhttps://machdoch.app\n\n#machdoch",
    );
    expect(post.title).toBe("machdoch 42.1");
    expect(post.truncated).toBe(false);
  });

  it("composes nothing for an empty body", () => {
    expect(
      composePost(
        "linkedin",
        defaultChannelRules("linkedin"),
        { title: "", body: "  ", link: "https://machdoch.app" },
        product,
        "machdoch 42.1",
      ),
    ).toMatchObject({ text: "", length: 0, title: "machdoch 42.1" });
  });

  it("never adds hashtags to Reddit and keeps titles within 300 characters", () => {
    const post = composePost(
      "reddit",
      defaultChannelRules("reddit"),
      { title: "x".repeat(400), body: "Details", link: null },
      product,
      "fallback",
    );
    expect(post.text).toBe("Details");
    expect(post.title).toHaveLength(300);
  });

  it("does not repeat a link that is already in the body", () => {
    const post = composePost(
      "webhook",
      { maxLength: 500, hashtags: false, includeLink: true },
      {
        title: "",
        body: "Read https://machdoch.app/blog",
        link: "https://machdoch.app/blog",
      },
      product,
      "t",
    );
    expect(post.text).toBe("Read https://machdoch.app/blog");
  });

  it("shortens long bodies at a word boundary while keeping the link and hashtags", () => {
    const body = Array.from({ length: 80 }, (_, index) => `word${index}`).join(
      " ",
    );
    const post = composePost(
      "linkedin",
      { maxLength: 200, hashtags: true, includeLink: true },
      { title: "", body, link: "https://machdoch.app" },
      product,
      "t",
    );
    expect(post.length).toBeLessThanOrEqual(200);
    expect(post.truncated).toBe(true);
    expect(post.text).toMatch(
      /word\d+…\n\nhttps:\/\/machdoch\.app\n\n#machdoch #AI$/,
    );
  });
});

describe("linkedInCommentary", () => {
  it("escapes reserved characters and converts hashtags to templates", () => {
    expect(
      linkedInCommentary("Faster (2x) builds_now @team #DevTools [beta]"),
    ).toBe(
      "Faster \\(2x\\) builds\\_now \\@team {hashtag|\\#|DevTools} \\[beta\\]",
    );
  });
});

describe("releaseStatus", () => {
  const post = (
    state: Parameters<typeof releaseStatus>[0][number]["state"],
  ) => ({
    state,
    scheduledAt: null,
  });

  it("derives the status from its posts", () => {
    expect(releaseStatus([])).toBe("draft");
    expect(releaseStatus([post("draft"), post("draft")])).toBe("draft");
    expect(releaseStatus([post("draft"), post("approved")])).toBe("review");
    expect(releaseStatus([post("approved"), post("published")])).toBe("ready");
    expect(releaseStatus([post("approved"), post("scheduled")])).toBe(
      "scheduled",
    );
    expect(releaseStatus([post("publishing"), post("scheduled")])).toBe(
      "publishing",
    );
    expect(releaseStatus([post("published"), post("published")])).toBe(
      "published",
    );
    expect(releaseStatus([post("published"), post("failed")])).toBe(
      "attention",
    );
  });

  it("names releases with their version and name", () => {
    expect(
      releaseTitle({ name: "machdoch" }, { version: "42.1", name: "" }),
    ).toBe("machdoch 42.1");
    expect(
      releaseTitle({ name: "mimorii" }, { version: "3.0", name: "Explainers" }),
    ).toBe("mimorii 3.0: Explainers");
  });
});

describe("imageDimensions", () => {
  it("reads PNG, JPEG and WebP headers", () => {
    const png = new Uint8Array(24);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    new DataView(png.buffer).setUint32(16, 1200);
    new DataView(png.buffer).setUint32(20, 627);
    expect(imageDimensions(png)).toEqual({ width: 1200, height: 627 });

    const jpeg = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11,
      0x08, 0x04, 0x38, 0x07, 0x80, 0x03,
    ]);
    expect(imageDimensions(jpeg)).toEqual({ width: 1920, height: 1080 });

    const webp = new Uint8Array(30);
    webp.set([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBPVP8X")]);
    webp.set([0x7f, 0x07, 0x00, 0x37, 0x04, 0x00], 24);
    expect(imageDimensions(webp)).toEqual({ width: 1920, height: 1080 });

    expect(imageDimensions(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});
