import { randomUUID } from "node:crypto";
import net from "node:net";

import { readConnectionInfo } from "./connection.ts";
import {
  BridgeRequestPendingError,
  BridgeRpcError,
  RevitNotRunningError,
  RpcCodes,
  describePluginError,
} from "./errors.ts";
import type { RequestState } from "./errors.ts";
import { FrameDecoder, encodeFrame } from "./framing.ts";

/** The protocol version this server speaks. `src/contract/protocol.json` must state the same. */
export const PROTOCOL_VERSION = 1;

/** How long a call waits for Revit before it cancels the request. */
export const DEFAULT_TIMEOUT_MS = 60_000;

export interface CallOptions {
  /** Milliseconds to wait for the answer. Defaults to {@link DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number;
}

export interface BridgeClientOptions {
  /** How many times to try again when connecting fails. Defaults to 2. */
  connectRetries?: number;
  /** Pause between connection attempts. Defaults to 250 ms. */
  connectRetryDelayMs?: number;
  /** How long one connection attempt may take. Defaults to 5000 ms. */
  connectTimeoutMs?: number;
  /** How long to wait for the answer to `cancel_request` after a timeout. Defaults to 5000 ms. */
  cancelTimeoutMs?: number;
  /** Called before every connection attempt of a call, with the id that call will use. For diagnostics and tests. */
  onConnectAttempt?: (requestId: string, attempt: number) => void;
}

const REQUEST_STATES: readonly string[] = ["queued", "running", "succeeded", "failed", "cancelled", "unknown"];

/** Connecting failed: nothing was sent, so trying again is safe. */
class ConnectFailed extends Error {
  readonly reason: string;
  readonly port: number;
  readonly pid: number;

  constructor(reason: string, port: number, pid: number) {
    super(`Could not connect to port ${port}: ${reason}`);
    this.name = "ConnectFailed";
    this.reason = reason;
    this.port = port;
    this.pid = pid;
  }
}

/** The wait for an answer ran out. Internal: `call` turns it into a cancel and a proper error. */
class WaitTimedOut extends Error {}

/** One socket with the token it was opened with. The token never leaves this object except in a request frame. */
class Connection {
  readonly socket: net.Socket;
  readonly token: string;
  readonly decoder = new FrameDecoder();
  closed = false;

  constructor(socket: net.Socket, token: string) {
    this.socket = socket;
    this.token = token;
  }
}

interface Pending {
  connection: Connection;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Talks to the plugin over one TCP connection, opened on the first call. Many calls may wait at once; answers are
 * matched by request id. The plugin closes a connection that sends no accepted frame within 10 s, so the first
 * frame goes out right after connecting.
 *
 * The client resends only what it knows was never sent: a failed connect is retried with the same request id. Once
 * a frame was written, a dropped connection is reported as {@link BridgeRequestPendingError} and never repeated.
 */
export class BridgeClient {
  readonly #connectionPath: string;
  readonly #options: BridgeClientOptions;
  readonly #pending = new Map<string, Pending>();
  #active: Connection | null = null;
  #connecting: Promise<Connection> | null = null;

  constructor(connectionPath: string, options: BridgeClientOptions = {}) {
    this.#connectionPath = connectionPath;
    this.#options = options;
  }

  /**
   * Sends one request and waits for its result.
   *
   * After the timeout the request is cancelled in Revit. If it had not started, the error says it was not executed.
   * If it runs, {@link BridgeRequestPendingError} carries the request id for `get_request_status`.
   *
   * @throws RevitNotRunningError Revit is not running or its plugin does not accept connections.
   * @throws BridgeRpcError The plugin answered with an error.
   * @throws BridgeRequestPendingError The outcome is unknown or still pending.
   */
  async call(method: string, params: object, options: CallOptions = {}): Promise<unknown> {
    const requestId = randomUUID();
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const connection = await this.#connectWithRetry(requestId);
    try {
      return await this.#exchange(connection, requestId, method, params, timeoutMs);
    } catch (error) {
      if (error instanceof WaitTimedOut) {
        return await this.#settleAfterTimeout(requestId, timeoutMs);
      }
      throw error;
    }
  }

  /** Closes the connection and rejects every call still waiting. The client may be used again afterwards. */
  close(): void {
    if (this.#active !== null) {
      this.#drop(this.#active, "closed");
    }
  }

  async #connectWithRetry(requestId: string): Promise<Connection> {
    const retries = this.#options.connectRetries ?? 2;
    const delayMs = this.#options.connectRetryDelayMs ?? 250;

    for (let attempt = 0; ; attempt++) {
      this.#options.onConnectAttempt?.(requestId, attempt);
      try {
        return await this.#connection();
      } catch (error) {
        // A missing or stale connection.json is not retried: waiting will not bring Revit back.
        if (!(error instanceof ConnectFailed)) {
          throw error;
        }
        if (attempt >= retries) {
          throw new RevitNotRunningError(
            `Revit (process ${error.pid}) is running, but the RevitMCP plugin does not accept connections on port ${error.port} (${error.reason}). Revit may still be starting, or the plugin failed to start. Ask the user to wait until Revit has loaded, or to restart it.`,
            { cause: error },
          );
        }
        await sleep(delayMs);
      }
    }
  }

  #connection(): Promise<Connection> {
    if (this.#active !== null && !this.#active.closed && !this.#active.socket.destroyed) {
      return Promise.resolve(this.#active);
    }

    this.#connecting ??= this.#open().finally(() => {
      this.#connecting = null;
    });
    return this.#connecting;
  }

  async #open(): Promise<Connection> {
    // Read on every connect: Revit picks a new port and a new token each time it starts.
    const info = await readConnectionInfo(this.#connectionPath);
    const socket = await connectSocket(info.port, info.pid, this.#options.connectTimeoutMs ?? 5000);

    const connection = new Connection(socket, info.token);
    socket.on("data", (chunk) => this.#onData(connection, chunk));
    socket.on("error", () => this.#drop(connection, "lost"));
    socket.on("close", () => this.#drop(connection, "lost"));
    this.#active = connection;
    return connection;
  }

  #exchange(connection: Connection, id: string, method: string, params: object, timeoutMs: number): Promise<unknown> {
    const frame = encodeFrame({ jsonrpc: "2.0", id, method, params, token: connection.token, protocolVersion: PROTOCOL_VERSION });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new WaitTimedOut());
      }, timeoutMs);
      this.#pending.set(id, { connection, resolve, reject, timer });

      connection.socket.write(frame, (error) => {
        if (error) {
          this.#drop(connection, "lost");
          this.#lose(id);
        }
      });
    });
  }

  #onData(connection: Connection, chunk: Buffer): void {
    let messages: unknown[];
    try {
      messages = connection.decoder.push(chunk);
    } catch {
      // An oversized or malformed frame: the stream is out of step, so the connection goes.
      this.#drop(connection, "lost");
      return;
    }

    for (const message of messages) {
      if (connection.closed) {
        return;
      }
      this.#dispatch(connection, message);
    }
  }

  #dispatch(connection: Connection, message: unknown): void {
    if (typeof message !== "object" || message === null) {
      return;
    }

    const { id, result, error } = message as { id?: unknown; result?: unknown; error?: unknown };
    const pending = typeof id === "string" ? this.#pending.get(id) : undefined;
    if (typeof id !== "string" || pending === undefined || pending.connection !== connection) {
      // No one waits for this id: a call that timed out, or a rejection of a frame with no usable id.
      return;
    }

    this.#pending.delete(id);
    clearTimeout(pending.timer);

    if (error !== undefined && error !== null) {
      const failure = toRpcError(error);
      pending.reject(failure);
      if (failure.code === RpcCodes.unauthorized || failure.code === RpcCodes.protocolMismatch) {
        // The connection.json this socket came from is out of date. The next call reads it again.
        this.#drop(connection, "lost");
      }
      return;
    }

    pending.resolve(result === undefined ? null : result);
  }

  /** Marks the connection dead, destroys the socket, and rejects every call that waits on it. */
  #drop(connection: Connection, why: "lost" | "closed"): void {
    if (connection.closed) {
      return;
    }

    connection.closed = true;
    if (this.#active === connection) {
      this.#active = null;
    }
    connection.socket.destroy();

    for (const [id, pending] of this.#pending) {
      if (pending.connection === connection) {
        this.#pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(
          why === "closed"
            ? new Error("The bridge client was closed.")
            : new BridgeRequestPendingError(id, "unknown", "The connection to Revit was lost before the answer arrived."),
        );
      }
    }
  }

  /** Rejects a call whose frame could not be written, if it still waits. */
  #lose(id: string): void {
    const pending = this.#pending.get(id);
    if (pending !== undefined) {
      this.#pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(new BridgeRequestPendingError(id, "unknown", "The request could not be written to the connection to Revit."));
    }
  }

  /** The timeout passed: ask Revit to cancel, then report what became of the request. */
  async #settleAfterTimeout(requestId: string, timeoutMs: number): Promise<unknown> {
    const waited = `Timed out after ${formatSeconds(timeoutMs)} waiting for Revit.`;

    let answer: unknown;
    try {
      const connection = await this.#connection();
      answer = await this.#exchange(
        connection,
        randomUUID(),
        "cancel_request",
        { requestId },
        this.#options.cancelTimeoutMs ?? 5000,
      );
    } catch {
      throw new BridgeRequestPendingError(requestId, "unknown", `${waited} Revit did not confirm the cancellation.`);
    }

    const status = readStatus(answer);
    switch (status.state) {
      case "cancelled":
        throw new BridgeRpcError(
          RpcCodes.notExecuted,
          `${waited} The request was cancelled while it was still queued, so the command was not executed and nothing in the Revit project changed. Revit may be busy or showing a dialog; check get_status before trying again.`,
          { state: status.state },
        );
      case "succeeded":
        // It finished between the timeout and the cancel, so the result is still good.
        return status.result ?? null;
      case "failed":
        throw toRpcError(status.error);
      default:
        throw new BridgeRequestPendingError(requestId, status.state, waited);
    }
  }
}

interface Status {
  state: RequestState;
  result?: unknown;
  error?: unknown;
}

function readStatus(answer: unknown): Status {
  const value = (typeof answer === "object" && answer !== null ? answer : {}) as Record<string, unknown>;
  const state = typeof value["state"] === "string" && REQUEST_STATES.includes(value["state"]) ? (value["state"] as RequestState) : "unknown";
  return { state, result: value["result"], error: value["error"] };
}

function toRpcError(error: unknown): BridgeRpcError {
  const value = (typeof error === "object" && error !== null ? error : {}) as Record<string, unknown>;
  if (typeof value["code"] !== "number" || typeof value["message"] !== "string") {
    return new BridgeRpcError(RpcCodes.internalError, "The plugin sent an error that could not be read.", undefined);
  }

  return new BridgeRpcError(value["code"], describePluginError(value["code"], value["message"]), { pluginMessage: value["message"] });
}

function connectSocket(port: number, pid: number, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.setNoDelay(true);
    let settled = false;

    const fail = (reason: string): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        reject(new ConnectFailed(reason, port, pid));
      }
    };
    const timer = setTimeout(() => fail("timed out"), timeoutMs);

    // Kept after the connection is up, so an error in the gap before the real handlers are attached is not fatal.
    socket.on("error", (error: NodeJS.ErrnoException) => fail(error.code ?? "connection error"));
    socket.once("connect", () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(socket);
      }
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatSeconds(ms: number): string {
  const seconds = ms / 1000;
  return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)} s`;
}
