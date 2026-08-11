from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import subprocess
import tarfile
import tempfile
from typing import Any
from urllib.parse import urlparse
from urllib.request import Request, urlopen


class TrustedGhError(RuntimeError):
    pass


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise TrustedGhError(message)


def _exact_keys(value: object, keys: set[str], label: str) -> dict[str, Any]:
    _require(isinstance(value, dict), f"{label} must be an object")
    assert isinstance(value, dict)
    _require(set(value) == keys, f"{label} keys are not exact")
    return value


def load_descriptor(path: Path) -> dict[str, Any]:
    raw = path.read_bytes()
    try:
        descriptor = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise TrustedGhError("trusted gh descriptor is not valid UTF-8 JSON") from exc
    canonical = (
        json.dumps(descriptor, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    ).encode()
    _require(raw == canonical, "trusted gh descriptor is not canonical")
    root = _exact_keys(
        descriptor,
        {"archive", "binary", "platform", "schemaVersion", "version"},
        "trusted gh descriptor",
    )
    archive = _exact_keys(
        root["archive"],
        {"byteSize", "expandedByteSize", "memberCount", "sha256", "url"},
        "trusted gh archive",
    )
    binary = _exact_keys(
        root["binary"],
        {"byteSize", "relativeMember", "sha256", "versionOutput"},
        "trusted gh binary",
    )
    _require(root["schemaVersion"] == "vem.trusted-gh-cli.v1", "schema mismatch")
    _require(root["version"] == "2.95.0", "version mismatch")
    _require(root["platform"] == "linux-amd64", "platform mismatch")
    for owner, fields in ((archive, ("byteSize", "expandedByteSize", "memberCount")), (binary, ("byteSize",))):
        for field in fields:
            value = owner[field]
            _require(
                isinstance(value, int) and not isinstance(value, bool) and 0 < value < 2**53,
                f"{field} must be a positive safe integer",
            )
    for owner, field in ((archive, "sha256"), (binary, "sha256")):
        value = owner[field]
        _require(
            isinstance(value, str)
            and len(value) == 64
            and all(character in "0123456789abcdef" for character in value),
            f"{field} is invalid",
        )
    parsed = urlparse(archive["url"])
    _require(
        parsed.scheme == "https"
        and parsed.hostname == "github.com"
        and not parsed.username
        and not parsed.password
        and not parsed.fragment,
        "archive URL is not the pinned GitHub HTTPS release URL",
    )
    _require(
        archive["url"]
        == "https://github.com/cli/cli/releases/download/v2.95.0/gh_2.95.0_linux_amd64.tar.gz",
        "archive URL changed",
    )
    _require(
        binary["relativeMember"] == "gh_2.95.0_linux_amd64/bin/gh",
        "binary archive member changed",
    )
    _require(
        binary["versionOutput"]
        == "gh version 2.95.0 (2026-06-17)\nhttps://github.com/cli/cli/releases/tag/v2.95.0\n",
        "binary version output changed",
    )
    return root


def _sha256_file(path: Path) -> tuple[int, str]:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            size += len(chunk)
            digest.update(chunk)
    return size, digest.hexdigest()


def verify_binary(path: Path, descriptor: dict[str, Any]) -> None:
    _require(path.is_absolute(), "trusted gh binary path must be absolute")
    _require(path == path.resolve(strict=True), "trusted gh binary path must be realpath")
    metadata = path.lstat()
    _require(stat.S_ISREG(metadata.st_mode), "trusted gh binary must be a regular file")
    binary = descriptor["binary"]
    size, digest = _sha256_file(path)
    _require(size == binary["byteSize"], "trusted gh binary size mismatch")
    _require(digest == binary["sha256"], "trusted gh binary digest mismatch")
    with tempfile.TemporaryDirectory(prefix="vem-gh-version-") as temporary:
        completed = subprocess.run(
            [str(path), "--version"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            check=False,
            timeout=15,
            env={
                "GH_CONFIG_DIR": str(Path(temporary) / "config"),
                "HOME": temporary,
                "LANG": "C.UTF-8",
                "XDG_STATE_HOME": str(Path(temporary) / "state"),
            },
        )
    _require(completed.returncode == 0, "trusted gh version probe failed")
    _require(completed.stderr == "", "trusted gh version probe wrote stderr")
    _require(completed.stdout == binary["versionOutput"], "trusted gh version mismatch")


def _download_archive(destination: Path, descriptor: dict[str, Any]) -> None:
    archive = descriptor["archive"]
    request = Request(archive["url"], headers={"User-Agent": "vem-trusted-gh-materializer/1"})
    digest = hashlib.sha256()
    size = 0
    try:
        with urlopen(request, timeout=30) as response, destination.open("xb") as sink:
            final = urlparse(response.geturl())
            _require(
                final.scheme == "https"
                and final.hostname in {"github.com", "release-assets.githubusercontent.com"},
                "trusted gh download redirected outside GitHub release assets",
            )
            while True:
                chunk = response.read(min(1024 * 1024, archive["byteSize"] + 1 - size))
                if not chunk:
                    break
                size += len(chunk)
                _require(size <= archive["byteSize"], "trusted gh archive exceeds expected size")
                digest.update(chunk)
                sink.write(chunk)
    except Exception:
        destination.unlink(missing_ok=True)
        raise
    _require(size == archive["byteSize"], "trusted gh archive size mismatch")
    _require(digest.hexdigest() == archive["sha256"], "trusted gh archive digest mismatch")


def _extract_binary(archive_path: Path, output: Path, descriptor: dict[str, Any]) -> None:
    archive = descriptor["archive"]
    binary = descriptor["binary"]
    with tarfile.open(archive_path, mode="r:gz") as tar:
        members = tar.getmembers()
        _require(len(members) == archive["memberCount"], "trusted gh member count mismatch")
        _require(len({member.name for member in members}) == len(members), "duplicate archive member")
        _require(
            sum(member.size for member in members) == archive["expandedByteSize"],
            "trusted gh expanded size mismatch",
        )
        for member in members:
            path = PurePosixPath(member.name)
            _require(
                not path.is_absolute() and ".." not in path.parts,
                "unsafe trusted gh archive path",
            )
            _require(member.isdir() or member.isfile(), "unsafe trusted gh archive member type")
        targets = [
            member
            for member in members
            if member.name == binary["relativeMember"] and member.isfile()
        ]
        _require(len(targets) == 1, "trusted gh binary member is not exact")
        _require(targets[0].size == binary["byteSize"], "trusted gh member size mismatch")
        source = tar.extractfile(targets[0])
        _require(source is not None, "trusted gh member cannot be read")
        assert source is not None
        with output.open("xb") as sink:
            shutil.copyfileobj(source, sink, 1024 * 1024)
    output.chmod(0o755)


def materialize(descriptor_path: Path, destination: Path) -> Path:
    descriptor = load_descriptor(descriptor_path)
    _require(destination.is_absolute(), "trusted gh destination must be absolute")
    destination.mkdir(mode=0o755, parents=True, exist_ok=True)
    _require(destination.resolve(strict=True) == destination, "destination must be realpath")
    _require(stat.S_ISDIR(destination.lstat().st_mode), "destination must be a directory")
    archive_fd, archive_name = tempfile.mkstemp(prefix=".gh-archive-", dir=destination)
    os.close(archive_fd)
    archive_path = Path(archive_name)
    archive_path.unlink()
    binary_fd, binary_name = tempfile.mkstemp(prefix=".gh-binary-", dir=destination)
    os.close(binary_fd)
    binary_path = Path(binary_name)
    binary_path.unlink()
    try:
        _download_archive(archive_path, descriptor)
        _extract_binary(archive_path, binary_path, descriptor)
        verify_binary(binary_path.resolve(strict=True), descriptor)
        final = destination / "gh"
        os.replace(binary_path, final)
        verify_binary(final.resolve(strict=True), descriptor)
        return final
    finally:
        archive_path.unlink(missing_ok=True)
        binary_path.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    verify = subparsers.add_parser("verify-binary")
    verify.add_argument("--descriptor", required=True, type=Path)
    verify.add_argument("--gh-binary", required=True, type=Path)
    install = subparsers.add_parser("materialize")
    install.add_argument("--descriptor", required=True, type=Path)
    install.add_argument("--destination", required=True, type=Path)
    args = parser.parse_args()
    try:
        if args.command == "verify-binary":
            descriptor = load_descriptor(args.descriptor.resolve(strict=True))
            verify_binary(args.gh_binary, descriptor)
            print("TRUSTED_GH_BINARY=PASS")
        else:
            binary = materialize(
                args.descriptor.resolve(strict=True), args.destination
            )
            print(f"TRUSTED_GH_BINARY={binary}")
    except (OSError, subprocess.SubprocessError, tarfile.TarError, TrustedGhError) as exc:
        print(f"TRUSTED_GH_BINARY=FAIL:{exc}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
