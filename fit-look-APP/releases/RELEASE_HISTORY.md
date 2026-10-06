# Lookmefy Android release history

This file is the durable release baseline used for future APK/AAB builds and
comparison reports.

## 1.0.2 (Android versionCode 25)

- Release artifacts: `lookmefy-1.0.2-build25/lookmefy-1.0.2-25.apk` and
  `lookmefy-1.0.2-build25/lookmefy-1.0.2-25.aab`
- Convenience copies: `../mobile/release/lookmefy-v1.0.2-vc25.apk` and
  `../mobile/release/lookmefy-v1.0.2-vc25.aab`
- Artifact timestamp: 2026-09-28 IST
- APK size: 83,700,771 bytes; SHA-256:
  `f72050d6d7e86f4925e1d619e51ebedfb3afbd78f0896234e8cbb9bf5b70d317`
- AAB size: 62,595,052 bytes; SHA-256:
  `7aaf5d295819c8320db74c6a2f8c2d5d5c97643e5542b61eb17e98dc6951aa28`
- Package `com.lookmefy.app`; versionName `1.0.2`; versionCode `25`
- Minimum SDK 24; target/compile SDK 35; ABIs: arm64-v8a, armeabi-v7a, x86, x86_64
- APK and AAB upload certificate SHA-1:
  `4C:27:9B:A5:0B:3A:85:11:82:F5:DA:1B:8C:BB:B7:14:60:56:CB:75`
- Permissions match code 24: INTERNET, READ/WRITE_EXTERNAL_STORAGE,
  RECORD_AUDIO, SYSTEM_ALERT_WINDOW, VIBRATE, BILLING, FOREGROUND_SERVICE,
  FOREGROUND_SERVICE_MEDIA_PLAYBACK, CAMERA, ACCESS_NETWORK_STATE, and the
  app dynamic-receiver permission.
- Local Gradle assembleRelease and bundleRelease succeeded. The release pair
  passed package/version/signature/ZIP pre-upload checks and APK alignment.
  A release task without local signing properties failed before producing output.
- PDF report: `../../output/pdf/lookmefy-android-1.0.2-vc25-signing-comparison-2026-09-28.pdf`
  (SHA-256 `ccda4252bd8e92c1406262d489615fed3d71f9dfb6a3a25125f5975d9a86a4c1`)
- No Play upload or device smoke test was performed. The remote EAS credential
  remains different from Play's upload key, and Android release builds without
  local signing properties are blocked until EAS is corrected.

Compared with code 24, this build increments the version and uses Lookmefy's
original Play upload key instead of the debug key. No user-facing change was
intentionally made for this signing correction. The mobile directory is ignored
by the parent Git repository, limiting source-history comparison.

## 1.0.1 (Android versionCode 24; iOS build 24)

- Android release artifacts: `lookmefy-1.0.1-build24/lookmefy-1.0.1-24.apk`
  and `lookmefy-1.0.1-build24/lookmefy-1.0.1-24.aab`
- Android convenience copies: `../mobile/release/lookmefy-v1.0.1-vc24.apk`
  and `../mobile/release/lookmefy-v1.0.1-vc24.aab`
- iOS archive: `../mobile/release/lookmefy-ios-1.0.1-build24.xcarchive`
- Artifact timestamp: 2026-09-14 15:51 IST
- APK size: 83,822,286 bytes
- AAB size: 62,653,463 bytes
- APK SHA-256:
  `2985e4a80d90e47ca27299520978a2075f0eaaf7e8c9b40455cbc113fb87ffa5`
- AAB SHA-256:
  `4802bee40dfb39401d8645e0198a7ae965985045943b3486f0842a64c96c50d8`
- APK package: `com.lookmefy.app`
- APK version name: `1.0.1`
- APK minimum SDK: 24; target SDK: 35; compile SDK: 35
- Native ABIs: `arm64-v8a`, `armeabi-v7a`, `x86`, `x86_64`
- App icon: original Lookmefy LM/hanger launcher icon restored on both iOS and
  Android; the accidental Skillomate icon was removed from the build-24
  artifacts.
- Manifest permissions: `android.permission.INTERNET`,
  `android.permission.READ_EXTERNAL_STORAGE`,
  `android.permission.RECORD_AUDIO`,
  `android.permission.SYSTEM_ALERT_WINDOW`, `android.permission.VIBRATE`,
  `android.permission.WRITE_EXTERNAL_STORAGE`, `com.android.vending.BILLING`,
  `android.permission.FOREGROUND_SERVICE`,
  `android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK`,
  `android.permission.CAMERA`, `android.permission.ACCESS_NETWORK_STATE`, and
  `com.lookmefy.app.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`
- APK/AAB signing certificate SHA-256:
  `fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c`
- Android signing note: these local artifacts are debug-signed with the local
  debug keystore. The AAB verifies with jarsigner but reports expected
  self-signed certificate and no-timestamp warnings, so the artifacts are
  verified local outputs but not Play-upload-ready.
- iOS bundle identifier: `com.kratikdhote.lookmefy`
- iOS marketing version: `1.0.1`; build number: `24`; minimum iOS: 15.1
- iOS archive facts: arm64 app archive, 142,860 KiB, 125 files
- iOS signing note: the archive is Apple Development signed by
  `Apple Development: Ali Hussain Khan (JGXF4R39DG)`, team `LJ48CVC23W`; it is
  a verified local archive, not a TestFlight/App Store distribution export.
- PDF report:
  `output/pdf/lookmefy-release-difference-1.0.1-android24-ios24.pdf`
- PDF SHA-256:
  `cb2b70093923fd2a0e3ba0a9b77a97c0e071258b46e74a5488ada142e3234b84`
- Verification notes: Expo public config confirmed app name `Lookmefy`, slug
  `lookmefy`, Android package `com.lookmefy.app`, version `1.0.1`, Android
  versionCode `24`, iOS bundle identifier `com.kratikdhote.lookmefy`, and iOS
  build `24`; local Gradle `assembleRelease` and `bundleRelease` completed
  successfully; `aapt`, `apksigner`, and `jarsigner` inspected Android
  artifacts; `xcodebuild archive` completed successfully from
  `FitLook.xcworkspace`; the embedded iOS AppIcon60x60@2x was rendered and
  visually confirmed as the Lookmefy LM/hanger icon.
- Source/worktree note: `fit-look-APP/` is ignored by the root `.gitignore`, so
  binary confidence comes from direct artifact verification rather than Git
  status. Root Git status includes the prior build-23 PDF as an untracked file.

The immediately preceding recorded baseline was version `1.0.1`, Android
versionCode `23`, iOS build `23`. This release intentionally keeps the semantic
version at `1.0.1` per user request, increments only the Android versionCode
and iOS build number to `24`, and restores the original Lookmefy icon instead
of the accidental Skillomate icon.

## 1.0.1 (Android versionCode 23; iOS build 23)

- Android release artifacts: `lookmefy-1.0.1-build23/lookmefy-1.0.1-23.apk`
  and `lookmefy-1.0.1-build23/lookmefy-1.0.1-23.aab`
- Android convenience copies: `../mobile/release/lookmefy-v1.0.1-vc23.apk`
  and `../mobile/release/lookmefy-v1.0.1-vc23.aab`
- Re-verification report generated on 2026-10-01 for an explicit
  out-of-sequence request to deliver Android versionName `1.0.1` and
  versionCode `23`:
  `../../output/pdf/lookmefy-android-1.0.1-vc23-reverified-2026-10-01.pdf`
  (SHA-256 `d61055c8b26eb7fce2d7fef621738d4b6b9538cf1f982d683b7dcbc87efc9504`).
  The APK/AAB were binary-verified again, but a fresh rebuild was blocked
  because `LOOKMEFY_KEYSTORE_PROPERTIES` and the Play upload keystore were not
  available in the shell.
- iOS archive: `../mobile/release/lookmefy-ios-1.0.1-build23.xcarchive`
- Artifact timestamp: 2026-09-14 15:18 IST
- APK size: 83,871,438 bytes
- AAB size: 62,703,067 bytes
- APK SHA-256:
  `19a6001f894b76905e5bbb825094342e3cbcaae87ba9b08b534bb8b1ea0a702c`
- AAB SHA-256:
  `3753d042f6964cf5b9fd10c4d38f5df583410df9a522a310545458076a4a649d`
- APK package: `com.lookmefy.app`
- APK version name: `1.0.1`
- APK minimum SDK: 24; target SDK: 35; compile SDK: 35
- Native ABIs: `arm64-v8a`, `armeabi-v7a`, `x86`, `x86_64`
- Manifest permissions: `android.permission.INTERNET`,
  `android.permission.READ_EXTERNAL_STORAGE`,
  `android.permission.RECORD_AUDIO`,
  `android.permission.SYSTEM_ALERT_WINDOW`, `android.permission.VIBRATE`,
  `android.permission.WRITE_EXTERNAL_STORAGE`, `com.android.vending.BILLING`,
  `android.permission.FOREGROUND_SERVICE`,
  `android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK`,
  `android.permission.CAMERA`, `android.permission.ACCESS_NETWORK_STATE`, and
  `com.lookmefy.app.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`
- APK/AAB signing certificate SHA-256:
  `fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c`
- Android signing note: these local artifacts are debug-signed with the local
  debug keystore. The AAB verifies with jarsigner but reports expected
  self-signed certificate and no-timestamp warnings, so the artifacts are
  verified local outputs but not Play-upload-ready.
- iOS bundle identifier: `com.kratikdhote.lookmefy`
- iOS marketing version: `1.0.1`; build number: `23`; minimum iOS: 15.1
- iOS archive facts: arm64 app archive, 143,464 KiB, 125 files
- iOS signing note: the archive is Apple Development signed by
  `Apple Development: Ali Hussain Khan (JGXF4R39DG)`, team `LJ48CVC23W`; it is
  a verified local archive, not a TestFlight/App Store distribution export.
- PDF report:
  `output/pdf/lookmefy-release-difference-1.0.1-android23-ios23.pdf`
- PDF SHA-256:
  `3642ac23e4f549e8a24eeaf4544e010577b41ef00238f6af14bbfe1ef9d6543f`
- Verification notes: Expo public config confirmed app name `Lookmefy`, slug
  `lookmefy`, Android package `com.lookmefy.app`, version `1.0.1`, Android
  versionCode `23`, iOS bundle identifier `com.kratikdhote.lookmefy`, and iOS
  build `23`; local Gradle `assembleRelease` and `bundleRelease` completed
  successfully; `aapt`, `apksigner`, and `jarsigner` inspected Android
  artifacts; `xcodebuild archive` completed successfully from
  `FitLook.xcworkspace`.
- Source/worktree note: `fit-look-APP/` is ignored by the root `.gitignore`, so
  binary confidence comes from direct artifact verification rather than Git
  status. The user-supplied icon was applied to Expo icon assets, the iOS app
  icon catalog, and Android launcher resources.

The immediately preceding recorded baseline was version `1.0.3`, Android
versionCode `22`, iOS build `23`. This release increments Android versionCode
by one but intentionally sets the semantic version back to `1.0.1` per user
request, keeps iOS build `23`, and changes the launcher icon on both platforms.
The older duplicate Xcode recent project was identified as
`/Users/kratik/Desktop/fitlookapp/Fitlook-main`; automated deletion was blocked
because it is a large project containing environment/uploads data.

## 1.0.3 (Android versionCode 22; iOS build 23)

- Android release artifacts: `lookmefy-1.0.3-build22/lookmefy-1.0.3-22.apk` and
  `lookmefy-1.0.3-build22/lookmefy-1.0.3-22.aab`
- Android convenience copies: `../mobile/release/lookmefy-v1.0.3-vc22.apk`
  and `../mobile/release/lookmefy-v1.0.3-vc22.aab`
- iOS archive: `../mobile/release/lookmefy-ios-1.0.3-build23.xcarchive`
- Artifact timestamp: 2026-09-11 18:33 IST
- APK size: 84,268,750 bytes
- AAB size: 63,073,671 bytes
- APK SHA-256: `fc265a6181a70908dcb9d0d79835581dfc07943a00794d711394084ac3994d9c`
- AAB SHA-256: `3eaac6bf1d01ec3aa1b83c960d5c8fcdc713cd9efe1a48623e50e5fc204ca5ff`
- APK package: `com.lookmefy.app`
- APK version name: `1.0.3`
- APK minimum SDK: 24; target SDK: 35; compile SDK: 35
- Native ABIs: `arm64-v8a`, `armeabi-v7a`, `x86`, `x86_64`
- APK/AAB signing certificate SHA-256:
  `fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c`
- Android signing note: these local artifacts are debug-signed with the local
  debug keystore, so they are verified build outputs but not Play-upload-ready.
  EAS remote Android versionCode was set to `22`, but EAS cloud builds were not
  started because that requires explicit approval to upload source/configuration
  to Expo.
- iOS bundle identifier: `com.kratikdhote.lookmefy`
- iOS marketing version: `1.0.3`; build number: `23`; minimum iOS: 15.1
- iOS archive facts: arm64 app archive, 143,664 KiB, 125 files
- iOS signing note: the archive is Apple Development signed by
  `Apple Development: Ali Hussain Khan (JGXF4R39DG)`, team `LJ48CVC23W`; it is
  a verified local archive, not a TestFlight/App Store distribution export.
- PDF report:
  `output/pdf/lookmefy-release-report-1.0.3-android22-ios23.pdf`
- PDF SHA-256:
  `3bc3fdffc5005cfb10850572944e78ac2add07179042e23c3e8ccde4e4bdde2a`
- Verification notes: Babel transform of `App.js` passed, Expo public config
  confirmed version `1.0.3`, Android versionCode `22`, and iOS build `23`;
  local Gradle `assembleRelease` and `bundleRelease` completed successfully;
  `aapt`, `apksigner`, and `jarsigner` inspected Android artifacts; `xcodebuild
  archive` completed successfully from `FitLook.xcworkspace`.

The preceding binary-verified baseline was version `1.0.2`, Android
versionCode `21`, signed through EAS-managed release/upload credentials. This
release increments the patch version and Android versionCode, adds iOS build
`23`, and fixes Android hardware back navigation so a single non-home route
returns to Home instead of exiting the app.

## 1.0.2 (Android versionCode 21)

- Release artifacts: `lookmefy-1.0.2-build21/lookmefy-1.0.2-21.apk` and
  `lookmefy-1.0.2-build21/lookmefy-1.0.2-21.aab`
- Convenience copies: `../mobile/release/lookmefy-v1.0.2-vc21.apk` and
  `../mobile/release/lookmefy-v1.0.2-vc21.aab`
- Artifact timestamp: 2026-09-11 16:08 IST
- EAS project: `@office50505/lookmefy`
- EAS AAB build: `2d1707f4-a722-4605-838f-6aea4f1893a0`
  (`https://expo.dev/accounts/office50505/projects/lookmefy/builds/2d1707f4-a722-4605-838f-6aea4f1893a0`)
- EAS APK build: `78a47624-4eff-458f-a3ed-3d74a89b131a`
  (`https://expo.dev/accounts/office50505/projects/lookmefy/builds/78a47624-4eff-458f-a3ed-3d74a89b131a`)
- APK size: 84,146,515 bytes
- AAB size: 63,014,966 bytes
- APK SHA-256: `78f4c6905b35e7e1973d57628a6ee2a938acc8be25224ac29cb4f1d3622d8392`
- AAB SHA-256: `d117f6757e56d502bb4bf4f10b5a75a78e40aa3b45b1fa965e69caef362dbb5d`
- APK package: `com.lookmefy.app`
- APK version name: `1.0.2`
- APK minimum SDK: 24; target SDK: 35; compile SDK: 35
- Native ABIs: `arm64-v8a`, `armeabi-v7a`, `x86`, `x86_64`
- APK/AAB signing certificate SHA-256:
  `b010b9a7b007fc50cecaad78ebff2c5869bde4c14708f2ddadd97f8f63c73d83`
- Signing note: EAS-managed release/upload credentials were used. The release
  build type does not reference `signingConfigs.debug`, and this certificate
  does not match the previous debug certificate from versionCode 20.
- Production API used by EAS builds: `https://api.lookmefy.in/api`
- PDF report: `output/pdf/lookmefy-android-release-report-1.0.2-build21.pdf`
- PDF SHA-256: `c7c2a53ef41ec902dbbebb20a62f7cbcfd4f426dc3c39e5360966c7db875cbc1`
- Verification notes: `npx expo config --type public` confirmed app name
  `Lookmefy`, slug `lookmefy`, package `com.lookmefy.app`, version `1.0.2`,
  and Android versionCode `21`. `npx expo-doctor` reported 17/18 checks passed;
  the remaining warning is the known non-CNG native config sync warning because
  native `android` and `ios` folders exist.

The preceding baseline was version `1.0.1`, Android versionCode `20`, whose
history entry documents debug signing. This release increments the patch
version and versionCode, preserves the same Android package identity, removes
debug signing from the native release build, and produces a Play-upload-ready
production AAB plus an installable APK for testing.

## 1.0.1 (Android versionCode 20)

- Release artifacts: `lookmefy-1.0.1-build20/lookmefy-1.0.1-20.apk` and
  `lookmefy-1.0.1-build20/lookmefy-1.0.1-20.aab`
- Convenience copies: `../mobile/release/lookmefy-v1.0.1-vc20.apk` and
  `../mobile/release/lookmefy-v1.0.1-vc20.aab`
- iOS archive: `../mobile/release/lookmefy-ios-1.0.1-build22.xcarchive`
- Artifact timestamp: 2026-09-08 14:14 IST
- APK size: 84,135,051 bytes
- AAB size: 63,008,131 bytes
- APK SHA-256: `64491b9b0966ea8fa90e87f9a529ac75416e2dec91d495f98483b9b785ce758c`
- AAB SHA-256: `c2f661516fad61a544c70812e4195585bfff8d453feeb7b869b2eedf1216ef33`
- APK package: `com.lookmefy.app`
- APK minimum SDK: 24; target SDK: 35; compile SDK: 35
- APK signing certificate SHA-256:
  `fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c`
- Signing note: this local build is debug-signed and does not match the
  versionCode 19 release certificate.
- PDF report: `output/pdf/lookmefy-release-difference-android-vc20-ios-build22.pdf`
- PDF SHA-256: `39b9a291566699e124573272281166aeef662db0c3bd7059aaef4361b2719dc5`

The preceding binary-verified baseline is Android versionCode 19 with the same
`1.0.1` version name. The iOS build metadata is version `1.0.1`, build `22`, but
the local archive is unsigned and not TestFlight-ready from this machine.

## 1.0.1 (Android versionCode 19)

- Release artifacts: `lookmefy-1.0.1-build19/lookmefy-1.0.1-19.apk` and
  `lookmefy-1.0.1-build19/lookmefy-1.0.1-19.aab`
- Artifact timestamp: 2026-09-03 14:15 IST
- APK SHA-256: `e52ec82afc449eb8380a5854f24d98a9a03e66ee5b56ba0b88fe47066677615b`
- AAB SHA-256: `c7249aac69a21106ebe91102ebac51b6304144dcd0a63e22ea1848001dc2ffd1`
- APK package: `com.lookmefy.app`
- APK minimum SDK: 24; target SDK: 36; compile SDK: 36
- APK signing certificate SHA-256:
  `5f6b3f0a310b9677899f16708948e7c8874b81970475d429df8764eede218bcb`
- PDF report: `output/pdf/lookmefy-android-release-report-1.0.1-build19.pdf`
- PDF SHA-256: `ad2c9d14b8d6ca6de9fc71b510aae8ef046dcf873c2d3b992f6a64833e09ab71`

The preceding configuration baseline is Android versionCode 18 with the same
`1.0.1` version name. No build-18 APK/AAB is present, so that comparison is
source-history based rather than binary-to-binary verified.

## Next-release default

Unless explicitly overridden by the user, the next release after this baseline is
version `1.0.3`, Android versionCode `26`, with both APK and AAB artifacts and a
new PDF comparing it against this release.
