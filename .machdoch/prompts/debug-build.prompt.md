---
name: debug-build
description: Diagnose a build failure with minimal changes and clear verification steps.
argument-hint: "Describe the failure or paste the error output"
agent: agent
model: auto
tools: ["filesystem", "shell", "git"]
---

# Debug build

1. Inspect the workspace and identify the most likely cause of the build failure.
2. Prefer the smallest safe change that fixes the issue.
3. Verify with the smallest relevant command.
4. Summarize what changed and why.
