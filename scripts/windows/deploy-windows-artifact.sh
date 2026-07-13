#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  deploy-windows-artifact.sh --artifact PATH --remote USER@HOST --kind daemon|ui [--identity KEY] [--ssh-config]

Builds a zip, uploads it to the Win10 machine in chunks, verifies hashes on the
remote host, then installs the artifact:
  daemon -> C:\VEM\bringup\vending-daemon.exe and restarts VemVendingDaemon
  ui     -> C:\VEM\bringup\machine.exe and restarts VEMMachineUI

Vision is intentionally not supported here. This uploader creates a new zip,
which would change the immutable vendor release boundary. Use
install-vision-release.ps1 with the approved original bundle and release metadata.
EOF
}

artifact=""
remote=""
identity=""
kind=""
chunk_size="512k"
use_ssh_config=0
ssh_extra=(-o ProxyCommand=none -o ConnectTimeout=30)

while [[ $# -gt 0 ]]; do
  case "$1" in
    --artifact)
      artifact="${2:?missing --artifact value}"
      shift 2
      ;;
    --remote)
      remote="${2:?missing --remote value}"
      shift 2
      ;;
    --identity)
      identity="${2:?missing --identity value}"
      shift 2
      ;;
    --kind)
      kind="${2:?missing --kind value}"
      shift 2
      ;;
    --chunk-size)
      chunk_size="${2:?missing --chunk-size value}"
      shift 2
      ;;
    --ssh-config)
      use_ssh_config=1
      ssh_extra=(-o ConnectTimeout=30)
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "$artifact" || -z "$remote" || -z "$kind" ]]; then
  usage >&2
  exit 2
fi
if [[ "$kind" != "daemon" && "$kind" != "ui" ]]; then
  echo "--kind must be daemon or ui; install Vision through install-vision-release.ps1" >&2
  exit 2
fi
if [[ ! -e "$artifact" ]]; then
  echo "artifact not found: $artifact" >&2
  exit 1
fi
if [[ ! -f "$artifact" ]]; then
  echo "$kind artifact must be a file: $artifact" >&2
  exit 1
fi
if [[ -n "$identity" ]]; then
  ssh_extra+=(-i "$identity")
fi

ssh_cmd=(ssh "${ssh_extra[@]}" "$remote")
scp_base=(scp -q "${ssh_extra[@]}")

remote_ps() {
  local script="$1"
  local encoded
  encoded="$(python3 - "$script" <<'PY'
import base64
import sys
script = sys.argv[1]
print(base64.b64encode(script.encode("utf-16le")).decode("ascii"))
PY
)"
  "${ssh_cmd[@]}" "powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand $encoded"
}

hash_input() {
  if [[ -f "$1" ]]; then
    sha256sum "$1" | awk '{print $1}'
  else
    (cd "$1" && find . -type f -print0 | sort -z | xargs -0 sha256sum) |
      sha256sum | awk '{print $1}'
  fi
}

artifact_hash="$(hash_input "$artifact")"
hash8="${artifact_hash:0:8}"
work_root=".tmp/vem-machine-ops"
work_dir="$work_root/${kind}-${hash8}"
zip_path="$work_dir/${kind}-${hash8}.zip"
chunk_dir="$work_dir/chunks"
remote_root='C:\VEM\bringup\artifacts'
remote_chunk_dir="$remote_root\\${kind}-${hash8}-chunks"
remote_zip="$remote_root\\${kind}-${hash8}.zip"
remote_extract="$remote_root\\${kind}-${hash8}-extract"

rm -rf "$work_dir"
mkdir -p "$chunk_dir"

name="$(basename "$artifact")"
zip -9 -j "$zip_path" "$artifact" >/dev/null

zip_hash="$(sha256sum "$zip_path" | awk '{print $1}')"
split -b "$chunk_size" -d -a 3 "$zip_path" "$chunk_dir/part-"

echo "artifact: $artifact"
echo "artifact sha256: $artifact_hash"
echo "zip sha256: $zip_hash"
echo "chunks: $(find "$chunk_dir" -type f | wc -l)"

remote_ps "\$ErrorActionPreference='Stop'
Remove-Item '$remote_chunk_dir' -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path '$remote_chunk_dir' -Force | Out-Null
"

count=0
for part in "$chunk_dir"/part-*; do
  count=$((count + 1))
  base="$(basename "$part")"
  ok=0
  for attempt in 1 2 3; do
    echo "upload $count $base attempt $attempt"
    if timeout 120s "${scp_base[@]}" "$part" "$remote:C:/VEM/bringup/artifacts/${kind}-${hash8}-chunks/$base"; then
      ok=1
      break
    fi
    remote_ps "Get-Process sftp-server -ErrorAction SilentlyContinue | Stop-Process -Force" || true
    sleep 2
  done
  if [[ "$ok" -ne 1 ]]; then
    echo "failed to upload chunk: $base" >&2
    exit 1
  fi
done

remote_ps "\$ErrorActionPreference='Stop'
\$zip = '$remote_zip'
\$chunkDir = '$remote_chunk_dir'
New-Item -ItemType Directory -Path '$remote_root' -Force | Out-Null
Remove-Item \$zip -Force -ErrorAction SilentlyContinue
\$fs = [System.IO.File]::Create(\$zip)
try {
  Get-ChildItem (Join-Path \$chunkDir 'part-*') | Sort-Object Name | ForEach-Object {
    \$bytes = [System.IO.File]::ReadAllBytes(\$_.FullName)
    \$fs.Write(\$bytes, 0, \$bytes.Length)
  }
} finally {
  \$fs.Close()
}
\$zipHash = (Get-FileHash \$zip -Algorithm SHA256).Hash.ToLowerInvariant()
if (\$zipHash -ne '$zip_hash') { throw \"zip hash mismatch: \$zipHash\" }
\$extract = '$remote_extract'
Remove-Item \$extract -Recurse -Force -ErrorAction SilentlyContinue
Expand-Archive -Path \$zip -DestinationPath \$extract -Force
Write-Output \"verified zip \$zipHash\"
"

if [[ "$kind" == "daemon" ]]; then
  name="$(basename "$artifact")"
  remote_ps "\$ErrorActionPreference='Stop'
\$src = Join-Path '$remote_extract' '$name'
\$srcHash = (Get-FileHash \$src -Algorithm SHA256).Hash.ToLowerInvariant()
if (\$srcHash -ne '$artifact_hash') { throw \"artifact hash mismatch: \$srcHash\" }
\$dst = 'C:\VEM\bringup\vending-daemon.exe'
\$backup = \$dst + '.bak-' + (Get-Date -Format 'yyyyMMddHHmmss')
Stop-Service VemVendingDaemon -Force
Start-Sleep -Seconds 2
Copy-Item \$dst \$backup -Force
Copy-Item \$src \$dst -Force
Start-Service VemVendingDaemon
Start-Sleep -Seconds 3
Get-Service VemVendingDaemon | Format-List Name,Status,StartType
Get-FileHash \$dst -Algorithm SHA256 | Format-List
"
elif [[ "$kind" == "ui" ]]; then
  name="$(basename "$artifact")"
  remote_ps "\$ErrorActionPreference='Stop'
\$src = Join-Path '$remote_extract' '$name'
\$srcHash = (Get-FileHash \$src -Algorithm SHA256).Hash.ToLowerInvariant()
if (\$srcHash -ne '$artifact_hash') { throw \"artifact hash mismatch: \$srcHash\" }
\$dst = 'C:\VEM\bringup\machine.exe'
\$backup = \$dst + '.bak-' + (Get-Date -Format 'yyyyMMddHHmmss')
Stop-ScheduledTask -TaskName VEMMachineUI -ErrorAction SilentlyContinue
Get-Process machine -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2
Copy-Item \$dst \$backup -Force
Copy-Item \$src \$dst -Force
Get-FileHash \$dst -Algorithm SHA256 | Format-List
Start-ScheduledTask -TaskName VEMMachineUI
Start-Sleep -Seconds 5
Get-Process machine -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,Path | Format-Table -AutoSize
"
fi

echo "deployed $kind artifact $artifact_hash"
