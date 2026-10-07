# Lookmefy Android release signing

Lookmefy's Google Play listing uses package `com.lookmefy.app` and upload
certificate SHA-1 `4C:27:9B:A5:0B:3A:85:11:82:F5:DA:1B:8C:BB:B7:14:60:56:CB:75`.
Skillomate is a different app (`com.skillomate.app`) with a different key.
Never upload a Skillomate AAB to the Lookmefy listing.

Local release tasks require `LOOKMEFY_KEYSTORE_PROPERTIES` pointing to an
ignored `keystore.properties` file for the original Lookmefy upload key. Gradle
checks the certificate before building and refuses another key. Keep the
keystore and passwords out of Git.

```sh
export LOOKMEFY_KEYSTORE_PROPERTIES=/path/to/android/keystore.properties
cd android
./gradlew :app:assembleRelease :app:bundleRelease
```

Verify the output pair before upload:

```sh
python3 scripts/verify_android_release.py --app lookmefy \
  --apk ../releases/lookmefy-1.0.2-build25/lookmefy-1.0.2-25.apk \
  --aab ../releases/lookmefy-1.0.2-build25/lookmefy-1.0.2-25.aab \
  --version-code 25 --version-name 1.0.2
```

The remote EAS credential currently has a different SHA-1. Android release
builds from this native project therefore require the local signing properties
and fail without them. Do not use an EAS Android production artifact until its
remote upload key has been updated and verified against Play Console. The
local EAS version source is set to `local` so version codes follow app.json
and native Gradle metadata rather than the stale remote code.
