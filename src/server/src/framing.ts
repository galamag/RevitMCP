/** Largest JSON payload of one frame, in bytes. The plugin refuses anything larger (`Limits.MaxFrameBytes`). */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

const HEADER_BYTES = 4;

/** The peer broke the framing rules. The connection cannot be trusted after this and must be destroyed. */
export class FrameError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "FrameError";
  }
}

/** Encodes one frame: a 4-byte big-endian payload length, then the payload as UTF-8 JSON. */
export function encodeFrame(payload: unknown): Buffer {
  const json = JSON.stringify(payload);
  if (json === undefined) {
    throw new FrameError("The payload cannot be written as JSON.");
  }

  const body = Buffer.from(json, "utf8");
  if (body.length > MAX_FRAME_BYTES) {
    throw new FrameError(`The payload takes ${body.length} bytes, more than the frame limit of ${MAX_FRAME_BYTES} bytes.`);
  }

  const frame = Buffer.allocUnsafe(HEADER_BYTES + body.length);
  frame.writeUInt32BE(body.length, 0);
  body.copy(frame, HEADER_BYTES);
  return frame;
}

/**
 * Reassembles frames from the chunks a socket delivers, which may cut a frame anywhere, even inside its header
 * or inside a multi-byte character. After the first error it keeps throwing: the stream is out of step.
 */
export class FrameDecoder {
  #chunks: Buffer[] = [];
  #buffered = 0;
  #expected: number | null = null;
  #failure: FrameError | null = null;

  /** Adds a chunk and returns every message that is now complete, in order. */
  push(chunk: Buffer): unknown[] {
    if (this.#failure !== null) {
      throw this.#failure;
    }

    try {
      return this.#decode(chunk);
    } catch (error) {
      this.#failure = error instanceof FrameError ? error : new FrameError("The frame could not be decoded.", { cause: error });
      this.#chunks = [];
      this.#buffered = 0;
      throw this.#failure;
    }
  }

  #decode(chunk: Buffer): unknown[] {
    if (chunk.length > 0) {
      this.#chunks.push(chunk);
      this.#buffered += chunk.length;
    }

    const messages: unknown[] = [];
    for (;;) {
      if (this.#expected === null) {
        if (this.#buffered < HEADER_BYTES) {
          break;
        }

        const length = this.#take(HEADER_BYTES).readUInt32BE(0);
        if (length > MAX_FRAME_BYTES) {
          // Refused on the header alone, before any of the payload is buffered.
          throw new FrameError(`A frame declares ${length} bytes, more than the limit of ${MAX_FRAME_BYTES} bytes.`);
        }
        this.#expected = length;
      }

      if (this.#buffered < this.#expected) {
        break;
      }

      const payload = this.#take(this.#expected);
      this.#expected = null;
      messages.push(parse(payload));
    }

    return messages;
  }

  /** Removes the first `count` buffered bytes. Joins chunks only when a frame spans several of them. */
  #take(count: number): Buffer {
    this.#buffered -= count;

    const first = this.#chunks[0];
    if (first !== undefined && first.length >= count) {
      if (first.length === count) {
        this.#chunks.shift();
      } else {
        this.#chunks[0] = first.subarray(count);
      }
      return first.subarray(0, count);
    }

    const joined = Buffer.concat(this.#chunks);
    const rest = joined.subarray(count);
    this.#chunks = rest.length > 0 ? [rest] : [];
    return joined.subarray(0, count);
  }
}

function parse(payload: Buffer): unknown {
  try {
    return JSON.parse(payload.toString("utf8"));
  } catch (error) {
    throw new FrameError("A frame does not hold valid JSON.", { cause: error });
  }
}
