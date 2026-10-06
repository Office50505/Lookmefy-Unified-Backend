#!/usr/bin/env python3
"""Fail if an Android release belongs to the wrong Play app or upload key."""

import argparse
import hashlib
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import zipfile


APPS = {
    "skillomate": ("com.skillomate.app", "56992ecb073a283c9d34128eeec4bda5c16fe45c"),
    "lookmefy": ("com.lookmefy.app", "4c279ba50b3a851182f5da1b8cbbb7146056cb75"),
}


def run(*command):
    env = os.environ.copy()
    env.setdefault("JAVA_HOME", "/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home")
    result = subprocess.run(command, text=True, capture_output=True, env=env)
    if result.returncode:
        raise RuntimeError(f"{' '.join(map(str, command[:2]))} failed: {result.stderr.strip()}")
    return result.stdout


def sdk_tool(name):
    sdk = Path(os.environ.get("ANDROID_HOME", Path.home() / "Library/Android/sdk"))
    versions = sorted((sdk / "build-tools").glob("*"), key=lambda p: tuple(int(x) for x in re.findall(r"\d+", p.name)))
    for folder in reversed(versions):
        tool = folder / name
        if tool.is_file():
            return str(tool)
    raise RuntimeError(f"Android SDK build tool not found: {name}")


def java_tool(name):
    home = os.environ.get("JAVA_HOME")
    candidates = [Path(home) / "bin" / name] if home else []
    candidates.append(Path("/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home/bin") / name)
    for path in candidates:
        if path.is_file():
            return str(path)
    found = shutil.which(name)
    if found:
        return found
    raise RuntimeError(f"Java tool not found: {name}")


def digest(path):
    sha = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            sha.update(chunk)
    return sha.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", choices=APPS, required=True)
    parser.add_argument("--apk", type=Path, required=True)
    parser.add_argument("--aab", type=Path, required=True)
    parser.add_argument("--version-code", type=int, required=True)
    parser.add_argument("--version-name", required=True)
    args = parser.parse_args()
    package, expected_sha1 = APPS[args.app]

    badging = run(sdk_tool("aapt"), "dump", "badging", str(args.apk))
    match = re.search(r"^package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'", badging, re.M)
    if not match:
        raise RuntimeError("Could not read APK package and version")
    actual_package, code, name = match.groups()
    if (actual_package, int(code), name) != (package, args.version_code, args.version_name):
        raise RuntimeError(f"APK identity mismatch: {actual_package} / {name} / {code}")

    apk_signing = run(sdk_tool("apksigner"), "verify", "--print-certs", str(args.apk))
    apk_sha1 = re.findall(r"(?:Signer #\d+|V\d+(?:\.\d+)? Signer):? certificate SHA-1 digest: ([0-9a-f]+)", apk_signing)
    if apk_sha1 != [expected_sha1]:
        raise RuntimeError(f"Wrong {args.app} APK upload key: {apk_sha1}")

    verification = run(java_tool("jarsigner"), "-verify", str(args.aab))
    if "jar verified." not in verification:
        raise RuntimeError("AAB JAR signature did not verify")
    aab_certificate = run(java_tool("keytool"), "-printcert", "-jarfile", str(args.aab))
    aab_sha1 = [value.replace(":", "").lower() for value in re.findall(r"SHA1: ([0-9A-F:]+)", aab_certificate)]
    if aab_sha1 != [expected_sha1]:
        raise RuntimeError(f"Wrong {args.app} AAB upload key: {aab_sha1}")
    with zipfile.ZipFile(args.aab) as bundle:
        if bundle.testzip() is not None or "base/manifest/AndroidManifest.xml" not in bundle.namelist():
            raise RuntimeError("AAB ZIP integrity or base manifest check failed")

    print(f"PASS {args.app}: {package} / {args.version_name} / {args.version_code}")
    print(f"Upload certificate SHA-1: {expected_sha1}")
    print(f"APK SHA-256: {digest(args.apk)}")
    print(f"AAB SHA-256: {digest(args.aab)}")


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, zipfile.BadZipFile) as error:
        print(f"FAIL: {error}", file=sys.stderr)
        sys.exit(1)
