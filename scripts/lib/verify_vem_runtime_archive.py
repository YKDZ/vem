from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import tempfile
import zipfile


EXPECTED_MEMBERS = {
    "WINDOWS-RUNTIME-ARTIFACTS.json",
    "WebView2Loader.dll",
    "machine.exe",
    "vending-daemon.exe",
}
MAX_ARCHIVE_BYTES = 512 * 1024 * 1024 + 1024 * 1024
MAX_DESCRIPTOR_BYTES = 1024 * 1024
MAX_RUNTIME_FILE_BYTES = 256 * 1024 * 1024


class RuntimeArchiveError(RuntimeError):
    pass


def _canonical_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _absolute_regular(path: Path, label: str) -> Path:
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        raise RuntimeArchiveError(f"{label} must be an absolute regular file")
    if path.resolve() != path:
        raise RuntimeArchiveError(f"{label} path must be canonical")
    return path


def _safe_destination(path: Path) -> None:
    if not path.is_absolute() or path.exists():
        raise RuntimeArchiveError("runtime extraction destination must be new and absolute")
    parent = path.parent
    if parent.is_symlink() or not parent.is_dir() or parent.resolve() != parent:
        raise RuntimeArchiveError("runtime extraction parent is unsafe")


def verify_archive(archive_path: Path, destination: Path) -> dict[str, object]:
    archive_path = _absolute_regular(archive_path, "runtime archive")
    _safe_destination(destination)
    archive_size = archive_path.stat().st_size
    if archive_size <= 0 or archive_size > MAX_ARCHIVE_BYTES:
        raise RuntimeArchiveError("runtime archive size is invalid")
    if not zipfile.is_zipfile(archive_path):
        raise RuntimeArchiveError("runtime archive is not a ZIP")

    staging = Path(tempfile.mkdtemp(prefix=f".{destination.name}-", dir=destination.parent))
    try:
        with zipfile.ZipFile(archive_path) as archive:
            infos = archive.infolist()
            names = [info.filename for info in infos]
            if len(infos) != len(EXPECTED_MEMBERS) or set(names) != EXPECTED_MEMBERS:
                raise RuntimeArchiveError("runtime archive member set is not exact")
            if len({name.casefold() for name in names}) != len(names):
                raise RuntimeArchiveError("runtime archive has a case collision")
            total = 0
            members = []
            for info in infos:
                mode = info.external_attr >> 16
                file_type = stat.S_IFMT(mode)
                maximum = (
                    MAX_DESCRIPTOR_BYTES
                    if info.filename == "WINDOWS-RUNTIME-ARTIFACTS.json"
                    else MAX_RUNTIME_FILE_BYTES
                )
                if (
                    info.is_dir()
                    or info.compress_type != zipfile.ZIP_STORED
                    or file_type not in {0, stat.S_IFREG}
                    or info.file_size <= 0
                    or info.file_size > maximum
                ):
                    raise RuntimeArchiveError("runtime archive member metadata is unsafe")
                total += info.file_size
                if total > MAX_ARCHIVE_BYTES:
                    raise RuntimeArchiveError("runtime archive extracted size is invalid")
                target = staging / info.filename
                digest = hashlib.sha256()
                size = 0
                with archive.open(info) as source, target.open("xb") as output:
                    while chunk := source.read(1024 * 1024):
                        if size + len(chunk) > info.file_size:
                            raise RuntimeArchiveError("runtime archive member exceeded its size")
                        output.write(chunk)
                        digest.update(chunk)
                        size += len(chunk)
                if size != info.file_size:
                    raise RuntimeArchiveError("runtime archive member read was incomplete")
                members.append(
                    {"name": info.filename, "byteSize": size, "sha256": digest.hexdigest()}
                )
        os.replace(staging, destination)
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    return {
        "archiveByteSize": archive_size,
        "archiveSha256": _sha256_file(archive_path),
        "members": sorted(members, key=lambda item: item["name"]),
    }


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["verify"])
    parser.add_argument("--archive", required=True, type=Path)
    parser.add_argument("--destination", required=True, type=Path)
    args = parser.parse_args()
    try:
        result = verify_archive(args.archive, args.destination)
    except (OSError, RuntimeArchiveError, zipfile.BadZipFile) as error:
        print(f"VEM_RUNTIME_ARCHIVE=FAIL:{error}", file=os.sys.stderr)
        return 1
    print(_canonical_json(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
