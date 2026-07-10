#!/bin/sh
set -eu

: "${SERVICE_API_BASE_URL:?SERVICE_API_BASE_URL is required}"
: "${MAINTENANCE_RELAY_TUNNEL_ADDRESS:?MAINTENANCE_RELAY_TUNNEL_ADDRESS is required}"

private_key_path="${MAINTENANCE_RELAY_PRIVATE_KEY_PATH:-/run/secrets/maintenance_relay_private_key}"
interface_name="${MAINTENANCE_RELAY_INTERFACE:-wg0}"
relay_tunnel_address="$MAINTENANCE_RELAY_TUNNEL_ADDRESS"

case "$interface_name" in
  '' | .* | *[!abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.-]* | ????????????????)
    echo "MAINTENANCE_RELAY_INTERFACE must be a safe Linux interface name" >&2
    exit 1
    ;;
esac

test -r "$private_key_path"

if [ "$(cat /proc/sys/net/ipv4/ip_forward)" != "1" ]; then
  echo "net.ipv4.ip_forward must be configured to 1" >&2
  exit 1
fi

if ! ip link show "$interface_name" >/dev/null 2>&1; then
  ip link add "$interface_name" type wireguard
fi

runtime_directory="/run/vem/maintenance-relay"
config_directory="$(mktemp -d "$runtime_directory/vem-relay-wg-XXXXXX")"
peer_config_path="$config_directory/peers.conf"
cleanup() {
  rm -rf -- "$config_directory"
}
trap cleanup 0 1 2 15
umask 077
: >"$peer_config_path"
chmod 0600 "$peer_config_path"
/usr/local/libexec/maintenance-relay-wireguard-syncconf \
  "$interface_name" \
  "$private_key_path" \
  "$peer_config_path"
cleanup
trap - 0 1 2 15

ip address replace "$relay_tunnel_address/32" dev "$interface_name"
ip link set "$interface_name" up

exec node /app/dist/main.js
