"""Apply reviewed source changes on the isolated review branch only.

This transport helper is removed with its payload files after offline tests pass.
It never reads exchange/database credentials, invokes trading, or updates main.
"""
import base64
import hashlib
import json
import lzma
import os
import pathlib
import subprocess

TARGET = "refs/heads/fix/entry-evidence-20260918"
DIGEST = "03b42344c92b2b4a07537c0288b3771fea05c220da9043f0cd07bc57a22aa075"
EXISTING = {
    "gateway/server.mjs": "990851c452e1694f5d8e50be210cc8b1e0b7c653",
    "supabase/functions/v10-lane-executor/boo-entry-adapter.mjs": "37f76f7fef9c3685903ee9a77b2a6358a2a17922",
    "supabase/functions/v10-lane-executor/index.ts": "54bab8e8bc53b90ced672a1c7770af97ec79eddd",
}
NEW = {
    "supabase/functions/v10-lane-executor/entry-evidence.mjs",
    "supabase/functions/v10-lane-executor/entry-evidence.test.mjs",
    "gateway/futures-mode-evidence.mjs",
    "gateway/futures-mode-evidence.test.mjs",
    "docs/entry-evidence-repair-20260918.md",
    ".github/workflows/entry-evidence-tests.yml",
}

def require(condition, message):
    if not condition:
        raise RuntimeError(message)

require(os.environ.get("GITHUB_REF") == TARGET, "Ref is not the isolated review branch")
require(not subprocess.check_output(["git", "status", "--porcelain"], text=True).strip(), "Working tree is not clean")
encoded = "".join(pathlib.Path(f"tools/entry_evidence_payload_{i}.txt").read_text().strip() for i in range(1, 4))
raw = lzma.decompress(base64.b64decode(encoded, validate=True))
require(hashlib.sha256(raw).hexdigest() == DIGEST, "Source payload digest mismatch")
payload = json.loads(raw)
require(payload["expected"] == EXISTING, "Unexpected base file set")
require(set(payload["files"]) == NEW, "Unexpected new file set")
for path, expected in EXISTING.items():
    actual = subprocess.check_output(["git", "hash-object", path], text=True).strip()
    require(actual == expected, f"Base source drift: {path}")
for path in NEW:
    require(not pathlib.Path(path).exists(), f"New path already exists: {path}")
subprocess.run(["git", "apply", "--check"], input=payload["patch"], text=True, check=True)
subprocess.run(["git", "apply"], input=payload["patch"], text=True, check=True)
modified = set(subprocess.check_output(["git", "diff", "--name-only"], text=True).splitlines())
require(modified == set(EXISTING), "Patch touched an unexpected file")
for path, content in payload["files"].items():
    target = pathlib.Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
print("Applied 3 hash-checked existing files and 6 reviewed new files. Offline tests must pass before review-branch commit.")
