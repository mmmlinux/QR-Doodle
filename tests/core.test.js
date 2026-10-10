const Q = require('../qrcore.js');
const QRCode = require('qrcode');
const jsQR = require('jsqr');
let fails = 0;
const ok = (c, msg) => { if (!c) { fails++; console.log('FAIL', msg); } };

function decode(mat, size, scale = 4, quiet = 4) {
  const W = (size + 2 * quiet) * scale;
  const px = new Uint8ClampedArray(W * W * 4).fill(255);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (mat[y * size + x])
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
      const p = (((y + quiet) * scale + dy) * W + (x + quiet) * scale + dx) * 4;
      px[p] = px[p + 1] = px[p + 2] = 0;
    }
  const r = jsQR(px, W, W, { inversionAttempts: 'dontInvert' });
  return r ? r.data : null;
}

// 1. geometry + reference comparison
for (let v = 1; v <= 40; v++) {
  const L = Q.getLayout(v);
  let nonf = 0; for (let i = 0; i < L.N; i++) if (!L.isFunc[i]) nonf++;
  ok(nonf === Q.numRawDataModules(v), 'raw modules v' + v);
  for (const e of 'LMQH') { const B = Q.getBlocks(v, e); ok(B.numDataCW === Q.numDataCodewords(v, e), 'dc ' + v + e); }
}
const base = 'https://example.com/qr-doodle?id=';
let compared = 0;
for (const v of [1, 2, 3, 4, 5, 6, 7, 9, 10, 13, 14, 20, 21, 26, 27, 32, 33, 39, 40]) for (const e of 'LMQH') {
  // longest byte text that fits
  let text = base; const cap = Q.numDataCodewords(v, e);
  const seg0 = Q.makeSegment('a', 'byte');
  let n = Math.max(1, Math.floor(cap * 0.8) - 3);
  text = (base + 'x'.repeat(4000)).slice(0, n).toLowerCase();
  while (!Q.fits(Q.makeSegment(text), v, e)) text = text.slice(0, -1);
  const ctx = Q.createContext(text, v, e);
  for (const m of [0, 3, 5, 7]) {
    const r = Q.evaluate(ctx, m, null);
    const ref = QRCode.create([{ data: text, mode: 'byte' }], { version: v, errorCorrectionLevel: e, maskPattern: m });
    const sz = ref.modules.size; let diff = 0;
    for (let i = 0; i < sz * sz; i++) if ((ref.modules.data[i] ? 1 : 0) !== r.natural[i]) diff++;
    ok(sz === ctx.size && diff === 0, `ref mismatch v${v}${e} m${m} diff=${diff}`);
    compared++;
  }
  const r = Q.evaluate(ctx, 2, null);
  ok(decode(r.natural, ctx.size) === text, `jsQR decode v${v}${e}`);
}
console.log('compared', compared, 'symbols against qrcode npm');

// alnum & numeric modes decode
for (const t of ['HTTPS://EXAMPLE.COM/ABC', '0123456789012345']) {
  const v = Q.minVersion(Q.makeSegment(t), 'M'); const ctx = Q.createContext(t, v, 'M');
  ok(decode(Q.evaluate(ctx, 1, null).natural, ctx.size) === t, 'mode decode ' + t);
}

// 2. threshold test: corrupt exactly capacity codewords in one block
function thresholdTest(v, e, text, blockIdx) {
  const ctx = Q.createContext(text, v, e);
  const B = ctx.B, L = ctx.layout;
  const r0 = Q.evaluate(ctx, 4, null);
  const res = [];
  for (const n of [B.capacity, B.capacity + 1]) {
    const t = new Int8Array(L.N).fill(-1);
    const blk = B.blocks[blockIdx];
    for (let pos = 0; pos < n; pos++) {
      const k = blk.cwIndex[pos * 2 % (blk.dataLen + B.ecc)];
      const i = L.order[k * 8 + 3];
      t[i] = 1 - r0.natural[i];
    }
    const r = Q.evaluate(ctx, 4, t, { useSpare: false });
    const dec = decode(r.effective, ctx.size);
    res.push({ n, worst: r.worst, decodable: r.decodable, jsqr: dec === text });
  }
  ok(res[0].decodable && res[0].jsqr && res[0].worst === B.capacity, `threshold at cap v${v}${e} ${JSON.stringify(res[0])}`);
  ok(!res[1].decodable && !res[1].jsqr, `threshold cap+1 v${v}${e} ${JSON.stringify(res[1])}`);
  console.log(`threshold v${v}-${e} blocks=${B.numBlocks} cap=${B.capacity}:`, JSON.stringify(res));
}
thresholdTest(5, 'H', 'hello world', 2);
thresholdTest(7, 'Q', 'https://example.com', 5);
thresholdTest(15, 'M', 'https://example.com/long/path', 7);
thresholdTest(4, 'L', 'abc', 0);

// 3. spare-capacity solver: center logo knockout
for (const [v, e] of [[6, 'H'], [10, 'M'], [10, 'Q'], [20, 'L'], [25, 'H']]) {
  const text = 'https://example.com';
  const ctx = Q.createContext(text, v, e);
  const L = ctx.layout, s = ctx.size;
  const t = new Int8Array(L.N).fill(-1);
  const r = Math.floor(s * 0.2);
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    const dx = x - (s - 1) / 2, dy = y - (s - 1) / 2;
    if (Math.abs(dx) <= r && Math.abs(dy) <= r && !L.isFunc[y * s + x]) t[y * s + x] = ((x + y) % 5 === 0) ? 1 : 0;
  }
  const t0 = performance.now();
  const plain = Q.evaluate(ctx, 0, t, { useSpare: false });
  const t1 = performance.now();
  const solved = Q.evaluate(ctx, 0, t, { useSpare: true });
  const t2 = performance.now();
  // the solved natural matrix must itself be a valid QR (untouched)
  ok(decode(solved.natural, s) === text, `solved natural decodes v${v}${e}`);
  const dec = decode(solved.effective, s);
  ok(!solved.decodable || dec === text, `solved effective decodes when predicted v${v}${e}`);
  ok(solved.damaged <= plain.damaged, 'solver no worse');
  console.log(`solver v${v}-${e}: damaged ${plain.damaged} -> ${solved.damaged}, worst ${plain.worst}->${solved.worst}/${solved.capacity}, decodable=${solved.decodable} jsqr=${dec === text}  (${(t1 - t0).toFixed(1)}ms / ${(t2 - t1).toFixed(1)}ms)`);
}
// timing all 8 masks big symbol
{
  const ctx = Q.createContext('hi', 40, 'L'); const L = ctx.layout, s = ctx.size;
  const t = new Int8Array(L.N).fill(-1);
  for (let i = 0; i < L.N; i++) if (Math.random() < 0.3 && !L.isFunc[i]) t[i] = Math.random() < 0.5 ? 1 : 0;
  const a = performance.now(); let best;
  for (let m = 0; m < 8; m++) best = Q.evaluate(ctx, m, t, { useSpare: true });
  console.log('v40-L 30% random targets, 8 masks:', (performance.now() - a).toFixed(0), 'ms', 'damaged', best.damaged, 'worst', best.worst, '/', best.capacity);
  ok(decode(best.natural, s) === 'hi', 'v40 solved natural decodes');
}
// version-1 capacity check
ok(Q.getBlocks(1, 'L').capacity === 2 && Q.getBlocks(1, 'H').capacity === 8 && Q.getBlocks(2, 'L').capacity === 4, 'misdecode p');
console.log(fails ? fails + ' FAILURES' : 'ALL OK');
