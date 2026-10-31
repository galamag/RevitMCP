import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FrameDecoder, FrameError, MAX_FRAME_BYTES, encodeFrame } from "../src/framing.ts";

const russian = { jsonrpc: "2.0", id: "1", result: { name: "Стена — наружная, 200 мм", emoji: "🏠" } };

function header(length: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(length);
  return buffer;
}

describe("framing", () => {
  it("encodes a 4-byte big-endian length followed by UTF-8 JSON", () => {
    const frame = encodeFrame(russian);
    const json = Buffer.from(JSON.stringify(russian), "utf8");

    assert.equal(frame.readUInt32BE(0), json.length);
    assert.deepEqual(frame.subarray(4), json);
    assert.ok(json.length > JSON.stringify(russian).length, "Cyrillic takes more bytes than characters");
  });

  it("decodes frame split at every byte", () => {
    const frame = encodeFrame(russian);

    for (let cut = 0; cut <= frame.length; cut++) {
      const decoder = new FrameDecoder();
      const messages = [...decoder.push(frame.subarray(0, cut)), ...decoder.push(frame.subarray(cut))];
      assert.deepEqual(messages, [russian], `cut at byte ${cut}`);
    }
  });

  it("decodes a frame delivered one byte at a time", () => {
    const decoder = new FrameDecoder();
    const messages: unknown[] = [];
    for (const byte of encodeFrame(russian)) {
      messages.push(...decoder.push(Buffer.from([byte])));
    }

    assert.deepEqual(messages, [russian]);
  });

  it("decodes several frames from one chunk and keeps a partial tail", () => {
    const first = { id: "a" };
    const second = { id: "б" };
    const third = { id: "c" };
    const all = Buffer.concat([encodeFrame(first), encodeFrame(second), encodeFrame(third)]);
    const decoder = new FrameDecoder();

    assert.deepEqual(decoder.push(all.subarray(0, all.length - 3)), [first, second]);
    assert.deepEqual(decoder.push(all.subarray(all.length - 3)), [third]);
  });

  it("accepts a frame of exactly the maximum size", () => {
    const filler = "x".repeat(MAX_FRAME_BYTES - '{"v":""}'.length);
    const payload = { v: filler };
    const frame = encodeFrame(payload);

    assert.equal(frame.length, 4 + MAX_FRAME_BYTES);
    const decoder = new FrameDecoder();
    assert.deepEqual(decoder.push(frame), [payload]);
  });

  it("refuses to encode a payload over 16 MB", () => {
    assert.equal(MAX_FRAME_BYTES, 16 * 1024 * 1024);
    assert.throws(() => encodeFrame({ v: "x".repeat(MAX_FRAME_BYTES) }), FrameError);
  });

  it("rejects a frame over 16 MB as soon as its header arrives", () => {
    const decoder = new FrameDecoder();

    assert.throws(() => decoder.push(header(MAX_FRAME_BYTES + 1)), FrameError);
  });

  it("keeps failing after a bad frame, so the connection cannot be reused", () => {
    const decoder = new FrameDecoder();
    assert.throws(() => decoder.push(header(0xffffffff)), FrameError);

    assert.throws(() => decoder.push(encodeFrame({ ok: true })), FrameError);
  });

  it("rejects a header split across chunks that declares too much", () => {
    const decoder = new FrameDecoder();
    const bad = header(MAX_FRAME_BYTES + 1);
    decoder.push(bad.subarray(0, 2));

    assert.throws(() => decoder.push(bad.subarray(2)), FrameError);
  });

  it("rejects a payload that is not JSON", () => {
    const payload = Buffer.from("not json", "utf8");
    const decoder = new FrameDecoder();

    assert.throws(() => decoder.push(Buffer.concat([header(payload.length), payload])), FrameError);
  });

  it("rejects an empty payload", () => {
    const decoder = new FrameDecoder();

    assert.throws(() => decoder.push(header(0)), FrameError);
  });
});
