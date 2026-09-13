# Model search IME verification

The model picker ignores Enter while an IME composition is active, including events with key code 229. Ordinary Enter after composition selects the first matching model. No-match queries keep the picker open, and clicking a result selects that result.

Verified on 13 September 2026 with the Product UI DOM suite: all 132 tests across 11 files passed, including the five model-search composition cases and composer submission regressions. Workspace lint and typechecks also passed.

Run the focused checks from this directory:

```powershell
pnpm test:dom -- src/composer-model-picker.dom.spec.tsx src/composer.dom.spec.tsx
```

These checks use synthetic DOM events. Physical IME keyboards and browser-specific composition behavior are not covered.
