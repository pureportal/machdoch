# Upscaling UI review

The upscaling workspace now uses a compact settings column and a media browser that fills the main area. Source and result cards share one component, align on wide layouts, and stack when space is limited. Controls reuse the studio's searchable select, search field, notifications, generation jobs, asset previews, and save action.

Scale selection has a visible selected state and shows the output dimensions. Invalid settings disable both upscale actions. Import and running-job states lock the controls; changing media clears the previous result. Progress, cancellation, elapsed time, and Activity use the existing generation job component.

Validation on Windows, using the built desktop app and its local GPU runtime:

- 819 Media Studio tests passed after the final refactor.
- Media Studio type checking, lint, and formatting passed.
- Production UI and native desktop builds passed.
- All 18 [Playwright checks](playwright-results.json) passed, including real SPAN 4× image, Real-ESRGAN 2× video, SwinIR 2× image, failure recovery, cancellation, export, playback, keyboard selection, and Advanced/Activity actions. No renderer exceptions were recorded. The report includes the tested executable digest.
- [Before](before.png), [media browser](after-library.png), [image result](after-span-image-4x.png), [video result](after-realesrgan-video-2x.png), and [compact layout](after-width-1000.png).

Run `node docs/validation/upscalers/ui-review/verify-ui.mjs` with the isolated desktop verification build running on CDP port 9237. The script supplies paths to native file dialogs; import, inference, export, playback, and cancellation use the application handlers. No development server is required.

Scope: the Media Studio upscaling workspace and the compact shared asset browser. Validation covers Windows and small image/video fixtures; other platforms and long videos were not retested in this UI pass.
