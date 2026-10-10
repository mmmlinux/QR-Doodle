/*
 * QR Doodle core
 * --------------
 * A QR Code (Model 2) encoder that keeps track of *why* every module exists:
 * which function pattern it belongs to, or which interleaved codeword / RS block
 * / bit it carries. On top of that it can:
 *   - measure how many codewords a drawing damages, per Reed-Solomon block
 *   - re-solve the spare (padding) codewords so they match the drawing
 *     (a linear solve over GF(2), similar in spirit to Russ Cox's QArt)
 *   - check whether the format / version info still decodes
 *
 * Encoder structure follows Project Nayuki's qrcodegen (MIT).
 */
(function (root) {
  'use strict';

  const ECL_LIST = ['L', 'M', 'Q', 'H'];
  const ECL_FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 };

  // Index 0 is padding. Tables from ISO/IEC 18004.
  const ECC_CODEWORDS_PER_BLOCK = {
    L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
    Q: [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    H: [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  };
  const NUM_EC_BLOCKS = {
    L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
    M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
    Q: [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
    H: [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
  };
  // Misdecode-protection codewords ("p" in ISO/IEC 18004 Table 9). Tiny symbols reserve
  // a few EC codewords for error detection, so they can correct fewer errors.
  const MISDECODE_P = { 1: { L: 3, M: 2, Q: 1, H: 1 }, 2: { L: 2 }, 3: { L: 1 } };

  const ROLE = { DATA: 0, FINDER: 1, SEPARATOR: 2, TIMING: 3, ALIGNMENT: 4, FORMAT: 5, VERSION: 6, DARK: 7, REMAINDER: 8 };
  const ROLE_NAMES = ['Data / EC', 'Finder pattern', 'Separator', 'Timing pattern', 'Alignment pattern', 'Format info', 'Version info', 'Dark module', 'Remainder bit'];

  /* ---------- GF(256) & Reed-Solomon ---------- */

  const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
  (function () {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      EXP[i] = x; LOG[x] = i;
      x <<= 1; if (x & 0x100) x ^= 0x11D;
    }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();
  function gmul(a, b) { return (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]]; }

  const divisorCache = {};
  function rsDivisor(degree) {
    if (divisorCache[degree]) return divisorCache[degree];
    const result = new Uint8Array(degree);
    result[degree - 1] = 1;
    let root = 1;
    for (let i = 0; i < degree; i++) {
      for (let j = 0; j < degree; j++) {
        result[j] = gmul(result[j], root);
        if (j + 1 < degree) result[j] ^= result[j + 1];
      }
      root = gmul(root, 0x02);
    }
    return (divisorCache[degree] = result);
  }
  function rsRemainder(data, divisor) {
    const deg = divisor.length, res = new Uint8Array(deg);
    for (let n = 0; n < data.length; n++) {
      const f = data[n] ^ res[0];
      res.copyWithin(0, 1); res[deg - 1] = 0;
      if (f) for (let i = 0; i < deg; i++) res[i] ^= gmul(divisor[i], f);
    }
    return res;
  }

  /* ---------- Symbol geometry ---------- */

  function numRawDataModules(ver) {
    let result = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      const numAlign = Math.floor(ver / 7) + 2;
      result -= (25 * numAlign - 10) * numAlign - 55;
      if (ver >= 7) result -= 36;
    }
    return result;
  }
  function numDataCodewords(ver, ecl) {
    return Math.floor(numRawDataModules(ver) / 8) - ECC_CODEWORDS_PER_BLOCK[ecl][ver] * NUM_EC_BLOCKS[ecl][ver];
  }
  function alignmentPositions(ver) {
    if (ver === 1) return [];
    const size = ver * 4 + 17;
    const numAlign = Math.floor(ver / 7) + 2;
    const step = Math.floor((ver * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4)) * 2;
    const result = [6];
    for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
    return result;
  }
  function formatBits(ecl, mask) {
    const data = (ECL_FORMAT_BITS[ecl] << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    return ((data << 10) | rem) ^ 0x5412;
  }
  function versionBits(ver) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
    return (ver << 12) | rem;
  }

  const layoutCache = new Map();
  function getLayout(ver) {
    if (layoutCache.has(ver)) return layoutCache.get(ver);
    const size = ver * 4 + 17, N = size * size;
    const role = new Uint8Array(N);
    const isFunc = new Uint8Array(N);
    const fixed = new Uint8Array(N); // values of function modules (format bits filled per mask)
    const set = (x, y, v, r) => { const i = y * size + x; isFunc[i] = 1; fixed[i] = v ? 1 : 0; role[i] = r; };

    for (let i = 0; i < size; i++) {
      set(6, i, i % 2 === 0, ROLE.TIMING);
      set(i, 6, i % 2 === 0, ROLE.TIMING);
    }
    for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        set(x, y, d !== 2 && d !== 4, d === 4 ? ROLE.SEPARATOR : ROLE.FINDER);
      }
    }
    const ap = alignmentPositions(ver), na = ap.length;
    for (let i = 0; i < na; i++) for (let j = 0; j < na; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === na - 1) || (i === na - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++)
        set(ap[i] + dx, ap[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1, ROLE.ALIGNMENT);
    }

    // Format info: bit i of the 15-bit word goes to formatA[i] and formatB[i].
    const fa = [], fb = [];
    for (let i = 0; i <= 5; i++) fa.push([8, i]);
    fa.push([8, 7], [8, 8], [7, 8]);
    for (let i = 9; i < 15; i++) fa.push([14 - i, 8]);
    for (let i = 0; i < 8; i++) fb.push([size - 1 - i, 8]);
    for (let i = 8; i < 15; i++) fb.push([8, size - 15 + i]);
    const formatA = fa.map(([x, y]) => y * size + x), formatB = fb.map(([x, y]) => y * size + x);
    for (const i of formatA.concat(formatB)) { isFunc[i] = 1; role[i] = ROLE.FORMAT; }
    set(8, size - 8, 1, ROLE.DARK);

    let versionA = null, versionB = null;
    if (ver >= 7) {
      versionA = []; versionB = [];
      const vb = versionBits(ver);
      for (let i = 0; i < 18; i++) {
        const a = size - 11 + (i % 3), b = Math.floor(i / 3), bit = (vb >>> i) & 1;
        set(a, b, bit, ROLE.VERSION); versionA.push(b * size + a);
        set(b, a, bit, ROLE.VERSION); versionB.push(a * size + b);
      }
    }

    // Zigzag placement order of every non-function module.
    const order = [];
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      const upward = ((right + 1) & 2) === 0;
      for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
        const x = right - j, y = upward ? size - 1 - vert : vert;
        const i = y * size + x;
        if (!isFunc[i]) order.push(i);
      }
    }
    const rawCW = Math.floor(order.length / 8);
    const orderIdx = new Int32Array(N).fill(-1);
    order.forEach((i, k) => { orderIdx[i] = k; if (k >= rawCW * 8) role[i] = ROLE.REMAINDER; });

    const L = { ver, size, N, role, isFunc, fixed, formatA, formatB, versionA, versionB, orderIdx, order: Int32Array.from(order), rawCW, alignPos: ap };
    layoutCache.set(ver, L);
    return L;
  }

  const maskCache = new Map();
  function maskTable(size, mask) {
    const key = size * 8 + mask;
    if (maskCache.has(key)) return maskCache.get(key);
    const t = new Uint8Array(size * size);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      let v;
      switch (mask) {
        case 0: v = (x + y) % 2 === 0; break;
        case 1: v = y % 2 === 0; break;
        case 2: v = x % 3 === 0; break;
        case 3: v = (x + y) % 3 === 0; break;
        case 4: v = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
        case 5: v = (x * y) % 2 + (x * y) % 3 === 0; break;
        case 6: v = ((x * y) % 2 + (x * y) % 3) % 2 === 0; break;
        case 7: v = ((x + y) % 2 + (x * y) % 3) % 2 === 0; break;
      }
      t[y * size + x] = v ? 1 : 0;
    }
    maskCache.set(key, t);
    return t;
  }

  /* ---------- RS block structure ---------- */

  const blockCache = new Map();
  function getBlocks(ver, ecl) {
    const key = ecl + ver;
    if (blockCache.has(key)) return blockCache.get(key);
    const numBlocks = NUM_EC_BLOCKS[ecl][ver], ecc = ECC_CODEWORDS_PER_BLOCK[ecl][ver];
    const rawCW = Math.floor(numRawDataModules(ver) / 8);
    const numShort = numBlocks - rawCW % numBlocks, shortLen = Math.floor(rawCW / numBlocks);
    const divisor = rsDivisor(ecc);
    const p = (MISDECODE_P[ver] && MISDECODE_P[ver][ecl]) || 0;
    const capacity = Math.floor((ecc - p) / 2);

    const unitCache = {};
    const ecUnitFor = (d) => {
      // ecUnit[k*ecc + q] = EC byte q produced by a data block that is all zero except 1 at position k.
      if (unitCache[d]) return unitCache[d];
      const u = new Uint8Array(d * ecc), s = new Uint8Array(divisor);
      for (let k = d - 1; k >= 0; k--) {
        u.set(s, k * ecc);
        const f = s[0];
        s.copyWithin(0, 1); s[ecc - 1] = 0;
        if (f) for (let i = 0; i < ecc; i++) s[i] ^= gmul(divisor[i], f);
      }
      return (unitCache[d] = u);
    };

    const blocks = [];
    let start = 0;
    for (let j = 0; j < numBlocks; j++) {
      const dataLen = shortLen - ecc + (j < numShort ? 0 : 1);
      blocks.push({ index: j, dataLen, start, cwIndex: new Int32Array(dataLen + ecc), ecUnit: ecUnitFor(dataLen) });
      start += dataLen;
    }
    const cwBlock = new Uint16Array(rawCW), cwPos = new Uint16Array(rawCW);
    let k = 0;
    for (let i = 0; i <= shortLen; i++) for (let j = 0; j < numBlocks; j++) {
      if (i === shortLen - ecc && j < numShort) continue;
      const pos = (j < numShort && i > shortLen - ecc) ? i - 1 : i;
      cwBlock[k] = j; cwPos[k] = pos; blocks[j].cwIndex[pos] = k; k++;
    }
    const B = { ver, ecl, numBlocks, ecc, p, capacity, rawCW, divisor, blocks, cwBlock, cwPos, numDataCW: start };
    blockCache.set(key, B);
    return B;
  }

  /* ---------- Data encoding ---------- */

  const ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
  const CC_BITS = { numeric: [10, 12, 14], alphanumeric: [9, 11, 13], byte: [8, 16, 16] };
  const MODE_BITS = { numeric: 1, alphanumeric: 2, byte: 4 };

  function utf8(str) {
    if (typeof TextEncoder !== 'undefined') return Array.from(new TextEncoder().encode(str));
    return Array.from(Buffer.from(str, 'utf8'));
  }
  function makeSegment(text, forceMode) {
    const bits = [];
    const push = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1); };
    let mode = forceMode;
    if (!mode || mode === 'auto') {
      if (/^[0-9]*$/.test(text)) mode = 'numeric';
      else if (/^[0-9A-Z $%*+\-./:]*$/.test(text)) mode = 'alphanumeric';
      else mode = 'byte';
    }
    let numChars;
    if (mode === 'numeric') {
      numChars = text.length;
      for (let i = 0; i < text.length; i += 3) {
        const chunk = text.substr(i, 3);
        push(parseInt(chunk, 10), chunk.length * 3 + 1);
      }
    } else if (mode === 'alphanumeric') {
      numChars = text.length;
      for (let i = 0; i + 1 < text.length; i += 2) push(ALNUM.indexOf(text[i]) * 45 + ALNUM.indexOf(text[i + 1]), 11);
      if (text.length % 2) push(ALNUM.indexOf(text[text.length - 1]), 6);
    } else {
      const bytes = utf8(text);
      numChars = bytes.length;
      for (const b of bytes) push(b, 8);
    }
    return { mode, numChars, bits };
  }
  function ccBits(mode, ver) { return CC_BITS[mode][ver <= 9 ? 0 : ver <= 26 ? 1 : 2]; }
  function segmentBitLength(seg, ver) {
    const cc = ccBits(seg.mode, ver);
    if (seg.numChars >= (1 << cc)) return Infinity;
    return 4 + cc + seg.bits.length;
  }
  function fits(seg, ver, ecl) { return segmentBitLength(seg, ver) <= numDataCodewords(ver, ecl) * 8; }
  function minVersion(seg, ecl, from) {
    for (let v = from || 1; v <= 40; v++) if (fits(seg, v, ecl)) return v;
    return 0;
  }
  function encodeData(seg, ver, ecl) {
    const numDC = numDataCodewords(ver, ecl), cap = numDC * 8;
    const bits = [];
    const push = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1); };
    push(MODE_BITS[seg.mode], 4);
    push(seg.numChars, ccBits(seg.mode, ver));
    for (let i = 0; i < seg.bits.length; i++) bits.push(seg.bits[i]);
    if (bits.length > cap) return null;
    const usedBits = bits.length;
    for (let t = Math.min(4, cap - bits.length); t > 0; t--) bits.push(0);
    while (bits.length % 8) bits.push(0);
    const contentLen = bits.length / 8;
    const out = new Uint8Array(numDC);
    for (let i = 0; i < bits.length; i++) out[i >>> 3] |= bits[i] << (7 - (i & 7));
    for (let i = contentLen, pad = 0xEC; i < numDC; i++, pad ^= 0xEC ^ 0x11) out[i] = pad;
    return { codewords: out, contentLen, usedBits, capacityBits: cap };
  }

  /* ---------- Context: one (text, version, ECC) combination ---------- */

  function createContext(text, ver, ecl, mode) {
    const seg = makeSegment(text, mode);
    if (!fits(seg, ver, ecl)) return null;
    const layout = getLayout(ver), B = getBlocks(ver, ecl), enc = encodeData(seg, ver, ecl);
    return {
      text, seg, ver, ecl, size: layout.size, layout, B,
      data: enc.codewords, contentLen: enc.contentLen, usedBits: enc.usedBits, capacityBits: enc.capacityBits,
      spareCW: B.numDataCW - enc.contentLen,
      ecRowCache: [], penaltyMask: -1,
    };
  }

  /* ---------- Spare-capacity solver ---------- */

  function popcount8(v) { v = v - ((v >>> 1) & 0x55); v = (v & 0x33) + ((v >>> 2) & 0x33); return (v + (v >>> 4)) & 0x0F; }
  function parity32(v) { v ^= v >>> 16; v ^= v >>> 8; v ^= v >>> 4; v ^= v >>> 2; v ^= v >>> 1; return v & 1; }

  // For block j: rows[q*8+b] = which free data bits flip bit b of EC codeword q.
  function getEcRows(ctx, j, firstFree, W) {
    if (ctx.ecRowCache[j]) return ctx.ecRowCache[j];
    const B = ctx.B, blk = B.blocks[j], d = blk.dataLen, e = B.ecc, u = blk.ecUnit;
    const rows = [];
    for (let r = 0; r < e * 8; r++) rows.push(new Uint32Array(W));
    for (let f = firstFree; f < d; f++) for (let q = 0; q < e; q++) {
      const unit = u[f * e + q];
      if (!unit) continue;
      for (let c = 0; c < 8; c++) {
        const prod = gmul(unit, 1 << c), n = (f - firstFree) * 8 + c;
        for (let b = 0; b < 8; b++) if ((prod >>> b) & 1) rows[q * 8 + b][n >>> 5] |= 1 << (n & 31);
      }
    }
    return (ctx.ecRowCache[j] = rows);
  }

  // Mutates D (this block's data codewords) so that as many *whole* targeted codewords as
  // possible match the target bits. Only padding codewords (after the message) may change.
  function solveBlock(ctx, j, D, tMask, tVal) {
    const B = ctx.B, blk = B.blocks[j], d = blk.dataLen, e = B.ecc;
    const firstFree = Math.max(0, ctx.contentLen - blk.start);
    if (firstFree >= d) return;
    const nf = (d - firstFree) * 8, W = (nf + 31) >>> 5;

    const cands = [];
    for (let pos = firstFree; pos < d + e; pos++) if (tMask[blk.cwIndex[pos]]) cands.push(pos);
    if (!cands.length) return;
    cands.sort((a, b) => popcount8(tMask[blk.cwIndex[a]]) - popcount8(tMask[blk.cwIndex[b]]) || a - b);

    const EC0 = rsRemainder(D, B.divisor);
    const ecRows = getEcRows(ctx, j, firstFree, W);
    const prow = [], prhs = [], pcol = [];
    let np = 0;

    for (const pos of cands) {
      const k = blk.cwIndex[pos], m = tMask[k], v = tVal[k];
      const base = pos < d ? D[pos] : EC0[pos - d];
      const snap = np;
      let ok = true;
      for (let b = 0; b < 8 && ok; b++) {
        if (!((m >>> b) & 1)) continue;
        let rhs = ((base >>> b) & 1) ^ ((v >>> b) & 1);
        let row;
        if (pos < d) {
          row = new Uint32Array(W);
          const n = (pos - firstFree) * 8 + b;
          row[n >>> 5] = 1 << (n & 31);
        } else {
          row = ecRows[(pos - d) * 8 + b].slice();
        }
        for (let p = 0; p < np; p++) {
          const c = pcol[p];
          if ((row[c >>> 5] >>> (c & 31)) & 1) {
            const pr = prow[p];
            for (let w = 0; w < W; w++) row[w] ^= pr[w];
            rhs ^= prhs[p];
          }
        }
        let col = -1;
        for (let w = 0; w < W; w++) if (row[w]) { const lo = row[w] & -row[w]; col = w * 32 + (31 - Math.clz32(lo)); break; }
        if (col < 0) { if (rhs) ok = false; continue; }
        prow[np] = row; prhs[np] = rhs; pcol[np] = col; np++;
      }
      if (!ok) np = snap; // a half-matched codeword is still a damaged codeword: give its freedom back
    }

    const x = new Uint32Array(W);
    for (let p = np - 1; p >= 0; p--) {
      const r = prow[p];
      let par = prhs[p];
      for (let w = 0; w < W; w++) if (r[w] & x[w]) par ^= parity32(r[w] & x[w]);
      if (par) x[pcol[p] >>> 5] |= 1 << (pcol[p] & 31);
    }
    for (let n = 0; n < nf; n++) if ((x[n >>> 5] >>> (n & 31)) & 1) D[firstFree + (n >>> 3)] ^= 1 << (n & 7);
  }

  /* ---------- Evaluation ---------- */

  function hamming(a, b) { let v = a ^ b, c = 0; while (v) { v &= v - 1; c++; } return c; }

  /**
   * Build the symbol for a mask with a drawing applied, and measure the damage.
   * targets: Int8Array(size*size), -1 = no opinion, 0 = force light, 1 = force dark.
   * opts.useSpare: re-solve padding codewords to match the targets.
   * opts.uncertain: optional Uint8Array; flagged modules may be read either way by a scanner
   *   (e.g. mid-tones under a logo), so they always count as damage.
   */
  function evaluate(ctx, mask, targets, opts) {
    opts = opts || {};
    const { layout, B } = ctx;
    const { size, N, orderIdx, isFunc, role, rawCW } = layout;
    const mt = maskTable(size, mask);
    const dataBits = rawCW * 8;

    const unc = opts.uncertain || null;
    const tMask = new Uint8Array(rawCW), tVal = new Uint8Array(rawCW);
    let targetCount = 0;
    if (targets) for (let i = 0; i < N; i++) {
      const t = targets[i];
      if (t < 0) continue;
      targetCount++;
      if (isFunc[i] || (unc && unc[i])) continue;
      const k = orderIdx[i];
      if (k >= dataBits) continue;
      const cw = k >>> 3, b = 7 - (k & 7);
      tMask[cw] |= 1 << b;
      if (t ^ mt[i]) tVal[cw] |= 1 << b;
    }

    const blockData = [], blockEC = [];
    for (let j = 0; j < B.numBlocks; j++) {
      const blk = B.blocks[j];
      const D = ctx.data.slice(blk.start, blk.start + blk.dataLen);
      if (opts.useSpare && targets) solveBlock(ctx, j, D, tMask, tVal);
      blockData.push(D);
      blockEC.push(rsRemainder(D, B.divisor));
    }
    const cw = new Uint8Array(rawCW);
    for (let k = 0; k < rawCW; k++) {
      const j = B.cwBlock[k], pos = B.cwPos[k], d = B.blocks[j].dataLen;
      cw[k] = pos < d ? blockData[j][pos] : blockEC[j][pos - d];
    }

    const natural = new Uint8Array(layout.fixed);
    const fbits = formatBits(ctx.ecl, mask);
    for (let i = 0; i < 15; i++) natural[layout.formatA[i]] = natural[layout.formatB[i]] = (fbits >>> i) & 1;
    for (let i = 0; i < N; i++) {
      if (isFunc[i]) continue;
      const k = orderIdx[i];
      const bit = k < dataBits ? (cw[k >>> 3] >>> (7 - (k & 7))) & 1 : 0;
      natural[i] = bit ^ mt[i];
    }

    const effective = new Uint8Array(natural);
    const conflict = new Uint8Array(N);
    const cwDamaged = new Uint8Array(rawCW);
    const funcChanged = new Int32Array(ROLE_NAMES.length);
    let conflictCount = 0;
    if (targets) for (let i = 0; i < N; i++) {
      const t = targets[i];
      if (t < 0) continue;
      effective[i] = t;
      if (t === natural[i] && !(unc && unc[i])) continue;
      conflict[i] = 1;
      if (isFunc[i]) { funcChanged[role[i]]++; continue; }
      const k = orderIdx[i];
      if (k < dataBits) { cwDamaged[k >>> 3] = 1; conflictCount++; }
    }

    const blockErr = new Int32Array(B.numBlocks);
    let damaged = 0;
    for (let k = 0; k < rawCW; k++) if (cwDamaged[k]) { blockErr[B.cwBlock[k]]++; damaged++; }
    let worst = 0, worstBlock = 0, over = 0;
    for (let j = 0; j < B.numBlocks; j++) {
      if (blockErr[j] > worst) { worst = blockErr[j]; worstBlock = j; }
      if (blockErr[j] > B.capacity) over += blockErr[j] - B.capacity;
    }

    const readWord = (pos) => { let v = 0; for (let i = 0; i < pos.length; i++) v |= effective[pos[i]] << i; return v; };
    const fmtA = hamming(readWord(layout.formatA), fbits), fmtB = hamming(readWord(layout.formatB), fbits);
    const format = { distA: fmtA, distB: fmtB, okA: fmtA <= 3, okB: fmtB <= 3 };
    let version = null;
    if (layout.versionA) {
      const vb = versionBits(ctx.ver);
      const a = hamming(readWord(layout.versionA), vb), b = hamming(readWord(layout.versionB), vb);
      version = { distA: a, distB: b, okA: a <= 3, okB: b <= 3 };
    }

    const finderChanged = [0, 0, 0];
    if (funcChanged[ROLE.FINDER]) for (let i = 0; i < N; i++) {
      if (!conflict[i] || role[i] !== ROLE.FINDER) continue;
      const x = i % size, y = (i / size) | 0;
      finderChanged[x < size / 2 ? (y < size / 2 ? 0 : 2) : 1]++;
    }

    const formatFail = !format.okA && !format.okB;
    const versionFail = version ? (!version.okA && !version.okB) : false;
    return {
      mask, natural, effective, conflict, cwDamaged, blockErr, codewords: cw,
      damaged, worst, worstBlock, over, capacity: B.capacity,
      worstRatio: worst / B.capacity,
      targetCount, conflictCount, funcChanged, finderChanged, format, version,
      decodable: over === 0 && !formatFail && !versionFail,
      formatFail, versionFail,
    };
  }

  function penalty(m, size) {
    let r = 0;
    const at = (x, y) => m[y * size + x];
    for (let pass = 0; pass < 2; pass++) {
      for (let a = 0; a < size; a++) {
        let run = 1, prev = -1;
        let window = 0; // last 11 modules as bits
        for (let b = 0; b < size; b++) {
          const v = pass ? at(a, b) : at(b, a);
          if (v === prev) { run++; if (run === 5) r += 3; else if (run > 5) r++; }
          else { run = 1; prev = v; }
          window = ((window << 1) | v) & 0x7FF;
          if (b >= 10 && (window === 0x5D0 || window === 0x05D)) r += 40;
        }
      }
    }
    let dark = 0;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      dark += at(x, y);
      if (x < size - 1 && y < size - 1) {
        const c = at(x, y);
        if (c === at(x + 1, y) && c === at(x, y + 1) && c === at(x + 1, y + 1)) r += 3;
      }
    }
    const total = size * size;
    r += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
    return r;
  }
  function penaltyMask(ctx) {
    if (ctx.penaltyMask >= 0) return ctx.penaltyMask;
    let best = 0, bestScore = Infinity;
    for (let m = 0; m < 8; m++) {
      const s = penalty(evaluate(ctx, m, null).natural, ctx.size);
      if (s < bestScore) { bestScore = s; best = m; }
    }
    return (ctx.penaltyMask = best);
  }

  // Lower is better. Used to pick the mask that suits a drawing best.
  function designScore(r) {
    return (r.formatFail || r.versionFail ? 1e7 : 0) + r.over * 1e4 + r.worstRatio * 1000 + r.damaged / 1000;
  }

  const api = {
    ECL_LIST, ROLE, ROLE_NAMES,
    numRawDataModules, numDataCodewords, alignmentPositions, formatBits, versionBits,
    getLayout, getBlocks, maskTable, makeSegment, segmentBitLength, fits, minVersion, encodeData,
    createContext, evaluate, penalty, penaltyMask, designScore, rsRemainder, rsDivisor, gmul,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.QRCore = api;
})(typeof self !== 'undefined' ? self : this);
