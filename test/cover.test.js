// -----------------------------------------------------------------------------
// Catalog cover contract (store rule C.1): JPEG or PNG, EXACTLY 800x534, and
// 150 KB max. The store indexer downloads the file from the `cover_image` URL
// and silently falls back to a placeholder when any of the three fails — which
// is exactly the kind of regression nobody notices until the card looks wrong
// in the catalog. So we check the bytes we ship, here.
//
// The dimensions are read straight from the file headers: adding an image
// dependency for four fields would be a poor trade for a template-sized repo.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const COVER_WIDTH = 800;
const COVER_HEIGHT = 534;
const COVER_MAX_BYTES = 150 * 1024;

const manifest = JSON.parse(
  await readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);
const coverFileName = manifest.cover_image.split('/').pop();
const cover = await readFile(new URL(`../${coverFileName}`, import.meta.url));

test('the manifest cover_image points at a file this repository actually ships', () => {
  assert.match(manifest.cover_image, /^https:\/\//, 'the store refuses a non-https cover');
  assert.ok(cover.length > 0, `${coverFileName} is empty`);
});

test('the cover is a real JPEG or PNG, by its magic bytes', () => {
  // The indexer never trusts the extension nor the Content-Type either.
  assert.ok(detectImageType(cover), `${coverFileName} is neither a JPEG nor a PNG`);
});

test('the cover is exactly 800x534', () => {
  const { width, height } = readImageSize(cover);
  assert.equal(width, COVER_WIDTH);
  assert.equal(height, COVER_HEIGHT);
});

test('the cover stays under 150 KB', () => {
  assert.ok(
    cover.length <= COVER_MAX_BYTES,
    `${coverFileName} is ${Math.ceil(cover.length / 1024)} KB, the limit is 150 KB`,
  );
});

function detectImageType(data) {
  if (data.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) {
    return 'jpg';
  }
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'png';
  }
  return null;
}

function readImageSize(data) {
  if (detectImageType(data) === 'png') {
    // IHDR is always the first chunk: width and height are two big-endian
    // 32-bit integers at a fixed offset.
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }

  // JPEG: walk the marker segments until a Start Of Frame (SOFn), which is the
  // only one carrying the dimensions. C4/C8/CC are not frames despite sitting
  // in the same range.
  let offset = 2;
  while (offset < data.length - 9) {
    if (data[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = data[offset + 1];
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: data.readUInt16BE(offset + 5), width: data.readUInt16BE(offset + 7) };
    }
    offset += 2 + data.readUInt16BE(offset + 2);
  }
  throw new Error('could not read the JPEG dimensions');
}
