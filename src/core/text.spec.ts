import {
  createTokenSet,
  tokenSetIncludesKeyword,
  tokenizeText,
} from "./text.ts";

describe("tokenizeText", () => {
  it("lowercases text and splits on non-alphanumeric characters", () => {
    expect(tokenizeText("Read, FILES! Then-run_it?")).toEqual([
      "read",
      "files",
      "then",
      "run",
      "it",
    ]);
  });
});

describe("createTokenSet", () => {
  it("deduplicates repeated tokens", () => {
    expect(Array.from(createTokenSet("git git shell shell"))).toEqual([
      "git",
      "shell",
    ]);
  });
});

describe("tokenSetIncludesKeyword", () => {
  it("matches exact single-word tokens without partial-word matches", () => {
    const normalizedText = "authority review for the website";
    const tokens = createTokenSet(normalizedText);

    expect(tokenSetIncludesKeyword(tokens, normalizedText, "website")).toBe(
      true,
    );
    expect(tokenSetIncludesKeyword(tokens, normalizedText, "auth")).toBe(false);
  });

  it("matches multi-word phrases against normalized text", () => {
    const normalizedText = "create a pull request for the repo";
    const tokens = createTokenSet(normalizedText);

    expect(
      tokenSetIncludesKeyword(tokens, normalizedText, "pull request"),
    ).toBe(true);
  });

  it("returns false for blank keywords", () => {
    const normalizedText = "read the file";
    const tokens = createTokenSet(normalizedText);

    expect(tokenSetIncludesKeyword(tokens, normalizedText, "   ")).toBe(false);
  });
});
