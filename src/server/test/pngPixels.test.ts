import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { crc32, deflateSync } from "node:zlib";

import { bandOf, decodePng, hsv, meanColour, reportColours, type Pixels } from "./pngPixels.ts";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, "latin1");
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);

  return Buffer.concat([head, body, tail]);
}

/** Writes a PNG of 8-bit pixels, applying filter `filters[row % filters.length]` to each row, as an encoder would. */
function encode(width: number, height: number, channels: number, colourType: number, rgb: number[], filters: number[], interlace = 0): Buffer {
  const stride = width * channels;
  const rows: Buffer[] = [];

  for (let row = 0; row < height; row++) {
    const filter = filters[row % filters.length]!;
    const line = Buffer.alloc(stride + 1);
    line[0] = filter;

    for (let index = 0; index < stride; index++) {
      const at = (r: number, i: number): number => rgb[r * stride + i]!;
      const left = index >= channels ? at(row, index - channels) : 0;
      const up = row > 0 ? at(row - 1, index) : 0;
      const upLeft = row > 0 && index >= channels ? at(row - 1, index - channels) : 0;
      const estimate = left + up - upLeft;
      const paeth =
        Math.abs(estimate - left) <= Math.abs(estimate - up) && Math.abs(estimate - left) <= Math.abs(estimate - upLeft)
          ? left
          : Math.abs(estimate - up) <= Math.abs(estimate - upLeft)
            ? up
            : upLeft;
      const predicted = [0, left, up, (left + up) >> 1, paeth][filter]!;

      line[index + 1] = (at(row, index) - predicted) & 0xff;
    }
    rows.push(line);
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = colourType;
  header[12] = interlace;

  return Buffer.concat([SIGNATURE, chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
}

/** A picture of `width` x `height` with `paint(x, y)` giving the colour of each pixel. */
function picture(width: number, height: number, paint: (x: number, y: number) => [number, number, number]): number[] {
  return Array.from({ length: width * height }, (_, index) => paint(index % width, Math.floor(index / width))).flat();
}

describe("PNG reader for tests", () => {
  it("reads rows written with each of the five filters back to the same pixels", () => {
    const rgb = picture(7, 10, (x, y) => [(x * 37 + y * 11) % 256, (x * 5 + y * 91) % 256, (x * y * 13) % 256]);

    for (const filters of [[0], [1], [2], [3], [4], [0, 1, 2, 3, 4]]) {
      const pixels = decodePng(encode(7, 10, 3, 2, rgb, filters));

      assert.equal(pixels.width, 7);
      assert.equal(pixels.height, 10);
      assert.equal(pixels.channels, 3);
      assert.deepEqual([...pixels.data], rgb, `filters ${filters.join(",")}`);
    }
  });

  it("reads a picture with an alpha channel, and refuses what it cannot read by name", () => {
    const rgba = Array.from({ length: 9 }, (_, index) => [(index % 3) * 40, Math.floor(index / 3) * 40, 7, 255]).flat();
    const decoded = decodePng(encode(3, 3, 4, 6, rgba, [4]));

    assert.equal(decoded.channels, 4);
    assert.deepEqual([...decoded.data], rgba);
    assert.throws(() => decodePng(encode(3, 3, 1, 3, [0, 1, 2, 0, 1, 2, 0, 1, 2], [0])), /colour type 3/);
    assert.throws(() => decodePng(encode(3, 3, 3, 2, picture(3, 3, () => [1, 2, 3]), [0], 1)), /interlace 1/);
    assert.throws(() => decodePng(Buffer.from("not a png at all")), /not a PNG/);
  });

  it("puts pure and lit colours in their band, and leaves greys and in-between hues out", () => {
    assert.equal(bandOf(hsv(255, 0, 0).hue), "red");
    assert.equal(bandOf(hsv(255, 20, 40).hue), "red");
    assert.equal(bandOf(hsv(0, 200, 0).hue), "green");
    assert.equal(bandOf(hsv(0, 0, 255).hue), "blue");
    assert.equal(bandOf(hsv(255, 255, 0).hue), null);
    assert.equal(hsv(128, 128, 128).saturation, 0);
  });

  it("reports the dominant band of a region, and nothing for grey", () => {
    const rgb = picture(100, 10, (x) => (x < 30 ? [250, 10, 10] : x < 60 ? [10, 220, 10] : x < 90 ? [20, 20, 240] : [34, 40, 48]));
    const pixels: Pixels = decodePng(encode(100, 10, 3, 2, rgb, [4]));

    assert.equal(reportColours(pixels, { left: 0, top: 0, right: 0.3, bottom: 1 }).dominant, "red");
    assert.equal(reportColours(pixels, { left: 0.3, top: 0, right: 0.6, bottom: 1 }).dominant, "green");
    assert.equal(reportColours(pixels, { left: 0.6, top: 0, right: 0.9, bottom: 1 }).dominant, "blue");

    const whole = reportColours(pixels);
    assert.equal(whole.pixels, 1000);
    assert.equal(whole.coloured, 900, "the grey tenth is not coloured");
    assert.ok(Math.abs(whole.bands.red.share - 1 / 3) < 1e-9);

    const grey = reportColours(pixels, { left: 0.9, top: 0, right: 1, bottom: 1 });
    assert.equal(grey.coloured, 0);
    assert.equal(grey.dominant, null);
  });

  it("averages a region, so that two pictures of one scene can be compared", () => {
    const rgb = picture(10, 4, (x) => (x < 5 ? [200, 0, 0] : [100, 50, 10]));
    const pixels = decodePng(encode(10, 4, 3, 2, rgb, [1]));

    assert.deepEqual(meanColour(pixels, { left: 0, top: 0, right: 0.5, bottom: 1 }), { r: 200, g: 0, b: 0 });
    assert.deepEqual(meanColour(pixels, { left: 0.5, top: 0, right: 1, bottom: 1 }), { r: 100, g: 50, b: 10 });
    assert.deepEqual(meanColour(pixels), { r: 150, g: 25, b: 5 });
  });
});
