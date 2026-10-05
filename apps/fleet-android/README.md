# Fleet Android

The Android controller opens the existing Fleet Manager interface, including the shared Chat, RALPH, and Media Studio views. It connects to a self-hosted manager over HTTPS and uses its normal sign-in.

## Build

Install JDK 17 or newer and Android SDK platform 36 with build tools 36.1.0. Set `ANDROID_HOME` to the SDK directory, or set `sdk.dir` in an untracked `local.properties` file in this directory.

From the repository root:

```powershell
pnpm build:fleet-android
pnpm test:fleet-android
```

The checked-in Gradle wrapper downloads its pinned distribution. The app version comes from the repository's root `package.json`.

The installable development APK is `app/build/outputs/apk/debug/app-debug.apk`. The release build produces `app/build/outputs/apk/release/app-release-unsigned.apk`; sign it with your release key before distribution.

## Connect

Install the debug APK on Android 13 or newer. Open Fleet, enter the manager's HTTPS origin, and sign in. Enroll computers through the manager's existing enrollment flow.

The address must contain only the scheme, host, and optional port. Use a certificate trusted by Android's system certificate store. Certificate errors cannot be bypassed in the app.

Changing the manager closes the device view and clears this app's sign-in and web storage. File imports and exports use Android's file picker. Downloads are streamed to the selected file and limited to 512 MB. Keep Android System WebView updated to use downloads.

## Verification

Native unit tests check HTTPS origin validation and download origin restrictions. Node tests exercise binary streaming, cancellation, network failure, unsafe links, and the size limit. Android lint, debug builds, and optimized release builds run through Gradle.

Phone testing and a signed release are still required before distribution. See the [fleet verification report](../../docs/fleet-manager-verification-2026-10-05.md) for the broader outcome and remaining gaps.
