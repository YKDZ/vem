import mqtt, { type IClientOptions, type MqttClient } from "mqtt";

export type MachineMqttStatus =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected"
  | "error";

export type MachineMqttClient = {
  publish(topic: string, payload: unknown): Promise<void>;
  subscribe(
    topic: string,
    handler: (topic: string, payloadText: string) => void,
  ): Promise<void>;
  end(): void;
  isConnected(): boolean;
};

export function createMachineMqttClient(input: {
  url: string;
  clientId: string;
  username?: string;
  password?: string;
  onStatus: (status: MachineMqttStatus, error?: string) => void;
}): MachineMqttClient {
  const client: MqttClient = mqtt.connect(input.url, {
    clientId: input.clientId,
    username: input.username,
    password: input.password,
    clean: true,
    reconnectPeriod: 2_000,
    connectTimeout: 10_000,
  } satisfies IClientOptions);

  client.on("connect", () => {
    input.onStatus("connected");
  });
  client.on("reconnect", () => {
    input.onStatus("reconnecting");
  });
  client.on("close", () => {
    input.onStatus("disconnected");
  });
  client.on("error", (error) => {
    input.onStatus("error", error.message);
  });

  return {
    async publish(topic, payload) {
      await new Promise<void>((resolve, reject) => {
        client.publish(topic, JSON.stringify(payload), { qos: 1 }, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
    async subscribe(topic, handler) {
      await new Promise<void>((resolve, reject) => {
        client.subscribe(topic, { qos: 1 }, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      client.on("message", (incomingTopic, payload) => {
        if (incomingTopic === topic)
          handler(incomingTopic, payload.toString("utf8"));
      });
    },
    end() {
      client.end(true);
    },
    isConnected() {
      return client.connected;
    },
  };
}
