import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { FrameDecoder, encodeFrame } from "../src/framing.ts";

/** One request frame as the fake bridge received it. */
export interface ReceivedFrame {
  jsonrpc?: string;
  id: string;
  method: string;
  params: Record<string, unknown>;
  token?: string;
  protocolVersion?: number;
}

export type FrameHandler = (frame: ReceivedFrame, connection: FakeConnection) => void;

/** One accepted connection of the fake bridge. */
export class FakeConnection {
  readonly socket: net.Socket;

  constructor(socket: net.Socket) {
    this.socket = socket;
  }

  reply(payload: unknown): void {
    this.socket.write(encodeFrame(payload));
  }

  result(frame: ReceivedFrame, result: unknown): void {
    this.reply({ jsonrpc: "2.0", id: frame.id, result });
  }

  error(frame: ReceivedFrame, code: number, message: string): void {
    this.reply({ jsonrpc: "2.0", id: frame.id, error: { code, message } });
  }

  drop(): void {
    this.socket.destroy();
  }
}

/**
 * A local TCP server that speaks the bridge framing, plus the connection.json that points at it.
 * Every test must call close(), which destroys the sockets so the suite cannot hang.
 */
export class FakeBridge {
  token: string;
  readonly frames: ReceivedFrame[] = [];
  readonly connections: FakeConnection[] = [];
  connectionPath = "";
  port = 0;
  handler: FrameHandler;

  #dir = "";
  #server: net.Server | null = null;
  #sockets = new Set<net.Socket>();

  constructor(handler: FrameHandler, token = "secret-token-for-tests") {
    this.handler = handler;
    this.token = token;
  }

  /** Starts listening on a port the system picks, or on the given one, and writes connection.json. */
  async start(port = 0): Promise<void> {
    if (this.#dir === "") {
      this.#dir = await mkdtemp(path.join(tmpdir(), "revitmcp-fake-"));
      this.connectionPath = path.join(this.#dir, "connection.json");
    }
    const server = net.createServer((socket) => this.#accept(socket));
    this.#server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.port = (server.address() as net.AddressInfo).port;
    await this.writeConnectionFile();
  }

  async writeConnectionFile(overrides: Record<string, unknown> = {}): Promise<void> {
    const info = { port: this.port, token: this.token, pid: process.pid, protocolVersion: 1, ...overrides };
    await writeFile(this.connectionPath, JSON.stringify(info));
  }

  /** Stops listening and destroys every socket, but keeps the connection file. */
  async stopListening(): Promise<void> {
    for (const socket of this.#sockets) {
      socket.destroy();
    }
    const server = this.#server;
    this.#server = null;
    if (server?.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  /** Closes the listener and every socket, and removes the temporary folder. */
  async close(): Promise<void> {
    await this.stopListening();
    if (this.#dir !== "") {
      await rm(this.#dir, { recursive: true, force: true });
    }
  }

  #accept(socket: net.Socket): void {
    const connection = new FakeConnection(socket);
    const decoder = new FrameDecoder();
    this.connections.push(connection);
    this.#sockets.add(socket);
    socket.on("close", () => this.#sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    socket.on("data", (chunk) => {
      for (const message of decoder.push(chunk)) {
        const frame = message as ReceivedFrame;
        this.frames.push(frame);
        this.handler(frame, connection);
      }
    });
  }
}

/** Returns a port that nothing listens on right now. */
export async function unusedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
