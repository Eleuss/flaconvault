// Node tooling: the dependency-free image codec used by the test fixtures.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decodeImage, decodePng, encodePng } from "../scripts/image-io.ts";

const fixture = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url));

test("decodeImage: baseline JPEG fixtures decode to opaque RGBA at their full size", () => {
  for (const name of ["card-2.jpg", "card-3.jpg", "card-4.jpg"]) {
    const img = decodeImage(fixture(name));
    assert.deepEqual([img.width, img.height], [1000, 1333], name);
    assert.equal(img.data.length, 1000 * 1333 * 4);
    let alpha = true, sum = 0;
    for (let i = 0; i < img.data.length; i += 4) { alpha &&= img.data[i + 3] === 255; sum += img.data[i] + img.data[i + 1] + img.data[i + 2]; }
    assert.ok(alpha, `${name}: opaque`);
    const mean = sum / (1000 * 1333 * 3);
    assert.ok(mean > 60 && mean < 200, `${name}: plausible brightness ${mean}`); // a wooden table, not a black or white frame
  }
});

test("encodePng / decodePng round trip is lossless", () => {
  const w = 37, h = 11, data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i++) data[i] = (i * 97 + (i >> 3)) & 0xff;
  const back = decodePng(encodePng({ data, width: w, height: h }));
  assert.deepEqual([back.width, back.height], [w, h]);
  assert.deepEqual(Array.from(back.data), Array.from(data));
  const photo = decodeImage(fixture("card-3.jpg"));
  assert.deepEqual(decodeImage(encodePng(photo)).data, photo.data);
});

test("decodeImage rejects data that is neither JPEG nor PNG", () => {
  assert.throws(() => decodeImage(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])), /Unsupported image format/);
});
