/**
 * Minimal, dependency-free image I/O for Node tooling (tests and scripts/calibrate.ts): baseline JPEG and 8-bit PNG
 * decoding to RGBA, PNG encoding. Not part of the package build; the browser decodes images itself.
 */
import { crc32, deflateSync, inflateSync } from "node:zlib";

export interface RgbaImage { data: Uint8ClampedArray; width: number; height: number }

/** Decode a JPEG (baseline, Huffman, 8-bit, grey or YCbCr) or PNG (8-bit, non-interlaced) file to RGBA. */
export function decodeImage(buf: Uint8Array): RgbaImage {
  if (buf[0] === 0xff && buf[1] === 0xd8) return decodeJpeg(buf);
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return decodePng(buf);
  throw new Error("Unsupported image format (expected JPEG or PNG)");
}

// ---------------------------------------------------------------------------------------------------------------
// JPEG (ITU T.81 baseline sequential, Huffman coded)

/** Zig-zag index → natural (row-major) index. */
const NATURAL = new Int32Array([
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
]);

/** IDCT basis: COS[x * 8 + u] = c(u) · cos((2x + 1) u π / 16) / 2. */
const COS = new Float64Array(64);
for (let x = 0; x < 8; x++) for (let u = 0; u < 8; u++) COS[x * 8 + u] = ((u === 0 ? Math.SQRT1_2 : 1) * Math.cos(((2 * x + 1) * u * Math.PI) / 16)) / 2;

interface Huffman { maxcode: Int32Array; valptr: Int32Array; mincode: Int32Array; values: Uint8Array }

function buildHuffman(counts: Uint8Array, values: Uint8Array): Huffman {
  const maxcode = new Int32Array(17).fill(-1), valptr = new Int32Array(17), mincode = new Int32Array(17);
  let code = 0, k = 0;
  for (let len = 1; len <= 16; len++) {
    const n = counts[len - 1];
    if (n) { valptr[len] = k; mincode[len] = code; code += n; k += n; maxcode[len] = code - 1; }
    code <<= 1;
  }
  return { maxcode, valptr, mincode, values };
}

class BitReader {
  private bits = 0;
  private nbits = 0;
  private readonly d: Uint8Array;
  pos: number;
  constructor(d: Uint8Array, pos: number) { this.d = d; this.pos = pos; }
  bit(): number {
    if (this.nbits === 0) {
      let b = this.d[this.pos] ?? 0;
      if (b === 0xff) {
        const next = this.d[this.pos + 1];
        if (next === 0x00) this.pos += 2; // stuffed byte
        else b = 0; // a marker: feed zero bits, do not consume it
      } else this.pos++;
      this.bits = b;
      this.nbits = 8;
    }
    this.nbits--;
    return (this.bits >> this.nbits) & 1;
  }
  receive(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | this.bit();
    return v;
  }
  decode(h: Huffman): number {
    let code = this.bit(), len = 1;
    while (code > h.maxcode[len]) {
      code = (code << 1) | this.bit();
      if (++len > 16) throw new Error("JPEG: invalid Huffman code");
    }
    return h.values[h.valptr[len] + code - h.mincode[len]];
  }
  /** Byte-align and skip the RSTn marker that follows a restart interval. */
  restart(): void {
    this.nbits = 0;
    while (this.pos + 1 < this.d.length && !(this.d[this.pos] === 0xff && this.d[this.pos + 1] >= 0xd0 && this.d[this.pos + 1] <= 0xd7)) this.pos++;
    this.pos += 2;
  }
}

const extend = (v: number, t: number) => (v < 1 << (t - 1) ? v - (1 << t) + 1 : v);

interface Component { id: number; h: number; v: number; tq: number; td: number; ta: number; pred: number; bw: number; bh: number; plane: Uint8ClampedArray }

export function decodeJpeg(d: Uint8Array): RgbaImage {
  const qt: Int32Array[] = [];
  const dcTables: Huffman[] = [], acTables: Huffman[] = [];
  let comps: Component[] = [];
  let width = 0, height = 0, hmax = 1, vmax = 1, mcusX = 0, mcusY = 0, restartInterval = 0, scanned = false;
  let pos = 2;
  const u16 = (p: number) => (d[p] << 8) | d[p + 1];
  while (pos < d.length) {
    if (d[pos] !== 0xff) { pos++; continue; }
    const marker = d[pos + 1];
    if (marker === 0xff) { pos++; continue; }
    if (marker === 0xd9) break; // EOI
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { pos += 2; continue; }
    const len = u16(pos + 2), seg = pos + 4, end = pos + 2 + len;
    if (marker === 0xdb) { // DQT
      for (let p = seg; p < end;) {
        const pq = d[p] >> 4, tq = d[p] & 15;
        p++;
        const t = new Int32Array(64);
        for (let i = 0; i < 64; i++) { t[i] = pq ? u16(p) : d[p]; p += pq ? 2 : 1; }
        qt[tq] = t;
      }
    } else if (marker === 0xc4) { // DHT
      for (let p = seg; p < end;) {
        const tc = d[p] >> 4, th = d[p] & 15;
        const counts = d.subarray(p + 1, p + 17);
        const n = counts.reduce((a, b) => a + b, 0);
        const table = buildHuffman(counts, d.slice(p + 17, p + 17 + n));
        if (tc === 0) dcTables[th] = table; else acTables[th] = table;
        p += 17 + n;
      }
    } else if (marker === 0xdd) { // DRI
      restartInterval = u16(seg);
    } else if (marker === 0xc0 || marker === 0xc1) { // SOF0 / SOF1 (Huffman, sequential)
      if (d[seg] !== 8) throw new Error("JPEG: only 8-bit samples are supported");
      height = u16(seg + 1);
      width = u16(seg + 3);
      const n = d[seg + 5];
      comps = [];
      for (let i = 0; i < n; i++) {
        const b = seg + 6 + i * 3;
        comps.push({ id: d[b], h: d[b + 1] >> 4, v: d[b + 1] & 15, tq: d[b + 2], td: 0, ta: 0, pred: 0, bw: 0, bh: 0, plane: new Uint8ClampedArray(0) });
      }
      hmax = Math.max(...comps.map((c) => c.h));
      vmax = Math.max(...comps.map((c) => c.v));
      mcusX = Math.ceil(width / (8 * hmax));
      mcusY = Math.ceil(height / (8 * vmax));
      for (const c of comps) {
        c.bw = mcusX * c.h;
        c.bh = mcusY * c.v;
        c.plane = new Uint8ClampedArray(c.bw * 8 * c.bh * 8);
      }
    } else if (marker >= 0xc2 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      throw new Error("JPEG: only baseline (sequential Huffman) files are supported");
    } else if (marker === 0xda) { // SOS
      const ns = d[seg];
      const scomps: Component[] = [];
      for (let i = 0; i < ns; i++) {
        const c = comps.find((x) => x.id === d[seg + 1 + i * 2]);
        if (!c) throw new Error("JPEG: scan references an unknown component");
        c.td = d[seg + 2 + i * 2] >> 4;
        c.ta = d[seg + 2 + i * 2] & 15;
        c.pred = 0;
        scomps.push(c);
      }
      pos = decodeScan(d, end, scomps, qt, dcTables, acTables, restartInterval, mcusX, mcusY, width, height, hmax, vmax);
      scanned = true;
      continue;
    }
    pos = end;
  }
  if (!scanned || !width || !height) throw new Error("JPEG: no image data");
  return toRgba(comps, width, height, hmax, vmax);
}

function decodeScan(d: Uint8Array, start: number, scomps: Component[], qt: Int32Array[], dcT: Huffman[], acT: Huffman[], restartInterval: number,
  mcusX: number, mcusY: number, width: number, height: number, hmax: number, vmax: number): number {
  const br = new BitReader(d, start);
  const coef = new Int32Array(64);
  const block = (c: Component, bx: number, by: number) => {
    const q = qt[c.tq];
    coef.fill(0);
    const t = br.decode(dcT[c.td]);
    c.pred += t === 0 ? 0 : extend(br.receive(t), t);
    coef[0] = c.pred * q[0];
    for (let k = 1; k < 64;) {
      const rs = br.decode(acT[c.ta]);
      const r = rs >> 4, s = rs & 15;
      if (s === 0) { if (r === 15) { k += 16; continue; } break; }
      k += r;
      if (k > 63) break;
      coef[NATURAL[k]] = extend(br.receive(s), s) * q[k];
      k++;
    }
    idctInto(coef, c.plane, c.bw * 8, bx * 8, by * 8);
  };
  // a single-component scan is non-interleaved: its MCU is one block and it covers only the component's own extent
  const single = scomps.length === 1;
  const total = single
    ? Math.ceil(Math.ceil((width * scomps[0].h) / hmax) / 8) * Math.ceil(Math.ceil((height * scomps[0].v) / vmax) / 8)
    : mcusX * mcusY;
  const perRow = single ? Math.ceil(Math.ceil((width * scomps[0].h) / hmax) / 8) : mcusX;
  for (let m = 0; m < total; m++) {
    if (restartInterval && m > 0 && m % restartInterval === 0) {
      br.restart();
      for (const c of scomps) c.pred = 0;
    }
    const mx = m % perRow, my = Math.floor(m / perRow);
    if (single) block(scomps[0], mx, my);
    else for (const c of scomps) for (let v = 0; v < c.v; v++) for (let h = 0; h < c.h; h++) block(c, mx * c.h + h, my * c.v + v);
  }
  // continue after the entropy-coded segment: the next marker that is not a stuffed byte or RSTn
  let p = br.pos;
  while (p + 1 < d.length && !(d[p] === 0xff && d[p + 1] !== 0x00 && !(d[p + 1] >= 0xd0 && d[p + 1] <= 0xd7))) p++;
  return p;
}

const tmp = new Float64Array(64);
function idctInto(coef: Int32Array, plane: Uint8ClampedArray, stride: number, x0: number, y0: number): void {
  for (let v = 0; v < 8; v++) {
    for (let x = 0; x < 8; x++) {
      let s = 0;
      for (let u = 0; u < 8; u++) s += COS[x * 8 + u] * coef[v * 8 + u];
      tmp[v * 8 + x] = s;
    }
  }
  for (let y = 0; y < 8; y++) {
    const row = (y0 + y) * stride + x0;
    for (let x = 0; x < 8; x++) {
      let s = 0;
      for (let v = 0; v < 8; v++) s += COS[y * 8 + v] * tmp[v * 8 + x];
      plane[row + x] = Math.round(s + 128);
    }
  }
}

function toRgba(comps: Component[], width: number, height: number, hmax: number, vmax: number): RgbaImage {
  const out = new Uint8ClampedArray(width * height * 4);
  const sample = (c: Component, x: number, y: number) => c.plane[Math.floor((y * c.v) / vmax) * c.bw * 8 + Math.floor((x * c.h) / hmax)];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (comps.length === 1) {
        out[i] = out[i + 1] = out[i + 2] = sample(comps[0], x, y);
      } else if (comps.length === 3) {
        const Y = sample(comps[0], x, y), cb = sample(comps[1], x, y) - 128, cr = sample(comps[2], x, y) - 128;
        out[i] = Y + 1.402 * cr;
        out[i + 1] = Y - 0.344136 * cb - 0.714136 * cr;
        out[i + 2] = Y + 1.772 * cb;
      } else throw new Error("JPEG: only greyscale and YCbCr images are supported");
      out[i + 3] = 255;
    }
  }
  return { data: out, width, height };
}

// ---------------------------------------------------------------------------------------------------------------
// PNG (8-bit greyscale, grey+alpha, RGB or RGBA; not interlaced)

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function decodePng(buf: Uint8Array): RgbaImage {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (!b.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("PNG: bad signature");
  let width = 0, height = 0, depth = 0, colorType = 0, interlace = 0;
  const idat: Buffer[] = [];
  for (let p = 8; p + 8 <= b.length;) {
    const len = b.readUInt32BE(p), type = b.toString("latin1", p + 4, p + 8), body = b.subarray(p + 8, p + 8 + len);
    if (type === "IHDR") { width = body.readUInt32BE(0); height = body.readUInt32BE(4); depth = body[8]; colorType = body[9]; interlace = body[12]; }
    else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
    p += 12 + len;
  }
  const channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[colorType];
  if (depth !== 8 || !channels || interlace) throw new Error("PNG: only 8-bit, non-interlaced grey/RGB(A) images are supported");
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const px = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = px.subarray(y * stride, (y + 1) * stride), prev = y > 0 ? px.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0, up = prev ? prev[i] : 0, c = prev && i >= channels ? prev[i - channels] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += up;
      else if (filter === 3) v += (a + up) >> 1;
      else if (filter === 4) { const pp = a + up - c, pa = Math.abs(pp - a), pb = Math.abs(pp - up), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c; }
      cur[i] = v & 0xff;
    }
  }
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0, j = 0; i < width * height; i++, j += channels) {
    const grey = channels <= 2;
    out[i * 4] = px[j];
    out[i * 4 + 1] = grey ? px[j] : px[j + 1];
    out[i * 4 + 2] = grey ? px[j] : px[j + 2];
    out[i * 4 + 3] = channels === 4 ? px[j + 3] : channels === 2 ? px[j + 1] : 255;
  }
  return { data: out, width, height };
}

export function encodePng(img: RgbaImage): Buffer {
  const { width, height, data } = img;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) Buffer.from(data.buffer, data.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  const chunk = (type: string, body: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(type, 4, "latin1");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])) >>> 0, 0);
    return Buffer.concat([head, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([PNG_SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
