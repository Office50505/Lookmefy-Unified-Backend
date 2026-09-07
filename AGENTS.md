# Lookmefy Android release convention

When the user asks for the next Lookmefy Android APK and AAB, treat the latest
entry under `fit-look-APP/releases/` as the release baseline.

- Increment Android `versionCode` by exactly 1.
- Unless the user gives a different semantic version, increment the patch part
  of `versionName` by 1 (for example, `1.0.1` to `1.0.2`).
- Keep `mobile/app.json`, `mobile/package.json`, generated Android metadata, and
  artifact filenames aligned with the new version.
- Produce both APK and AAB artifacts in a versioned release directory.
- Generate a PDF release report under `output/pdf/` and reference it from the
  release history. It must document version metadata, build configuration,
  artifact byte sizes and SHA-256 hashes,
  manifest permissions, SDK/ABI/signing facts, verification results, user-facing
  changes, technical changes, and an explicit comparison with the immediately
  preceding release.
- Clearly separate binary-verified facts from source-history inferences and call
  out any dirty working tree or missing baseline artifact that limits confidence.
- Update `fit-look-APP/releases/RELEASE_HISTORY.md` after verification.

Current recorded baseline: Lookmefy `1.0.1`, Android `versionCode` 19. The
default next release is therefore `1.0.2` / `versionCode` 20.
