# Markdown clipboard verification

Code-block copying now reports unavailable clipboard access and rejected writes beside the affected block. Retrying clears the error after success. Unchanged Markdown stays mounted during snapshot refreshes, preserving copy feedback.

Verified on 13 September 2026 with the Product UI DOM suite: all 132 tests across 11 files passed, including clipboard availability, synchronous errors, asynchronous rejection, independent block state, exact whitespace, retry, the 1,500 ms success reset, and unchanged-content refreshes. Workspace lint and typechecks also passed.

Run the focused checks from this directory:

```powershell
pnpm test:dom -- src/markdown.dom.spec.tsx src/markdown-refresh.dom.spec.tsx
```

These tests mock clipboard access in jsdom. OS clipboard integration and assistive-technology announcements are not covered.
