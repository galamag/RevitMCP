import { inflateSync } from "node:zlib";

// A small PNG reader for tests, so that a test can check what a snapshot shows without a package for it. It reads what
// Revit exports: 8 bits per channel, not interlaced. Anything else is refused by name rather than read wrongly.

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The channels in a pixel for each PNG colour type that this reader takes: grey, RGB, grey with alpha, RGBA. */
const CHANNELS_BY_COLOUR_TYPE: Readonly<Record<number, number>> = { 0: 1, 2: 3, 4: 2, 6: 4 };

export interface Pixels {
  width: number;
  height: number;
  /** The channels of a pixel in `data`, 3 for RGB. */
  channels: number;
  /** Row by row, from the top, `channels` bytes a pixel. */
  data: Uint8Array;
}

/** A part of the picture, as fractions of its width and height from the top left corner, from 0 to 1. */
export interface Region {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export type Band = "red" | "green" | "blue";

/** A box of pixels, edges included, with the number of pixels of the band that it holds. */
export interface PixelBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
  count: number;
}

export interface BandStats {
  /** The pixels of the band in the region. */
  count: number;
  /** The share of the coloured pixels of the region that fall in this band, from 0 to 1. */
  share: number;
}

export interface ColourReport {
  /** The pixels of the region, coloured or not. */
  pixels: number;
  /** The pixels that have a hue at all: neither grey nor nearly black. */
  coloured: number;
  bands: Record<Band, BandStats>;
  /** The band with most pixels, or null when no pixel in the region is coloured. */
  dominant: Band | null;
}

/** A pixel counts as coloured from this saturation and this brightness up. Lit grey walls and the grey canvas stay below. */
const MIN_SATURATION = 0.35;
const MIN_VALUE = 0.2;

/** The hue ranges, in degrees, of the bands. Red wraps around 0. */
const GREEN_HUE = { from: 80, to: 160 };
const BLUE_HUE = { from: 190, to: 270 };
const RED_HUE_BELOW = 30;
const RED_HUE_ABOVE = 330;

export function decodePng(png: Buffer): Pixels {
  if (!png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error("not a PNG");
  }

  const header = { width: 0, height: 0, bitDepth: 0, colourType: -1, interlace: -1 };
  const compressed: Buffer[] = [];

  for (let offset = PNG_SIGNATURE.length; offset + 8 <= png.length; ) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("latin1", offset + 4, offset + 8);
    const body = png.subarray(offset + 8, offset + 8 + length);

    if (type === "IHDR") {
      header.width = body.readUInt32BE(0);
      header.height = body.readUInt32BE(4);
      header.bitDepth = body.readUInt8(8);
      header.colourType = body.readUInt8(9);
      header.interlace = body.readUInt8(12);
    } else if (type === "IDAT") {
      compressed.push(body);
    }
    offset += length + 12;
  }

  const channels = CHANNELS_BY_COLOUR_TYPE[header.colourType];
  if (channels === undefined || header.bitDepth !== 8 || header.interlace !== 0) {
    throw new Error(`unsupported PNG: colour type ${header.colourType}, ${header.bitDepth} bits, interlace ${header.interlace}`);
  }

  return { width: header.width, height: header.height, channels, data: unfilter(inflateSync(Buffer.concat(compressed)), header.width, header.height, channels) };
}

/** Undoes the five PNG row filters, which is what makes the raw bytes of a row the pixels. */
function unfilter(raw: Buffer, width: number, height: number, channels: number): Uint8Array {
  const stride = width * channels;
  const out = new Uint8Array(stride * height);

  for (let row = 0; row < height; row++) {
    const filter = raw[row * (stride + 1)];
    const source = row * (stride + 1) + 1;
    const target = row * stride;

    for (let index = 0; index < stride; index++) {
      const left = index >= channels ? out[target + index - channels]! : 0;
      const up = row > 0 ? out[target + index - stride]! : 0;
      const upLeft = row > 0 && index >= channels ? out[target + index - stride - channels]! : 0;
      const byte = raw[source + index]!;

      out[target + index] = (byte + predictor(filter, left, up, upLeft)) & 0xff;
    }
  }

  return out;
}

function predictor(filter: number | undefined, left: number, up: number, upLeft: number): number {
  switch (filter) {
    case 0:
      return 0;
    case 1:
      return left;
    case 2:
      return up;
    case 3:
      return (left + up) >> 1;
    case 4:
      return paeth(left, up, upLeft);
    default:
      throw new Error(`unknown PNG row filter ${String(filter)}`);
  }
}

function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toUpLeft = Math.abs(estimate - upLeft);

  return toLeft <= toUp && toLeft <= toUpLeft ? left : toUp <= toUpLeft ? up : upLeft;
}

/** The hue in degrees from 0 to 360, the saturation and the brightness, each from 0 to 1. */
export function hsv(red: number, green: number, blue: number): { hue: number; saturation: number; value: number } {
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const spread = max - min;

  let hue = 0;
  if (spread > 0) {
    hue = max === red ? ((green - blue) / spread) % 6 : max === green ? (blue - red) / spread + 2 : (red - green) / spread + 4;
    hue = (hue * 60 + 360) % 360;
  }

  return { hue, saturation: max === 0 ? 0 : spread / max, value: max / 255 };
}

/** The band a hue falls in, or null for a hue between them, such as yellow. */
export function bandOf(hue: number): Band | null {
  if (hue < RED_HUE_BELOW || hue >= RED_HUE_ABOVE) {
    return "red";
  }
  if (hue >= GREEN_HUE.from && hue < GREEN_HUE.to) {
    return "green";
  }
  return hue >= BLUE_HUE.from && hue < BLUE_HUE.to ? "blue" : null;
}

/** Counts the coloured pixels of a region by the band of their hue. Needs a picture with colour, so not a grey one. */
export function reportColours(pixels: Pixels, region: Region = { left: 0, top: 0, right: 1, bottom: 1 }): ColourReport {
  if (pixels.channels < 3) {
    throw new Error("a grey picture has no colour to report");
  }

  const counts: Record<Band, number> = { red: 0, green: 0, blue: 0 };
  let total = 0;
  let coloured = 0;

  const columns = [Math.floor(region.left * pixels.width), Math.ceil(region.right * pixels.width)] as const;
  const rows = [Math.floor(region.top * pixels.height), Math.ceil(region.bottom * pixels.height)] as const;

  for (let y = rows[0]; y < rows[1]; y++) {
    for (let x = columns[0]; x < columns[1]; x++) {
      const at = (y * pixels.width + x) * pixels.channels;
      const { hue, saturation, value } = hsv(pixels.data[at]!, pixels.data[at + 1]!, pixels.data[at + 2]!);
      total++;

      if (saturation >= MIN_SATURATION && value >= MIN_VALUE) {
        coloured++;
        const band = bandOf(hue);
        if (band !== null) {
          counts[band]++;
        }
      }
    }
  }

  const stats = (band: Band): BandStats => ({ count: counts[band], share: coloured === 0 ? 0 : counts[band] / coloured });
  const bands = { red: stats("red"), green: stats("green"), blue: stats("blue") };
  const dominant = (["red", "green", "blue"] as const).reduce<Band | null>(
    (best, band) => (counts[band] > 0 && (best === null || counts[band] > counts[best]) ? band : best),
    null,
  );

  return { pixels: total, coloured, bands, dominant };
}

export interface HueReport {
  /** The pixels of the region, coloured or not. */
  pixels: number;
  /** The pixels that have a hue at all: neither grey nor nearly black. */
  coloured: number;
  /** The coloured pixels whose hue lies in the range. */
  inRange: number;
  /** The share of the coloured pixels that lie in the range, from 0 to 1. 0 when none is coloured. */
  share: number;
}

/**
 * Counts the coloured pixels of a region whose hue lies from `fromDeg` up to, not including, `toDeg`, in degrees. The three
 * bands of {@link reportColours} are for pure primaries: a colour in between, such as olive grass, falls in none of them,
 * and a test for it names the hues it measured.
 */
export function reportHues(pixels: Pixels, fromDeg: number, toDeg: number, region: Region = { left: 0, top: 0, right: 1, bottom: 1 }): HueReport {
  if (pixels.channels < 3) {
    throw new Error("a grey picture has no colour to report");
  }

  let total = 0;
  let coloured = 0;
  let inRange = 0;

  for (let y = Math.floor(region.top * pixels.height); y < Math.ceil(region.bottom * pixels.height); y++) {
    for (let x = Math.floor(region.left * pixels.width); x < Math.ceil(region.right * pixels.width); x++) {
      const at = (y * pixels.width + x) * pixels.channels;
      const { hue, saturation, value } = hsv(pixels.data[at]!, pixels.data[at + 1]!, pixels.data[at + 2]!);
      total++;

      if (saturation >= MIN_SATURATION && value >= MIN_VALUE) {
        coloured++;
        if (hue >= fromDeg && hue < toDeg) {
          inRange++;
        }
      }
    }
  }

  return { pixels: total, coloured, inRange, share: coloured === 0 ? 0 : inRange / coloured };
}

/**
 * The smallest box of pixels, edges included, that holds every coloured pixel of a band in a region, or null when there is none.
 * A test can find a shape by its colour this way, and then take its places from where it really stands in the picture.
 */
export function boundsOfBand(pixels: Pixels, band: Band, region: Region = { left: 0, top: 0, right: 1, bottom: 1 }): PixelBox | null {
  if (pixels.channels < 3) {
    throw new Error("a grey picture has no colour to look for");
  }

  let left = pixels.width;
  let top = pixels.height;
  let right = -1;
  let bottom = -1;
  let count = 0;

  for (let y = Math.floor(region.top * pixels.height); y < Math.ceil(region.bottom * pixels.height); y++) {
    for (let x = Math.floor(region.left * pixels.width); x < Math.ceil(region.right * pixels.width); x++) {
      const at = (y * pixels.width + x) * pixels.channels;
      const { hue, saturation, value } = hsv(pixels.data[at]!, pixels.data[at + 1]!, pixels.data[at + 2]!);

      if (saturation >= MIN_SATURATION && value >= MIN_VALUE && bandOf(hue) === band) {
        left = Math.min(left, x);
        top = Math.min(top, y);
        right = Math.max(right, x);
        bottom = Math.max(bottom, y);
        count++;
      }
    }
  }

  return count === 0 ? null : { left, top, right, bottom, count };
}

/** The mean colour of a region, each channel from 0 to 255, so that two pictures of one scene can be told apart by what they draw. */
export function meanColour(pixels: Pixels, region: Region = { left: 0, top: 0, right: 1, bottom: 1 }): { r: number; g: number; b: number } {
  if (pixels.channels < 3) {
    throw new Error("a grey picture has no colour to average");
  }

  const sums = [0, 0, 0];
  let count = 0;

  for (let y = Math.floor(region.top * pixels.height); y < Math.ceil(region.bottom * pixels.height); y++) {
    for (let x = Math.floor(region.left * pixels.width); x < Math.ceil(region.right * pixels.width); x++) {
      const at = (y * pixels.width + x) * pixels.channels;
      sums[0]! += pixels.data[at]!;
      sums[1]! += pixels.data[at + 1]!;
      sums[2]! += pixels.data[at + 2]!;
      count++;
    }
  }

  return { r: sums[0]! / count, g: sums[1]! / count, b: sums[2]! / count };
}
