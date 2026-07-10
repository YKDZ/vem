import type { MaintenanceRelayTransport } from "@vem/shared/schemas/maintenance-access";

import { createServer, type Server } from "node:http";

export class RelayManagementHealthServer {
  private server: Server | undefined;

  constructor(
    private readonly transport: MaintenanceRelayTransport,
    private readonly port: number,
  ) {}

  get url(): string {
    const address = this.server?.address();
    if (!address || typeof address === "string") {
      throw new Error("management health server is not listening");
    }
    return `http://127.0.0.1:${address.port}`;
  }

  async start(): Promise<void> {
    if (this.server) return;
    this.server = createServer((request, response) => {
      if (request.url !== "/healthz") {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          status: this.transport.health,
          transport: this.transport,
        }),
      );
    });
    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(this.port, "127.0.0.1", () => {
        this.server?.off("error", reject);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = undefined;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
}
