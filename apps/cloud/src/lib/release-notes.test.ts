import { expect, it } from "vitest";
import { releaseNotes } from "./release-notes";

it("writes internal notes by team with evidence and external notes by title", () => {
  const notes = releaseNotes("Web 1.4.0", [
    {
      identifier: "WEB-10",
      title: "Faster search",
      team: "Web",
      pullRequests: [{ number: 12, url: "https://github.test/pull/12" }],
    },
    {
      identifier: "API-2",
      title: "Rate limits",
      team: "API",
      pullRequests: [],
    },
    {
      identifier: "WEB-9",
      title: "Faster search",
      team: "Web",
      pullRequests: [
        { number: 11, url: "https://github.test/pull/11" },
        { number: 13, url: "https://github.test/pull/13" },
      ],
    },
  ]);
  expect(notes.internal).toBe(
    [
      "# Web 1.4.0",
      "",
      "## API",
      "- API-2 Rate limits",
      "",
      "## Web",
      "- WEB-9 Faster search ([#11](https://github.test/pull/11), [#13](https://github.test/pull/13))",
      "- WEB-10 Faster search ([#12](https://github.test/pull/12))",
    ].join("\n"),
  );
  expect(notes.external).toBe(
    ["# Web 1.4.0", "", "- Rate limits", "- Faster search"].join("\n"),
  );
});
