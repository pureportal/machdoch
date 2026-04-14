---
name: Security defaults
description: Apply when the task involves secrets, authentication, package installation, or elevated access.
applyTo: "**/*"
keywords: ["security", "secret", "auth", "token", "install", "sudo", "admin"]
priority: 90
---

# Security defaults

- Avoid printing secrets to logs or terminal output.
- Prefer read-only checks before package installation or system changes.
- Explain why elevated access is needed before requesting it.
- Treat package installation as a risky action that may require approval.
