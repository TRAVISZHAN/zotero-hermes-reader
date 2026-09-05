from __future__ import annotations

import hashlib
import json
import zipfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).parent
DIST = ROOT / "dist"
INCLUDE = ["manifest.json", "bootstrap.js", "content", "locale"]
EXCLUDE_NAMES = {".DS_Store", "__pycache__"}
EXPECTED_ID = "hermes-reading-assistant-z9@altail.local"


def included_files():
    for entry in INCLUDE:
        path = ROOT / entry
        if path.is_file():
            yield path
            continue
        for candidate in path.rglob("*"):
            if candidate.is_file() and not any(
                part in EXCLUDE_NAMES for part in candidate.parts
            ):
                yield candidate


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> Path:
    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    addon = manifest["applications"]["zotero"]
    version = manifest["version"]
    if addon["id"] != EXPECTED_ID:
        raise RuntimeError("wrong addon id")
    if not addon.get("update_url", "").startswith("https://"):
        raise RuntimeError("Zotero 9 requires an HTTPS update_url")

    DIST.mkdir(exist_ok=True)
    output = DIST / f"Hermes-Reading-Assistant-Zotero9-{version}.xpi"
    sources = sorted(included_files())
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as bundle:
        for source in sources:
            bundle.write(source, source.relative_to(ROOT).as_posix())

    with zipfile.ZipFile(output) as bundle:
        if bundle.testzip() is not None:
            raise RuntimeError("generated XPI failed ZIP integrity check")
        packaged_manifest = json.loads(bundle.read("manifest.json"))
        if packaged_manifest != manifest:
            raise RuntimeError("packaged manifest differs from source")
        members = bundle.namelist()

    ledger = {
        "addon_id": EXPECTED_ID,
        "version": version,
        "xpi": output.name,
        "size": output.stat().st_size,
        "sha256": sha256(output),
        "built_at": datetime.now(timezone.utc).isoformat(),
        "files": members,
    }
    # Zotero fetches this anonymously over HTTPS to decide whether an update
    # exists, so both it and the XPI have to be publicly reachable.
    repo = manifest["applications"]["zotero"]["update_url"]
    owner_repo = repo.split("/")[3:5] if "githubusercontent.com" in repo else None
    if owner_repo:
        xpi_url = (
            f"https://github.com/{owner_repo[0]}/{owner_repo[1]}"
            f"/releases/download/v{version}/{output.name}"
        )
        update_manifest = {
            "addons": {
                EXPECTED_ID: {
                    "updates": [
                        {
                            "version": version,
                            "update_link": xpi_url,
                            "update_hash": f"sha256:{sha256(output)}",
                            "applications": {
                                "zotero": {
                                    "strict_min_version": addon["strict_min_version"],
                                    "strict_max_version": addon["strict_max_version"],
                                }
                            },
                        }
                    ]
                }
            }
        }
        (ROOT / "update.json").write_text(
            json.dumps(update_manifest, indent=2) + "\n", encoding="utf-8"
        )
        print(ROOT / "update.json")

    ledger_path = output.with_suffix(".release.json")
    ledger_path.write_text(
        json.dumps(ledger, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(output)
    print(ledger_path)
    print(ledger["sha256"])
    return output


if __name__ == "__main__":
    main()
