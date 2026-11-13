import assert from "node:assert/strict";
import test from "node:test";
import { gitRepositoryUrlSchema } from "./cloud-repository.ts";

void test("repository URLs accept short names and nested groups", () => {
  for (const url of [
    "https://github.com/a/b",
    "https://github.com/ab/cd",
    "https://gitlab.com/group/subgroup/project",
    "https://git.example.test:8443/team/app",
  ]) {
    assert.equal(gitRepositoryUrlSchema.safeParse(url).success, true, url);
  }
});

void test("repository URLs reject credentials and noncanonical paths", () => {
  for (const url of [
    "https://secret@github.com/team/app",
    "https://github.com/team/.",
    "https://github.com/team/..",
    "https://github.com/team/app?token=secret",
    "https://github.com/team/app#branch",
    "https://github.com/team/app/",
    "http://github.com/team/app",
  ]) {
    assert.equal(gitRepositoryUrlSchema.safeParse(url).success, false, url);
  }
});
