# Android full-resource client

Release: android/release/Stronghold-Protocol-Emi41-20261025-Full-Universal.apk

Minimum Android: 5.0 (API 21). Universal ABIs: armeabi-v7a, arm64-v8a, x86 and x86_64.
The client uses a capable system WebView when available and bundled GeckoView 143 otherwise.
The 64-bit bundled libraries have 16 KB ELF load alignment. No external resource pack is required.
The APK includes fonts, required/voice/optional manifest resources and annihilation art.

Packaging pipeline: bootstrap.py -> prepare_assets.py (initial staging only) -> bundle_webfonts.py ->
finalize_site.py -> Gradle :app:assembleRelease -> package_release.py.
All files under assets/site are ZIP_STORED for direct AssetManager access.
package_release.py performs zip alignment, APK v1/v2/v3 signing and one final packaging check.

Keep android/.private-signing/release.jks and release.pass private and backed up together.
Do not delete or replace that key: future in-place APK updates must use the same signer.
The signer is excluded from the APK and restricted to the current Windows account.
Build outputs do not constitute a physical-device compatibility test.

This directory packages the existing browser client without changing server or battle rules.
Only public client assets, shared browser modules, simulation modules and public game data may ship.
Account stores, player history, deployment scripts, SSH credentials and server configuration must never ship.
The Android client connects to the existing live game servers; it is not an offline server.

Build inputs and outputs are kept under `.tmp-mod-analysis-20261025/android-full-20261025/`.
