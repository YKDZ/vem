export function normalizeMqttWebSocketUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (trimmed.startsWith("ws://") || trimmed.startsWith("wss://")) {
    return trimmed;
  }

  if (trimmed.startsWith("mqtt://")) {
    const rest = trimmed.slice("mqtt://".length);
    const [hostPort, ...pathParts] = rest.split("/");
    const [host, port] = hostPort.split(":");
    const wsPort = !port || port === "1883" ? "9001" : port;
    const path = pathParts.length > 0 ? "/" + pathParts.join("/") : "/";
    return `ws://${host}:${wsPort}${path}`;
  }

  if (trimmed.startsWith("mqtts://")) {
    const rest = trimmed.slice("mqtts://".length);
    const [hostPort, ...pathParts] = rest.split("/");
    const [host, port] = hostPort.split(":");
    const wsPort = !port || port === "8883" ? "" : `:${port}`;
    const path = pathParts.length > 0 ? "/" + pathParts.join("/") : "/";
    return `wss://${host}${wsPort}${path}`;
  }

  throw new Error(`Unsupported MQTT URL: ${trimmed}`);
}
