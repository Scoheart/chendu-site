#!/usr/bin/env python3
"""Print the `files` array for the Vercel connector's create_deployment call.

Only text sources are deployed; Vercel's build (tools/vercel-build.sh) regenerates
fonts, mp3s and HTML. Files whose sha1 is already in tools/deployed-shas.json
(i.e. already stored on Vercel by an earlier deployment) are sent as
{file, sha, size} references; new/changed files are inlined as utf-8.

  python tools/deploy_payload.py            # print JSON array to paste into create_deployment
  python tools/deploy_payload.py --all      # inline everything (first deploy / store miss)
  python tools/deploy_payload.py --mark     # after a READY deployment: record current shas
"""
import hashlib, json, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MANIFEST = ROOT / "tools" / "deployed-shas.json"


def sources():
    fixed = ["vercel.json", "tools/build.py", "tools/vercel-build.sh", "assets/style.css", "assets/issue.js",
             "assets/sync.js", "package.json", "package-lock.json", "db/schema.sql", "scripts/migrate.mjs"]
    # account / sync backend: Vercel Functions in api/ plus their shared code in lib/
    backend = sorted(str(p.relative_to(ROOT)) for p in [*ROOT.glob("api/**/*.js"), *ROOT.glob("lib/*.js")])
    return fixed + backend + sorted(str(p.relative_to(ROOT)) for p in ROOT.glob("issues/*/data.json"))


def main():
    known = set(json.loads(MANIFEST.read_text())) if MANIFEST.exists() else set()
    out, shas = [], []
    for rel in sources():
        b = (ROOT / rel).read_bytes()
        if rel.endswith("data.json"):  # canonical compact form (smaller payload, stable sha)
            b = (json.dumps(json.loads(b), ensure_ascii=False, separators=(",", ":")) + "\n").encode()
        sha = hashlib.sha1(b).hexdigest()
        shas.append(sha)
        if sha in known and "--all" not in sys.argv:
            out.append({"file": rel, "sha": sha, "size": len(b)})
        else:
            out.append({"file": rel, "encoding": "utf-8", "data": b.decode("utf-8")})
    if "--mark" in sys.argv:
        MANIFEST.write_text(json.dumps(sorted(known | set(shas)), indent=0))
        print("recorded", len(shas), "shas in", MANIFEST.relative_to(ROOT))
        return
    print(json.dumps(out, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
