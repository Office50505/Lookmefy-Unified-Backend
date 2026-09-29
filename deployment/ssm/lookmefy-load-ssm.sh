#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

REGION=ap-south-1
PREFIX=/lookmefy/prod
DIRECTORY=/run/lookmefy
OUTPUT="$DIRECTORY/ssm.env"
EXPECTED=/etc/lookmefy/ssm-expected-keys

install -d -o root -g root -m 0700 "$DIRECTORY"
raw=$(mktemp "$DIRECTORY/.ssm-raw.XXXXXXXX")
staged=$(mktemp "$DIRECTORY/.ssm-env.XXXXXXXX")
trap 'rm -f "$raw" "$staged"' EXIT

# An old file must never make a failed refresh appear usable.
rm -f "$OUTPUT"
if ! aws ssm get-parameters-by-path \
  --region "$REGION" \
  --path "$PREFIX" \
  --recursive \
  --with-decryption \
  --output json >"$raw" 2>/dev/null; then
  echo 'SSM load failed' >&2
  exit 1
fi

if ! python3 - "$raw" "$staged" "$EXPECTED" "$PREFIX" <<'PY'
import json
import re
import sys

raw_path, staged_path, expected_path, prefix = sys.argv[1:]
valid_name = re.compile(r"[A-Za-z_][A-Za-z0-9_]*\Z")

try:
    with open(expected_path, encoding="utf-8") as source:
        expected = [line.rstrip("\n") for line in source]
    if len(expected) != 114 or len(set(expected)) != 114:
        raise ValueError("invalid expected-name manifest")
    if any(not valid_name.fullmatch(name) for name in expected):
        raise ValueError("invalid expected variable name")

    with open(raw_path, encoding="utf-8") as source:
        parameters = json.load(source)["Parameters"]
    if not isinstance(parameters, list) or len(parameters) != 114:
        raise ValueError("wrong parameter count")

    loaded = {}
    for parameter in parameters:
        path = parameter["Name"]
        value = parameter["Value"]
        if not isinstance(path, str) or not path.startswith(prefix + "/"):
            raise ValueError("wrong parameter path")
        name = path.rsplit("/", 1)[-1]
        if not valid_name.fullmatch(name) or name in loaded:
            raise ValueError("invalid or duplicate variable name")
        if not isinstance(value, str) or any(ch in value for ch in "\r\n\0"):
            raise ValueError("unsupported parameter value")
        loaded[name] = value

    if set(loaded) != set(expected):
        raise ValueError("missing or unexpected parameter")

    with open(staged_path, "w", encoding="utf-8", newline="\n") as target:
        for name in sorted(loaded):
            value = loaded[name].replace("\\", "\\\\").replace('"', '\\"')
            target.write(f'{name}="{value}"\n')
except Exception:
    print("SSM validation failed", file=sys.stderr)
    sys.exit(1)
PY
then
  exit 1
fi

chown root:root "$staged"
chmod 0600 "$staged"
mv -f "$staged" "$OUTPUT"
echo 'SSM load complete: 114 production variables'
