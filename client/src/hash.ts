/**
 * MurmurHash3 (32-bit) — pure JS, zero dependencies.
 * Used to anonymize CSS selectors and element text.
 * Truncates input to 120 chars before hashing (per spec).
 */
export function murmurhash3(input: string, seed: number = 0): number {
  const key = input.length > 120 ? input.slice(0, 120) : input;
  let h = seed >>> 0;
  const len = key.length;
  const nblocks = len >> 2;

  const c1 = 0xcc9e2d51;
  const c2 = 0x1b873593;

  // body
  for (let i = 0; i < nblocks; i++) {
    const idx = i << 2;
    let k =
      (key.charCodeAt(idx) & 0xff) |
      ((key.charCodeAt(idx + 1) & 0xff) << 8) |
      ((key.charCodeAt(idx + 2) & 0xff) << 16) |
      ((key.charCodeAt(idx + 3) & 0xff) << 24);

    k = Math.imul(k, c1);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, c2);

    h ^= k;
    h = (h << 13) | (h >>> 19);
    h = Math.imul(h, 5) + 0xe6546b64;
  }

  // tail
  const tail = nblocks << 2;
  let k1 = 0;
  switch (len & 3) {
    case 3:
      k1 ^= (key.charCodeAt(tail + 2) & 0xff) << 16;
    // falls through
    case 2:
      k1 ^= (key.charCodeAt(tail + 1) & 0xff) << 8;
    // falls through
    case 1:
      k1 ^= key.charCodeAt(tail) & 0xff;
      k1 = Math.imul(k1, c1);
      k1 = (k1 << 15) | (k1 >>> 17);
      k1 = Math.imul(k1, c2);
      h ^= k1;
  }

  // finalization
  h ^= len;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;

  return h >>> 0;
}
