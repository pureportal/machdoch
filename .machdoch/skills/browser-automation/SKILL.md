---
name: browser-automation
description: Automate browser tasks such as research, screenshots, form filling, and UI verification. Use when the task requires web interaction beyond a simple fetch.
argument-hint: "Target site and desired outcome"
user-invocable: true
disable-model-invocation: false
allowed-tools: "browser filesystem network"
---

# Browser automation

Use this skill when a task requires interactive browser control instead of a plain HTTP request.

## Guidelines

- Prefer read-only page inspection before interacting with forms.
- Capture enough context to explain what was clicked or extracted.
- Use screenshots or DOM/accessibility inspection for verification when possible.
