#!/bin/sh
set -eu

: "${MQTT_USERNAME:?MQTT_USERNAME is required}"
: "${MQTT_PASSWORD:?MQTT_PASSWORD is required}"

mkdir -p /mosquitto/data
mosquitto_passwd -b -c /mosquitto/data/passwordfile "$MQTT_USERNAME" "$MQTT_PASSWORD"
exec mosquitto -c /mosquitto/config/mosquitto.conf
