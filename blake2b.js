// @ts-check
// BLAKE2b (RFC 7693) with a personalization string, the hash the exchange
// names its transactions with. Written over BigInt words: it hashes a
// couple of hundred bytes per order, so clarity wins over speed.

const MASK = (1n << 64n) - 1n;

const IV = [
  0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n,
];

const SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
];

const BLOCK = 128;
const ROUNDS = 12;

/**
 * Word `index` of `words`. Every index in this file is a constant below
 * the array's length, so the fallback is never taken.
 * @param {ArrayLike<bigint>} words
 * @param {number} index
 * @returns {bigint}
 */
function word(words, index) {
  return words[index] ?? 0n;
}

/**
 * @param {bigint} value
 * @param {bigint} bits
 * @returns {bigint}
 */
function rotr(value, bits) {
  return ((value >> bits) | (value << (64n - bits))) & MASK;
}

/**
 * The mixing function G.
 * @param {BigUint64Array} v
 * @param {number} a
 * @param {number} b
 * @param {number} c
 * @param {number} d
 * @param {bigint} x
 * @param {bigint} y
 */
function mix(v, a, b, c, d, x, y) {
  v[a] = word(v, a) + word(v, b) + x;
  v[d] = rotr(word(v, d) ^ word(v, a), 32n);
  v[c] = word(v, c) + word(v, d);
  v[b] = rotr(word(v, b) ^ word(v, c), 24n);
  v[a] = word(v, a) + word(v, b) + y;
  v[d] = rotr(word(v, d) ^ word(v, a), 16n);
  v[c] = word(v, c) + word(v, d);
  v[b] = rotr(word(v, b) ^ word(v, c), 63n);
}

/**
 * Folds one 128-byte block into the state.
 * @param {BigUint64Array} h the state, eight words
 * @param {DataView} block the block's bytes
 * @param {bigint} count bytes hashed so far, this block included
 * @param {boolean} last whether this is the final block
 */
function compress(h, block, count, last) {
  const m = new BigUint64Array(16);
  for (let i = 0; i < 16; i += 1) {
    m[i] = block.getBigUint64(i * 8, true);
  }
  const v = new BigUint64Array(16);
  for (let i = 0; i < 8; i += 1) {
    v[i] = word(h, i);
    v[i + 8] = word(IV, i);
  }
  v[12] = word(v, 12) ^ (count & MASK);
  v[13] = word(v, 13) ^ (count >> 64n);
  if (last) {
    v[14] = ~word(v, 14) & MASK;
  }
  for (let round = 0; round < ROUNDS; round += 1) {
    const s = SIGMA[round % 10] ?? [];
    /** @param {number} i */
    const at = (i) => word(m, s[i] ?? 0);
    mix(v, 0, 4, 8, 12, at(0), at(1));
    mix(v, 1, 5, 9, 13, at(2), at(3));
    mix(v, 2, 6, 10, 14, at(4), at(5));
    mix(v, 3, 7, 11, 15, at(6), at(7));
    mix(v, 0, 5, 10, 15, at(8), at(9));
    mix(v, 1, 6, 11, 12, at(10), at(11));
    mix(v, 2, 7, 8, 13, at(12), at(13));
    mix(v, 3, 4, 9, 14, at(14), at(15));
  }
  for (let i = 0; i < 8; i += 1) {
    h[i] = word(h, i) ^ word(v, i) ^ word(v, i + 8);
  }
}

/**
 * BLAKE2b of `input`, unkeyed.
 * @param {Uint8Array} input
 * @param {number} length digest length in bytes, 1 to 64
 * @param {Uint8Array} [personal] personalization, at most 16 bytes
 * @returns {Uint8Array}
 */
export function blake2b(input, length, personal) {
  if (!Number.isInteger(length) || length < 1 || length > 64) {
    throw new RangeError("the digest is 1 to 64 bytes long");
  }
  if (personal !== undefined && personal.length > 16) {
    throw new RangeError("the personalization is at most 16 bytes");
  }
  // The parameter block: digest length, no key, fanout 1, depth 1, and
  // the personalization in its last 16 bytes.
  const params = new Uint8Array(64);
  params[0] = length;
  params[2] = 1;
  params[3] = 1;
  if (personal !== undefined) {
    params.set(personal, 48);
  }
  const view = new DataView(params.buffer);
  const h = new BigUint64Array(8);
  for (let i = 0; i < 8; i += 1) {
    h[i] = word(IV, i) ^ view.getBigUint64(i * 8, true);
  }

  // Every block but the last is full; the last is padded with zeros, and
  // an empty input is one block of zeros.
  const blocks = Math.max(1, Math.ceil(input.length / BLOCK));
  for (let index = 0; index < blocks; index += 1) {
    const start = index * BLOCK;
    const chunk = new Uint8Array(BLOCK);
    chunk.set(input.subarray(start, Math.min(input.length, start + BLOCK)));
    const last = index === blocks - 1;
    const count = BigInt(last ? input.length : start + BLOCK);
    compress(h, new DataView(chunk.buffer), count, last);
  }

  const out = new Uint8Array(64);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i += 1) {
    outView.setBigUint64(i * 8, word(h, i), true);
  }
  return out.slice(0, length);
}
