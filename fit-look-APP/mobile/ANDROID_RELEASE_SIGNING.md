# Lookmefy Android release signing

Package: `com.lookmefy.app`. Skillomate is a separate app and key.

## Replacement upload key (EAS and local backup)

The upload-key reset was submitted in Play Console on 2026-10-15. The
confirmation states that the replacement key becomes valid on 2026-10-17
at 07:17 UTC (12:47 IST). Do not upload before activation. No upload was
performed as part of preparing build 27.

Replacement upload certificate SHA-1:
`E0:47:A9:8F:96:B2:3A:0F:D3:22:32:75:97:59:60:3D:51:05:B0:EB`

Original, missing upload certificate SHA-1:
`4C:27:9B:A5:0B:3A:85:11:82:F5:DA:1B:8C:BB:B7:14:60:56:CB:75`

The replacement private key remains on Expo EAS and has been downloaded to
`credentials/android/keystore.jks`. Passwords and alias are in the private
`credentials.json`; Gradle configuration is in `android/keystore.properties`.
All three are ignored by Git and have private filesystem permissions. Keep
an additional secure backup outside this computer. Never commit these files.
The public certificate is `lookmefy-eas-upload-certificate.pem`.

```sh
export LOOKMEFY_KEYSTORE_PROPERTIES="$(pwd)/android/keystore.properties"
cd android
./gradlew :app:assembleRelease :app:bundleRelease
```

Gradle checks the replacement certificate before signing and refuses another
key. This check verifies key identity, not Play activation. The verifier also
expects the replacement certificate for future builds:

```sh
python3 scripts/verify_android_release.py --app lookmefy \
  --apk ../releases/lookmefy-1.0.3-build27/lookmefy-1.0.3-27.apk \
  --aab ../releases/lookmefy-1.0.3-build27/lookmefy-1.0.3-27.aab \
  --version-code 27 --version-name 1.0.3
```

EAS uses the local version source. Build 27 remains a local signed release;
Play publication requires a separate upload after key activation.
