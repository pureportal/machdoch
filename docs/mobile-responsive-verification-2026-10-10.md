# Mobile layout and upload verification

Machdoch and Fleet Manager share compact composer controls based on available space. Model selection and Options occupy one row; phone layouts put message editing above the attachment and send actions. Short screens use smaller headers and scroll the composer when its controls expand. Session drawers and compact action menus preserve room for conversations. The application shell and dialogs follow the visible browser viewport, including keyboard height and browser panning.

The attachment error in the supplied screenshot came from requesting the workspace root with an empty path. Root and parent navigation send `"."`. Uploads use a mounted file input, clear the selection for retry, and retain the dialog when uploading fails. Switching sessions clears pending attachment state; late responses from the previous session cannot disable the new composer or display an old error.

Attachment browsing now uses full file rows and 44px folder selection targets. Long filenames wrap within the dialog. Playwright scrolled through 24 image entries on a 320px phone, tapped the edge of the last row and a folder selection target, and confirmed the corresponding paths reached the session.

Media Studio now mounts its browser file picker and removes it after selection, cancellation, or an opening error. Selected files display their original names. Playwright cancelled and reopened the picker, imported the first supplied screenshot through the production fleet relay, verified its bytes, checked transfer cleanup, and waited for the import dialog to close. The resulting image preview rendered successfully.

Playwright checked 320×740, 390×844, 920×414, 390×420, and desktop layouts using production builds. Checks covered overflow, reachable message and send controls, model pickers, options, session drawers, session actions, device details, and the fleet pages for workspaces, enrollment, settings, users, Copilot, and privacy.

Additional fleet workflows created a profile and saved an instruction with a simulated keyboard visible, reloaded the page to confirm the instruction persisted, and created an enrollment key through the phone dialog.

Keyboard checks kept the layout viewport at 390×844 while simulating a visible height of 360px and a 40px vertical offset. Both composers kept a 20-line draft and Send within that visible area. Model and attachment dialogs also fit, and closing the simulated keyboard preserved the draft. Pinch zoom and viewport cleanup have separate regression tests.

All three supplied screenshots uploaded through the browser file chooser and production fleet relay. Their received bytes matched the originals. A 1,179,665-byte file with a Unicode filename also matched after a four-chunk upload. An interruption after the first chunk released its temporary transfer, and selecting the same file again succeeded. A text file uploaded after an intentionally failed import. The fleet page recorded no browser exceptions.

This iteration passed 20 media transport, picker, and import dialog tests and six attachment UI tests, client UI and media studio type checks, lint and formatting checks for changed source and verification scripts, the client preview build, and the fleet production build.

The test used Chromium with mobile emulation and a simulated enrolled native device. Keyboard checks overrode VisualViewport height and offset; picker cancellation dispatched a browser `cancel` event. Physical Android/iOS keyboards, their native file pickers, and live desktop attachment and media storage remain unverified.

Run the browser checks after building both applications, from `apps/fleet-manager`:

```sh
node --import @oxc-node/core/register scripts/verify-mobile.mjs <image-file-paths>
```

The script accepts one or more image paths and starts isolated production test services. It closes them after validation.

- [Machdoch phone](validation/mobile-responsive/machdoch-chat-phone.png)
- [Machdoch landscape](validation/mobile-responsive/machdoch-chat-landscape.png)
- [Fleet chat phone](validation/mobile-responsive/fleet-chat-phone.png)
- [Fleet chat landscape](validation/mobile-responsive/fleet-chat-landscape.png)
- [Fleet chat short viewport](validation/mobile-responsive/fleet-chat-short.png)
- [Fleet overview phone](validation/mobile-responsive/fleet-overview-phone.png)
- [Uploaded images](validation/mobile-responsive/phone-image-uploads.png)
- [Fleet chat desktop](validation/mobile-responsive/fleet-chat-desktop.png)
- [Machdoch with a simulated keyboard](validation/mobile-responsive/machdoch-chat-keyboard.png)
- [Fleet chat with a simulated keyboard](validation/mobile-responsive/fleet-chat-keyboard.png)
- [Attachment browsing by touch](validation/mobile-responsive/fleet-attachment-browser-phone.png)
- [Media Studio phone picker](validation/mobile-responsive/fleet-media-phone-picker.png)
- [Media Studio imported image](validation/mobile-responsive/fleet-media-phone-import.png)
- [Fleet instruction with a simulated keyboard](validation/mobile-responsive/fleet-instruction-keyboard.png)
- [Measured results](validation/mobile-responsive/results.json)
