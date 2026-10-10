/* QR Doodle — UI. Depends on QRCore (qrcore.js). */
(function () {
  'use strict';
  const Q = window.QRCore;
  const ROLE = Q.ROLE;
  const $ = (id) => document.getElementById(id);
  const STORAGE_KEY = 'qr-doodle-v1';
  const APP_VERSION = window.QR_DOODLE_VERSION || 'dev';
  document.querySelectorAll('[data-app-version]').forEach((el) => { el.textContent = 'v' + APP_VERSION; });

  const DEFAULTS = {
    text: 'https://example.com',
    mode: 'auto',
    ecl: 'H',
    version: 0,
    maskMode: 'design',
    useSpare: true,
    lockFunc: true,
    margin: 60,
    tool: 'brush',
    paint: 1,
    brush: 1,
    brushShape: 'square',
    symmetry: 'none',
    zoom: 0,
    autoScan: true,
    view: { required: true, forced: true, conflicts: true, damaged: true, free: false, blocks: false, codewords: false, grid: true, logo: true, focus: false, focusData: 'faint' },
    style: { shape: 'square', scale: 100, finder: 'square', fg: '#000000', bg: '#ffffff', quiet: 4, exportPx: 1024 },
    logo: { src: null, mode: 'trace', size: 30, x: 50, y: 50, threshold: 128, invert: false, traceLight: true, shape: 'rect', pad: 1, fill: 0, opacity: 45, inExport: false },
  };

  /* ---------- state ---------- */

  let S = clone(DEFAULTS);
  // Painted modules, keyed by offset from the symbol centre so drawings survive version changes.
  // value: 1 dark, 0 light, -2 "explicitly normal" (erases a logo-traced module)
  let ov = new Map();
  let logoImg = null;
  let ctx = null, ctxKey = '';
  let result = null, maskResults = null, chosenMask = 0, masksStale = false;
  let targets = null;
  let logoCache = { key: '', layers: null };
  let notice = '';
  const undoStack = [], redoStack = [];
  let hover = null, hoverBlock = -1, drag = null;
  let sel = null;     // selection rectangle {x0, y0, x1, y1, size} in module coordinates
  let clip = null;    // clipboard {w, h, data: Int8Array (-1 transparent, 0 light, 1 dark)}
  let pasting = null; // floating paste {clip}
  const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';
  let cell = 10;
  const PAD = 2; // light margin (in modules) drawn around the symbol in the editor

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function deepMerge(base, over) {
    const out = clone(base);
    if (!over || typeof over !== 'object') return out;
    for (const k of Object.keys(base)) {
      if (!(k in over)) continue;
      if (base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) out[k] = deepMerge(base[k], over[k]);
      else if (base[k] === null || typeof over[k] === typeof base[k]) out[k] = over[k];
    }
    return out;
  }
  const ovKey = (dx, dy) => (dx + 1024) * 2048 + (dy + 1024);
  const ovDx = (k) => Math.floor(k / 2048) - 1024;
  const ovDy = (k) => (k % 2048) - 1024;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  /* ---------- logo ---------- */

  function logoRect(size) {
    const lg = S.logo;
    const ar = logoImg ? (logoImg.naturalHeight || logoImg.height) / (logoImg.naturalWidth || logoImg.width) || 1 : 1;
    const w = lg.size / 100 * size, h = w * ar;
    return { x: lg.x / 100 * size - w / 2, y: lg.y / 100 * size - h / 2, w, h };
  }

  const sampleCanvas = document.createElement('canvas');
  const SAMPLE = 6; // sub-pixels per module when sampling the logo

  // Renders the logo at SAMPLE px per module and calls fn(x, y, avgAlpha, avgLum) per covered module,
  // averaging over sub-pixels lo..hi-1 of each module (whole module, or just its centre).
  function sampleLogo(size, lo, hi, fn) {
    const k = SAMPLE, dim = size * k, r = logoRect(size);
    sampleCanvas.width = sampleCanvas.height = dim;
    const g = sampleCanvas.getContext('2d', { willReadFrequently: true });
    g.clearRect(0, 0, dim, dim);
    g.imageSmoothingQuality = 'high';
    g.drawImage(logoImg, r.x * k, r.y * k, r.w * k, r.h * k);
    const xs = Math.max(0, Math.floor(r.x)), xe = Math.min(size, Math.ceil(r.x + r.w));
    const ys = Math.max(0, Math.floor(r.y)), ye = Math.min(size, Math.ceil(r.y + r.h));
    if (xe <= xs || ye <= ys) return;
    const img = g.getImageData(xs * k, ys * k, (xe - xs) * k, (ye - ys) * k);
    const iw = img.width, px = img.data, n = (hi - lo) * (hi - lo);
    for (let y = ys; y < ye; y++) for (let x = xs; x < xe; x++) {
      let sa = 0, sl = 0, mn = 255, mx = 0;
      for (let dy = lo; dy < hi; dy++) for (let dx = lo; dx < hi; dx++) {
        const p = (((y - ys) * k + dy) * iw + (x - xs) * k + dx) * 4;
        const a = px[p + 3], l = 0.299 * px[p] + 0.587 * px[p + 1] + 0.114 * px[p + 2];
        sa += a; sl += a * l;
        if (a >= 128) { if (l < mn) mn = l; if (l > mx) mx = l; }
      }
      fn(x, y, sa / (n * 255), sa ? sl / sa : 255, mn, mx);
    }
  }

  /**
   * Logo layers for a symbol size:
   *  targets: what the chosen logo mode asks of the modules (trace / knockout)
   *  cover:   when the image itself is drawn on the final code, what a scanner will see under it
   *           (sampled at module centres). These modules are part of the export no matter what,
   *           so they bypass the lock and override everything else.
   */
  function getLogoLayers(size) {
    const lg = S.logo;
    if (!logoImg) return null;
    const key = [size, lg.mode, lg.size, lg.x, lg.y, lg.threshold, lg.invert, lg.traceLight, lg.shape, lg.pad, lg.fill, lg.inExport, lg.src && lg.src.length].join('|');
    if (logoCache.key === key) return logoCache.layers;
    let targets = null, cover = null;
    if (lg.mode === 'knockout') {
      targets = new Int8Array(size * size).fill(-1);
      const r = logoRect(size);
      const p = lg.pad, x0 = r.x - p, y0 = r.y - p, w = r.w + 2 * p, h = r.h + 2 * p;
      const cx = x0 + w / 2, cy = y0 + h / 2;
      for (let y = Math.max(0, Math.floor(y0)); y < Math.min(size, Math.ceil(y0 + h)); y++)
        for (let x = Math.max(0, Math.floor(x0)); x < Math.min(size, Math.ceil(x0 + w)); x++) {
          const mx = x + 0.5, my = y + 0.5;
          const inside = lg.shape === 'ellipse'
            ? ((mx - cx) / (w / 2)) ** 2 + ((my - cy) / (h / 2)) ** 2 <= 1
            : mx >= x0 && mx <= x0 + w && my >= y0 && my <= y0 + h;
          if (inside) targets[y * size + x] = lg.fill;
        }
    } else if (lg.mode === 'trace') {
      targets = new Int8Array(size * size).fill(-1);
      sampleLogo(size, 0, SAMPLE, (x, y, a, l) => {
        if (a < 0.5) return;
        let dark = l < lg.threshold;
        if (lg.invert) dark = !dark;
        if (dark) targets[y * size + x] = 1;
        else if (lg.traceLight) targets[y * size + x] = 0;
      });
    }
    let uncertain = null;
    if (lg.inExport) {
      cover = new Int8Array(size * size).fill(-1);
      uncertain = new Uint8Array(size * size);
      sampleLogo(size, 1, SAMPLE - 1, (x, y, a, l, mn, mx) => {
        if (a < 0.1) return; // (nearly) transparent: the module shows through
        // luminance a scanner sees if the module underneath is dark vs light
        const overDark = a * l, overLight = a * l + (1 - a) * 255, i = y * size + x;
        if (mn < 128 && mx >= 128) { cover[i] = l < 128 ? 1 : 0; uncertain[i] = 1; } // an edge runs through the module centre
        else if (overLight < 96) cover[i] = 1;
        else if (overDark > 160) cover[i] = 0;
        else { cover[i] = (a * l + (1 - a) * 128) < 128 ? 1 : 0; uncertain[i] = 1; } // mid-tone or partial edge: could read either way
      });
    }
    const layers = { targets, cover, uncertain };
    logoCache = { key, layers };
    return layers;
  }

  function loadLogoSrc(src, cb) {
    if (!src) { logoImg = null; logoCache.key = ''; cb && cb(); return; }
    const img = new Image();
    img.onload = () => { logoImg = img; logoCache.key = ''; cb && cb(); };
    img.onerror = () => { logoImg = null; S.logo.src = null; cb && cb(); };
    img.src = src;
  }

  function importLogoFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        // Downscale so the design (with logo) fits comfortably in localStorage.
        const nw = img.naturalWidth || 512, nh = img.naturalHeight || 512;
        const scale = Math.min(1, 600 / Math.max(nw, nh));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(nw * scale)); c.height = Math.max(1, Math.round(nh * scale));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        S.logo.src = c.toDataURL('image/png');
        loadLogoSrc(S.logo.src, () => { syncControls(); schedule(true); });
      };
      img.onerror = () => alert('Could not read that image.');
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  }

  /* ---------- targets & recompute ---------- */

  let uncertainMask = null; // modules under the drawn logo that are neither clearly dark nor light
  // The drawing itself: painted modules on top of the logo mode's targets (before lock / logo cover).
  function buildDesign(size) {
    const mid = (size - 1) / 2;
    const t = new Int8Array(size * size).fill(-1);
    const layers = getLogoLayers(size);
    if (layers && layers.targets) t.set(layers.targets);
    for (const [k, v] of ov) {
      const x = mid + ovDx(k), y = mid + ovDy(k);
      if (x < 0 || y < 0 || x >= size || y >= size) continue;
      t[y * size + x] = v === -2 ? -1 : v;
    }
    return t;
  }
  function buildTargets(c) {
    const L = c.layout, size = L.size, N = L.N;
    const t = buildDesign(size);
    const layers = getLogoLayers(size);
    if (S.lockFunc) for (let i = 0; i < N; i++) if (L.isFunc[i]) t[i] = -1;
    // the logo image drawn on top is what scanners will actually see there
    if (layers && layers.cover) for (let i = 0; i < N; i++) if (layers.cover[i] >= 0) t[i] = layers.cover[i];
    uncertainMask = layers && layers.uncertain;
    return t;
  }

  function validateText() {
    if (S.mode === 'numeric' && !/^[0-9]*$/.test(S.text)) return 'Numeric mode only allows digits 0–9.';
    if (S.mode === 'alphanumeric' && !/^[0-9A-Z $%*+\-./:]*$/.test(S.text)) return 'Alphanumeric mode only allows 0–9, A–Z (uppercase), space and $%*+-./:';
    return null;
  }

  function recompute(full) {
    const err = validateText();
    if (err) return showError(err);
    const seg = Q.makeSegment(S.text, S.mode);
    const minV = Q.minVersion(seg, S.ecl);
    if (!minV) return showError(`Too much content for error correction ${S.ecl}, even at version 40. Shorten the text or lower the error correction.`);
    showError(null);
    notice = '';
    let ver = S.version || minV;
    if (ver < minV) { notice = `Version ${S.version} can't hold this content at level ${S.ecl}, so version ${minV} is used instead.`; ver = minV; }
    const key = S.text + '\u0000' + S.mode + '|' + ver + S.ecl;
    if (key !== ctxKey) { ctx = Q.createContext(S.text, ver, S.ecl, S.mode); ctxKey = key; maskResults = null; }
    if (sel && sel.size !== ctx.size) sel = null;

    targets = buildTargets(ctx);
    const opts = { useSpare: S.useSpare, uncertain: uncertainMask };
    let m = chosenMask;
    if (/^\d$/.test(S.maskMode)) m = +S.maskMode;
    else if (S.maskMode === 'penalty') m = Q.penaltyMask(ctx);

    if (full || !maskResults) {
      maskResults = [];
      for (let k = 0; k < 8; k++) maskResults.push(Q.evaluate(ctx, k, targets, opts));
      if (S.maskMode === 'design') {
        let best = clamp(chosenMask, 0, 7), bestScore = Q.designScore(maskResults[best]);
        for (let k = 0; k < 8; k++) { const s = Q.designScore(maskResults[k]); if (s < bestScore - 1e-9) { best = k; bestScore = s; } }
        m = best;
      }
      result = maskResults[m];
      masksStale = false;
    } else {
      result = Q.evaluate(ctx, m, targets, opts);
      masksStale = true;
    }
    chosenMask = m;

    renderEditor();
    renderStatus();
    renderMasks();
    renderPreview();
    renderContentInfo(minV);
    updateUndoButtons();
    if (full) { scheduleSave(); scheduleAutoScan(); }
  }

  let rafPending = false, rafFull = false;
  function schedule(full) {
    rafFull = rafFull || !!full;
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; const f = rafFull; rafFull = false; recompute(f); });
  }

  function showError(msg) {
    const b = $('errorBanner');
    b.hidden = !msg;
    if (msg) b.textContent = msg;
  }

  /* ---------- editor rendering ---------- */

  const canvas = $('editor');
  const wrap = $('canvasWrap');

  function computeCell() {
    if (S.zoom) return S.zoom;
    const avail = Math.min(wrap.clientWidth, wrap.clientHeight) - 24;
    return Math.max(2, Math.floor(avail / (ctx.size + 2 * PAD)));
  }

  function renderEditor() {
    if (!ctx || !result) return;
    const L = ctx.layout, size = L.size, r = result, V = S.view, B = ctx.B;
    const dataBits = L.rawCW * 8;
    cell = computeCell();
    const dim = (size + 2 * PAD) * cell, dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(dim * dpr)) {
      canvas.width = canvas.height = Math.round(dim * dpr);
      canvas.style.width = canvas.style.height = dim + 'px';
    }
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, dim, dim);
    const o = PAD * cell;
    const F = V.focus;

    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const i = y * size + x, v = r.effective[i], role = L.role[i];
      let col;
      if (V.forced && targets[i] >= 0) col = v ? '#6d28d9' : '#e7defd';
      else if (V.required && L.isFunc[i]) col = v ? '#1e3a8a' : '#d4e0ff';
      else if (V.free && role === ROLE.REMAINDER) col = v ? '#166534' : '#c6f0d4';
      // design focus: hide ordinary (unpainted) data so the drawing stands out
      else if (F && !L.isFunc[i] && targets[i] < 0) col = v && V.focusData === 'faint' ? '#e2e4ea' : '#ffffff';
      else col = v ? '#14161b' : '#ffffff';
      if (col === '#ffffff') continue;
      g.fillStyle = col;
      g.fillRect(o + x * cell, o + y * cell, cell, cell);
    }

    if (V.blocks || hoverBlock >= 0) {
      for (let i = 0; i < L.N; i++) {
        const k = L.orderIdx[i];
        if (k < 0 || k >= dataBits) continue;
        const j = B.cwBlock[k >>> 3];
        if (hoverBlock >= 0 && j !== hoverBlock) continue;
        g.fillStyle = hoverBlock >= 0 ? 'rgba(124,92,255,0.45)' : `hsla(${(j * 137.508) % 360},85%,55%,0.38)`;
        g.fillRect(o + (i % size) * cell, o + ((i / size) | 0) * cell, cell, cell);
      }
    }

    if (V.damaged) {
      g.fillStyle = 'rgba(239,68,68,0.42)';
      for (let i = 0; i < L.N; i++) {
        const k = L.orderIdx[i];
        if (k < 0 || k >= dataBits || !r.cwDamaged[k >>> 3]) continue;
        g.fillRect(o + (i % size) * cell, o + ((i / size) | 0) * cell, cell, cell);
      }
    }

    if (V.grid && cell >= 5) {
      g.strokeStyle = 'rgba(120,128,145,0.28)';
      g.lineWidth = 1;
      g.beginPath();
      for (let n = 0; n <= size; n++) {
        const p = o + n * cell + 0.5;
        g.moveTo(p, o); g.lineTo(p, o + size * cell);
        g.moveTo(o, p); g.lineTo(o + size * cell, p);
      }
      g.stroke();
    }

    if (V.codewords && cell >= 4) {
      const cwOf = (x, y) => {
        if (x < 0 || y < 0 || x >= size || y >= size) return -1;
        const k = L.orderIdx[y * size + x];
        return k < 0 || k >= dataBits ? -1 : k >>> 3;
      };
      g.strokeStyle = 'rgba(245,158,11,0.95)';
      g.lineWidth = Math.max(1, cell / 10);
      g.beginPath();
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const c0 = cwOf(x, y);
        const cr = cwOf(x + 1, y), cb = cwOf(x, y + 1);
        if (c0 !== cr && (c0 >= 0 || cr >= 0)) { g.moveTo(o + (x + 1) * cell, o + y * cell); g.lineTo(o + (x + 1) * cell, o + (y + 1) * cell); }
        if (c0 !== cb && (c0 >= 0 || cb >= 0)) { g.moveTo(o + x * cell, o + (y + 1) * cell); g.lineTo(o + (x + 1) * cell, o + (y + 1) * cell); }
        if (x === 0 && c0 >= 0) { g.moveTo(o, o + y * cell); g.lineTo(o, o + (y + 1) * cell); }
        if (y === 0 && c0 >= 0) { g.moveTo(o + x * cell, o); g.lineTo(o + (x + 1) * cell, o); }
      }
      g.stroke();
    }

    if (V.conflicts) {
      g.fillStyle = '#ef4444';
      const rad = Math.max(1.2, cell * 0.2);
      g.beginPath();
      for (let i = 0; i < L.N; i++) {
        if (!r.conflict[i]) continue;
        const cx = o + (i % size + 0.5) * cell, cy = o + (((i / size) | 0) + 0.5) * cell;
        g.moveTo(cx + rad, cy);
        g.arc(cx, cy, rad, 0, Math.PI * 2);
      }
      g.fill();
    }

    if (logoImg && (V.logo || S.tool === 'logo')) {
      const lr = logoRect(size);
      if (V.logo && S.logo.opacity > 0) {
        g.globalAlpha = S.logo.opacity / 100;
        g.drawImage(logoImg, o + lr.x * cell, o + lr.y * cell, lr.w * cell, lr.h * cell);
        g.globalAlpha = 1;
      }
      if (S.tool === 'logo') {
        g.setLineDash([5, 4]);
        g.strokeStyle = '#7c5cff';
        g.lineWidth = 2;
        g.strokeRect(o + lr.x * cell, o + lr.y * cell, lr.w * cell, lr.h * cell);
        g.setLineDash([]);
      }
    }

    // hovered codeword
    if (hover && !drag && !pasting && S.tool !== 'select') {
      const i = hover.y * size + hover.x;
      const k = L.orderIdx[i];
      g.lineWidth = 2;
      if (k >= 0 && k < dataBits) {
        const cw = k >>> 3;
        g.strokeStyle = '#f59e0b';
        for (let b = 0; b < 8; b++) {
          const m = L.order[cw * 8 + b];
          g.strokeRect(o + (m % size) * cell + 1, o + ((m / size) | 0) * cell + 1, cell - 2, cell - 2);
        }
      }
    }

    // tool preview
    if (hover && S.tool === 'brush' && !pasting) {
      g.strokeStyle = S.paint === 1 ? '#a78bfa' : S.paint === 0 ? '#7c5cff' : '#f87171';
      g.lineWidth = 1.5;
      for (const [dx, dy] of brushOffsets()) g.strokeRect(o + (hover.x + dx) * cell + 0.75, o + (hover.y + dy) * cell + 0.75, cell - 1.5, cell - 1.5);
    }
    if (drag && drag.type === 'shape') {
      const x0 = Math.min(drag.start.x, drag.end.x), x1 = Math.max(drag.start.x, drag.end.x);
      const y0 = Math.min(drag.start.y, drag.end.y), y1 = Math.max(drag.start.y, drag.end.y);
      g.fillStyle = drag.val === 1 ? 'rgba(109,40,217,0.45)' : drag.val === 0 ? 'rgba(231,222,253,0.7)' : 'rgba(239,68,68,0.3)';
      for (const [x, y] of shapeCells(x0, y0, x1, y1, S.tool === 'ellipse')) g.fillRect(o + x * cell, o + y * cell, cell, cell);
      g.strokeStyle = '#7c5cff'; g.lineWidth = 2;
      if (S.tool === 'ellipse') {
        g.beginPath();
        g.ellipse(o + (x0 + x1 + 1) / 2 * cell, o + (y0 + y1 + 1) / 2 * cell, (x1 - x0 + 1) / 2 * cell, (y1 - y0 + 1) / 2 * cell, 0, 0, Math.PI * 2);
        g.stroke();
      } else g.strokeRect(o + x0 * cell, o + y0 * cell, (x1 - x0 + 1) * cell, (y1 - y0 + 1) * cell);
    }

    // selection, moving selection, floating paste
    const drawClip = (c, ox, oy) => {
      for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) {
        const v = c.data[y * c.w + x];
        if (v < 0 || ox + x < 0 || oy + y < 0 || ox + x >= size || oy + y >= size) continue;
        g.fillStyle = v ? 'rgba(76,29,149,0.92)' : 'rgba(237,233,254,0.95)';
        g.fillRect(o + (ox + x) * cell, o + (oy + y) * cell, cell, cell);
      }
    };
    const drawSel = (x0, y0, x1, y1) => {
      const X = o + x0 * cell, Y = o + y0 * cell, W = (x1 - x0 + 1) * cell, H = (y1 - y0 + 1) * cell;
      g.fillStyle = 'rgba(56,189,248,0.12)';
      g.fillRect(X, Y, W, H);
      g.lineWidth = 2;
      g.setLineDash([6, 4]);
      g.strokeStyle = '#ffffff'; g.strokeRect(X, Y, W, H);
      g.lineDashOffset = 5; g.strokeStyle = '#0284c7'; g.strokeRect(X, Y, W, H);
      g.setLineDash([]); g.lineDashOffset = 0;
    };
    const sr = selRect();
    if (drag && drag.type === 'select') { const r2 = normRect(drag.start, drag.end); drawSel(r2.x0, r2.y0, r2.x1, r2.y1); }
    else if (drag && drag.type === 'move') {
      const dx = drag.cur.x - drag.start.x, dy = drag.cur.y - drag.start.y;
      drawClip(drag.clip, drag.ox + dx, drag.oy + dy);
      drawSel(drag.ox + dx, drag.oy + dy, drag.ox + dx + drag.clip.w - 1, drag.oy + dy + drag.clip.h - 1);
    } else if (sr) drawSel(sr.x0, sr.y0, sr.x1, sr.y1);
    if (pasting) {
      const c = pasting.clip, po = pasteOrigin(c);
      drawClip(c, po.x, po.y);
      drawSel(po.x, po.y, po.x + c.w - 1, po.y + c.h - 1);
    }
    updateEditUI();
  }

  /* ---------- selection & clipboard ---------- */

  function selRect() { return sel && ctx && sel.size === ctx.size ? sel : null; }
  function normRect(a, b) {
    const n = ctx.size - 1;
    return { x0: clamp(Math.min(a.x, b.x), 0, n), y0: clamp(Math.min(a.y, b.y), 0, n), x1: clamp(Math.max(a.x, b.x), 0, n), y1: clamp(Math.max(a.y, b.y), 0, n), size: ctx.size };
  }
  function inSel(p) { const r = selRect(); return r && p.x >= r.x0 && p.x <= r.x1 && p.y >= r.y0 && p.y <= r.y1; }
  function grabSelection() {
    const r = selRect();
    if (!r) return null;
    const size = ctx.size, d = buildDesign(size), w = r.x1 - r.x0 + 1, h = r.y1 - r.y0 + 1, data = new Int8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = d[(r.y0 + y) * size + r.x0 + x];
    return { w, h, data };
  }
  function copySelection() {
    const c = grabSelection();
    if (!c) return false;
    clip = c;
    const n = c.data.reduce((a, v) => a + (v >= 0), 0);
    flashHint(n ? `Copied ${c.w}×${c.h} (${n} painted module${n > 1 ? 's' : ''})` : 'Copied, but the selection has no painted modules');
    updateEditUI();
    return true;
  }
  function clearRect(r) { for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) setModule(x, y, -1); }
  function deleteSelection() {
    const r = selRect();
    if (!r) return;
    pushUndo(); clearRect(r); schedule(true);
  }
  function cutSelection() { if (copySelection()) deleteSelection(); }
  function placeClip(c, ox, oy) {
    for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) {
      const v = c.data[y * c.w + x];
      if (v >= 0) setModule(ox + x, oy + y, v);
    }
    const r = normRect({ x: ox, y: oy }, { x: ox + c.w - 1, y: oy + c.h - 1 });
    sel = r.x0 <= r.x1 && r.y0 <= r.y1 ? r : null;
  }
  function startPaste() {
    if (!clip || !ctx) return;
    pasting = { clip: { w: clip.w, h: clip.h, data: clip.data.slice() } };
    hideTooltip();
    renderEditor();
  }
  function endPaste() { pasting = null; renderEditor(); }
  function pasteOrigin(c) {
    const h = hover || { x: (ctx.size - 1) / 2, y: (ctx.size - 1) / 2 };
    return { x: h.x - Math.floor(c.w / 2), y: h.y - Math.floor(c.h / 2) };
  }
  function transformClip(c, op) {
    const { w, h, data } = c, out = new Int8Array(w * h);
    if (op === 'rot') { // 90° clockwise
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[x * h + (h - 1 - y)] = data[y * w + x];
      return { w: h, h: w, data: out };
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++)
      out[y * w + x] = op === 'h' ? data[y * w + (w - 1 - x)] : data[(h - 1 - y) * w + x];
    return { w, h, data: out };
  }
  function selectAll() {
    if (!ctx) return;
    sel = { x0: 0, y0: 0, x1: ctx.size - 1, y1: ctx.size - 1, size: ctx.size };
    setTool('select');
  }

  let hintFlash = '', hintTimer = 0;
  function flashHint(msg) {
    hintFlash = msg;
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => { hintFlash = ''; updateEditUI(); }, 1800);
    updateEditUI();
  }
  function updateEditUI() {
    const has = !!selRect();
    $('copyBtn').disabled = $('cutBtn').disabled = $('deleteSelBtn').disabled = !has;
    $('pasteBtn').disabled = !clip;
    let hint = hintFlash;
    if (!hint && pasting) hint = 'Click to place · Shift+click to place repeatedly · R rotate · H / V flip · Esc cancel';
    else if (!hint && S.tool === 'select') hint = has
      ? `Drag inside to move · ${MOD}C copy · ${MOD}X cut · ${MOD}V paste · Delete clears · Esc deselects`
      : `Drag to select · ${MOD}A select all · ${MOD}V paste`;
    const el = $('modeHint');
    el.hidden = !hint;
    el.textContent = hint;
    canvas.style.cursor = pasting ? 'copy' : S.tool === 'logo' ? 'move' : (S.tool === 'select' && hover && inSel(hover)) ? 'move' : 'crosshair';
  }

  /* ---------- painting ---------- */

  function brushOffsets() {
    const n = S.brush, s = -Math.floor((n - 1) / 2), out = [];
    const c = (n - 1) / 2 + s, r2 = (n / 2) * (n / 2) + 0.01;
    for (let dy = s; dy < s + n; dy++) for (let dx = s; dx < s + n; dx++) {
      if (S.brushShape === 'round' && n > 2 && (dx - c) ** 2 + (dy - c) ** 2 > r2) continue;
      out.push([dx, dy]);
    }
    return out;
  }

  function shapeCells(x0, y0, x1, y1, ellipse) {
    const out = [];
    const cx = (x0 + x1 + 1) / 2, cy = (y0 + y1 + 1) / 2, rx = (x1 - x0 + 1) / 2, ry = (y1 - y0 + 1) / 2;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      if (ellipse && ((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2 > 1) continue;
      out.push([x, y]);
    }
    return out;
  }

  function setModule(x, y, val) {
    const L = ctx.layout, size = L.size;
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = y * size + x;
    if (S.lockFunc && L.isFunc[i]) return;
    const mid = (size - 1) / 2, key = ovKey(x - mid, y - mid);
    const before = ov.get(key);
    if (val === -1) {
      const layers = getLogoLayers(size);
      if (layers && layers.targets && layers.targets[i] >= 0) ov.set(key, -2); else ov.delete(key);
    } else ov.set(key, val);
    if (ov.get(key) !== before && drag) drag.changed = true;
  }

  function paintSym(x, y, val) {
    const n = ctx.size - 1;
    const pts = [[x, y]];
    const sym = S.symmetry;
    if (sym === 'h' || sym === 'both') pts.push([n - x, y]);
    if (sym === 'v' || sym === 'both') pts.push([x, n - y]);
    if (sym === 'both') pts.push([n - x, n - y]);
    if (sym === 'rot') pts.push([n - y, x], [n - x, n - y], [y, n - x]);
    for (const [a, b] of pts) setModule(a, b, val);
  }

  function stamp(x, y, val) { for (const [dx, dy] of brushOffsets()) paintSym(x + dx, y + dy, val); }

  function strokeLine(a, b, val) {
    let x0 = a.x, y0 = a.y;
    const dx = Math.abs(b.x - x0), dy = -Math.abs(b.y - y0), sx = x0 < b.x ? 1 : -1, sy = y0 < b.y ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      stamp(x0, y0, val);
      if (x0 === b.x && y0 === b.y) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }

  function cellAt(e) {
    const rect = canvas.getBoundingClientRect();
    return { x: Math.floor((e.clientX - rect.left) / cell) - PAD, y: Math.floor((e.clientY - rect.top) / cell) - PAD };
  }

  function pushUndo() {
    undoStack.push(new Map(ov));
    if (undoStack.length > 200) undoStack.shift();
    redoStack.length = 0;
    updateUndoButtons();
  }
  function undo() { if (!undoStack.length) return; redoStack.push(new Map(ov)); ov = undoStack.pop(); schedule(true); }
  function redo() { if (!redoStack.length) return; undoStack.push(new Map(ov)); ov = redoStack.pop(); schedule(true); }
  function updateUndoButtons() { $('undoBtn').disabled = !undoStack.length; $('redoBtn').disabled = !redoStack.length; }

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('pointerdown', (e) => {
    if (!ctx || (e.button !== 0 && e.button !== 2)) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    const p = cellAt(e);
    const val = e.button === 2 ? -1 : S.paint;
    hideTooltip();
    if (pasting) {
      if (e.button === 2) { endPaste(); return; }
      pushUndo();
      const po = pasteOrigin(pasting.clip);
      placeClip(pasting.clip, po.x, po.y);
      if (!e.shiftKey) pasting = null;
      schedule(true);
      return;
    }
    if (S.tool === 'select') {
      if (e.button === 2) { sel = null; renderEditor(); return; }
      if (inSel(p)) {
        const r = selRect(), c = grabSelection();
        pushUndo();
        clearRect(r);
        drag = { type: 'move', clip: c, start: p, cur: p, ox: r.x0, oy: r.y0 };
        schedule(false);
      } else {
        sel = null;
        drag = { type: 'select', start: p, end: p };
        renderEditor();
      }
      return;
    }
    if (S.tool === 'logo') {
      if (!logoImg) return;
      drag = { type: 'logo', sx: e.clientX, sy: e.clientY, ox: S.logo.x, oy: S.logo.y };
      return;
    }
    pushUndo();
    if (S.tool === 'brush') {
      drag = { type: 'brush', val, last: p, changed: false };
      stamp(p.x, p.y, val);
      schedule(false);
    } else {
      drag = { type: 'shape', val, start: p, end: p, changed: false };
      renderEditor();
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!ctx) return;
    const p = cellAt(e);
    const inside = p.x >= 0 && p.y >= 0 && p.x < ctx.size && p.y < ctx.size;
    const moved = !hover || hover.x !== p.x || hover.y !== p.y;
    hover = inside ? p : null;
    if (drag) {
      if (drag.type === 'brush' && moved) { strokeLine(drag.last, p, drag.val); drag.last = p; schedule(false); }
      else if ((drag.type === 'shape' || drag.type === 'select') && moved) { drag.end = p; renderEditor(); }
      else if (drag.type === 'move' && moved) { drag.cur = p; renderEditor(); }
      else if (drag.type === 'logo') {
        const k = 100 / (cell * ctx.size);
        S.logo.x = clamp(drag.ox + (e.clientX - drag.sx) * k, 0, 100);
        S.logo.y = clamp(drag.oy + (e.clientY - drag.sy) * k, 0, 100);
        syncLogoSliders();
        schedule(false);
      }
      return;
    }
    if (moved) renderEditor();
    if (hover && !pasting) showTooltip(e, p); else hideTooltip();
  });
  function endDrag() {
    if (!drag) return;
    if (drag.type === 'select') {
      const moved = drag.start.x !== drag.end.x || drag.start.y !== drag.end.y;
      sel = moved ? normRect(drag.start, drag.end) : null; // a plain click deselects
      drag = null;
      renderEditor();
      return;
    }
    if (drag.type === 'move') {
      const d = drag;
      drag = null;
      placeClip(d.clip, d.ox + d.cur.x - d.start.x, d.oy + d.cur.y - d.start.y);
      schedule(true);
      return;
    }
    if (drag.type === 'shape') {
      const x0 = Math.min(drag.start.x, drag.end.x), x1 = Math.max(drag.start.x, drag.end.x);
      const y0 = Math.min(drag.start.y, drag.end.y), y1 = Math.max(drag.start.y, drag.end.y);
      for (const [x, y] of shapeCells(x0, y0, x1, y1, S.tool === 'ellipse')) paintSym(x, y, drag.val);
    }
    if ((drag.type === 'brush' || drag.type === 'shape') && !drag.changed) { undoStack.pop(); updateUndoButtons(); }
    drag = null;
    schedule(true);
  }
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('pointerleave', () => { if (!drag) { hover = null; hideTooltip(); renderEditor(); } });
  let wheelTimer = 0;
  canvas.addEventListener('wheel', (e) => {
    if (S.tool !== 'logo' || !logoImg) return;
    e.preventDefault();
    S.logo.size = clamp(+(S.logo.size * (e.deltaY < 0 ? 1.04 : 1 / 1.04)).toFixed(2), 5, 100);
    syncLogoSliders();
    schedule(false);
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(() => schedule(true), 250);
  }, { passive: false });

  /* ---------- tooltip ---------- */

  const tip = $('tooltip');
  function hideTooltip() { tip.hidden = true; }
  function showTooltip(e, p) {
    const L = ctx.layout, B = ctx.B, size = L.size, i = p.y * size + p.x, r = result;
    const role = L.role[i], k = L.orderIdx[i];
    const name = (v) => v ? 'dark' : 'light';
    const lines = [`<b>(${p.x}, ${p.y})</b> · ${Q.ROLE_NAMES[role]}`];
    if (L.isFunc[i]) {
      lines.push(S.lockFunc ? 'Required: locked' : '<span class="bad">Required: unlocked, so changing it is risky</span>');
    } else if (role === ROLE.REMAINDER) {
      lines.push('<span class="good">Not part of any codeword: free to paint</span>');
    } else {
      const cw = k >>> 3, j = B.cwBlock[cw], pos = B.cwPos[cw], d = B.blocks[j].dataLen;
      const kind = pos < d ? `data byte ${pos + 1}/${d}` + (B.blocks[j].start + pos >= ctx.contentLen ? ' (padding)' : '') : `EC byte ${pos - d + 1}/${B.ecc}`;
      lines.push(`Codeword ${cw + 1}/${L.rawCW} · block ${j + 1}/${B.numBlocks} · ${kind}`);
      const be = r.blockErr[j];
      lines.push(`Block ${j + 1} damage: <b class="${be > B.capacity ? 'bad' : ''}">${be}/${B.capacity}</b>` + (r.cwDamaged[cw] ? ' · <span class="bad">this codeword is damaged</span>' : ''));
    }
    const layers = getLogoLayers(size);
    if (layers && layers.cover && layers.cover[i] >= 0) lines.push('Covered by the logo image on the final code');
    const t = targets[i];
    if (t >= 0) {
      lines.push(`Natural: ${name(r.natural[i])} · painted: ${name(t)} ` + (r.conflict[i] ? '<span class="bad">✗ costs budget</span>' : '<span class="good">✓ free</span>'));
    } else {
      lines.push(`Natural: ${name(r.natural[i])}`);
    }
    tip.innerHTML = lines.join('<br>');
    tip.hidden = false;
    const wr = wrap.getBoundingClientRect();
    let x = e.clientX - wr.left + wrap.scrollLeft + 16, y = e.clientY - wr.top + wrap.scrollTop + 16;
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    if (x + tw > wrap.scrollLeft + wrap.clientWidth - 4) x -= tw + 28;
    if (y + th > wrap.scrollTop + wrap.clientHeight - 4) y -= th + 28;
    tip.style.left = x + 'px'; tip.style.top = y + 'px';
  }

  /* ---------- status ---------- */

  function levelFor(r, margin) {
    if (!r.decodable) return 'fail';
    const fc = r.funcChanged;
    const risky = r.worstRatio > margin || fc[ROLE.FINDER] || fc[ROLE.TIMING] || fc[ROLE.ALIGNMENT] || fc[ROLE.SEPARATOR] ||
      !r.format.okA || !r.format.okB || (r.version && (!r.version.okA || !r.version.okB));
    return risky ? 'risky' : 'pass';
  }

  function renderStatus() {
    const r = result, B = ctx.B, L = ctx.layout, margin = S.margin / 100;
    const level = levelFor(r, margin);
    const issues = [];
    if (notice) issues.push(['info', notice]);
    const fc = r.funcChanged;
    const fin = r.finderChanged;
    if (fc[ROLE.FINDER]) issues.push(['bad', `Finder pattern changed (${['top-left', 'top-right', 'bottom-left'].filter((_, n) => fin[n]).join(', ')}: ${fc[ROLE.FINDER]} modules). Scanners may fail to locate the code.`]);
    if (r.formatFail) issues.push(['bad', 'Both copies of the format info are unreadable (more than 3 bit errors each). The code will not scan.']);
    else if (!r.format.okA || !r.format.okB) issues.push(['warn', `One copy of the format info is unreadable (${!r.format.okA ? 'top-left' : 'top-right/bottom-left'}). The code relies on the other copy.`]);
    else if (fc[ROLE.FORMAT]) issues.push(['warn', `Format info altered (${r.format.distA}/${r.format.distB} bit errors per copy, limit 3).`]);
    if (r.version) {
      if (r.versionFail) issues.push(['bad', 'Both copies of the version info are unreadable. The code will not scan.']);
      else if (!r.version.okA || !r.version.okB) issues.push(['warn', 'One copy of the version info is unreadable.']);
      else if (fc[ROLE.VERSION]) issues.push(['warn', `Version info altered (${r.version.distA}/${r.version.distB} bit errors per copy, limit 3).`]);
    }
    if (fc[ROLE.TIMING]) issues.push(['warn', `Timing pattern changed (${fc[ROLE.TIMING]} modules). This can break grid sampling on dense codes.`]);
    if (fc[ROLE.ALIGNMENT]) issues.push(['warn', `Alignment pattern changed (${fc[ROLE.ALIGNMENT]} modules). It helps scanners correct perspective.`]);
    if (fc[ROLE.SEPARATOR]) issues.push(['warn', `Separator around a finder changed (${fc[ROLE.SEPARATOR]} modules).`]);
    const coverHitsFunc = S.logo.inExport && logoImg && [ROLE.FINDER, ROLE.TIMING, ROLE.ALIGNMENT, ROLE.SEPARATOR, ROLE.FORMAT, ROLE.VERSION].some((k) => fc[k]);
    if (uncertainMask) {
      let n = 0;
      for (let i = 0; i < uncertainMask.length; i++) n += uncertainMask[i];
      if (n) issues.push(['info', `${n} module${n > 1 ? 's' : ''} under the drawn logo ${n > 1 ? 'are' : 'is'} mid-tone (neither clearly dark nor light), so ${n > 1 ? 'they are' : 'it is'} counted as damaged. High-contrast logos cost less.`]);
    }
    if (coverHitsFunc) issues.push(['warn', 'The logo image drawn on the final code covers required modules. Move or shrink it, or turn off "Draw logo image on final code".']);
    if (fc[ROLE.DARK]) issues.push(['info', 'The fixed dark module was changed. Most scanners ignore it.']);
    if (S.style.quiet < 2) issues.push(['warn', 'Quiet zone under 2 modules: many scanners need a clear border (4 is standard).']);
    if (S.style.shape !== 'square' && S.style.scale < 70) issues.push(['info', 'Small module shapes reduce contrast: test the exported image with real scanners.']);
    const fgL = lum(S.style.fg), bgL = lum(S.style.bg);
    if (bgL < fgL) issues.push(['warn', 'Light colour is darker than the dark colour (inverted code). Many scanners can\'t read inverted codes.']);
    else if ((bgL + 0.05) / (fgL + 0.05) < 3) issues.push(['warn', 'Low contrast between the dark and light colours.']);

    const badge = $('statusBadge');
    badge.className = 'badge ' + level;
    badge.textContent = { pass: '✓ SCANNABLE', risky: '⚠ RISKY', fail: '✗ WILL NOT SCAN' }[level];
    const pct = Math.round(r.worstRatio * 100);
    let txt;
    if (!r.targetCount) txt = 'Nothing painted yet. Paint on the grid or add a logo, and this panel tracks how much of the error-correction budget you use.';
    else if (level === 'fail' && r.over) txt = `Block ${r.worstBlock + 1} has ${r.worst} damaged codewords but can only repair ${B.capacity}. Remove some paint, enlarge the version, raise error correction, or try another mask.`;
    else if (level === 'fail') txt = 'A required pattern is too damaged to read.';
    else if (level === 'risky') txt = r.worstRatio > margin
      ? `Decodes in theory, but uses ${pct}% of the worst block's budget (your margin is ${S.margin}%). Blur, print defects and glare add errors on top.`
      : 'Within the error budget, but required patterns were modified (see below).';
    else txt = r.damaged ? `All blocks are within budget. The worst uses ${pct}%, inside your ${S.margin}% safety margin.` : 'Your drawing costs nothing: every painted module matches the code.';
    $('statusText').textContent = txt;

    const fill = $('meterFill');
    fill.style.width = Math.min(100, r.worstRatio * 100) + '%';
    fill.style.background = level === 'fail' ? 'var(--bad)' : r.worstRatio > margin ? 'var(--warn)' : 'var(--ok)';
    $('meterMargin').style.left = `calc(${S.margin}% - 1px)`;
    $('meterLabel').textContent = `Worst block (#${r.worstBlock + 1}): ${r.worst} / ${B.capacity} codewords: ${pct}% of budget`;

    const maskNote = S.maskMode === 'design' ? ' (best fit)' : S.maskMode === 'penalty' ? ' (standard)' : ' (manual)';
    const stats = [
      ['Version', `${ctx.ver}: ${ctx.size}×${ctx.size} modules`],
      ['Error correction', `${ctx.ecl} · ${B.numBlocks} block${B.numBlocks > 1 ? 's' : ''} × ${B.ecc} EC codewords`],
      ['Repairs per block', `${B.capacity} codewords` + (B.p ? ` (${B.p} reserved for detection)` : '')],
      ['Mask', r.mask + maskNote],
      ['Data', `${Math.ceil(ctx.usedBits / 8)} / ${B.numDataCW} codewords`],
      ['Spare codewords', `${ctx.spareCW}` + (S.useSpare ? (ctx.spareCW ? ' (matched to drawing)' : '') : ' (not used)')],
      ['Painted modules', r.targetCount],
      ['…costing budget', r.conflictCount + Array.from(r.funcChanged).reduce((a, b) => a + b, 0)],
      ['Damaged codewords', `${r.damaged} / ${L.rawCW}`],
    ];
    $('stats').innerHTML = stats.map(([a, b]) => `<dt>${a}</dt><dd>${b}</dd>`).join('');
    $('issues').innerHTML = issues.map(([c, t]) => `<div class="issue ${c}">${escapeHtml(t)}</div>`).join('');

    const bl = $('blocks');
    let html = '';
    for (let j = 0; j < B.numBlocks; j++) {
      const e = r.blockErr[j], ratio = e / B.capacity;
      const col = ratio > 1 ? 'var(--bad)' : ratio > margin ? 'var(--warn)' : 'var(--ok)';
      html += `<div class="blockbar${hoverBlock === j ? ' hl' : ''}" data-block="${j}" title="Block ${j + 1}: ${B.blocks[j].dataLen} data + ${B.ecc} EC codewords. Hover to highlight on the grid."><span>#${j + 1}</span><div class="bar"><div style="width:${Math.min(100, ratio * 100)}%;background:${col}"></div></div><span>${e}/${B.capacity}</span></div>`;
    }
    bl.innerHTML = html;
  }

  $('blocks').addEventListener('mouseover', (e) => {
    const el = e.target.closest('.blockbar');
    const j = el ? +el.dataset.block : -1;
    if (j !== hoverBlock) { hoverBlock = j; renderEditor(); }
  });
  $('blocks').addEventListener('mouseleave', () => { hoverBlock = -1; renderEditor(); });

  function renderMasks() {
    const el = $('masks');
    el.classList.toggle('stale', masksStale);
    if (!maskResults) { el.innerHTML = ''; return; }
    const margin = S.margin / 100;
    const penaltyM = S.maskMode === 'penalty' ? Q.penaltyMask(ctx) : -1;
    el.innerHTML = maskResults.map((r, k) => {
      const lv = levelFor(r, margin);
      const cls = lv === 'fail' ? 'bad' : lv === 'risky' ? 'warn' : 'ok';
      const pct = r.decodable ? Math.round(r.worstRatio * 100) + '%' : (r.over ? '+' + r.over + ' over' : 'fail');
      return `<button class="mask-tile${k === chosenMask ? ' chosen' : ''}" data-mask="${k}" title="Mask ${k}: ${r.damaged} damaged codewords, worst block ${r.worst}/${r.capacity}${k === penaltyM ? ' (standard choice)' : ''}"><b>${k}</b><span class="pct ${cls}">${pct}</span></button>`;
    }).join('');
  }
  $('masks').addEventListener('click', (e) => {
    const b = e.target.closest('[data-mask]');
    if (!b) return;
    S.maskMode = b.dataset.mask;
    $('maskMode').value = S.maskMode;
    schedule(true);
  });

  function renderContentInfo(minV) {
    const seg = ctx.seg;
    const modeName = { numeric: 'Numeric', alphanumeric: 'Alphanumeric', byte: 'Byte' }[seg.mode];
    let s = `${modeName} mode · ${seg.numChars} ${seg.mode === 'byte' ? 'bytes' : 'chars'} · smallest version at ${S.ecl}: ${minV}`;
    if (seg.mode === 'byte' && /^[a-z0-9:/.\-$%*+ ]*$/i.test(S.text) && /[a-z]/.test(S.text) && /^https?:\/\//i.test(S.text))
      s += '. Tip: an all-uppercase URL uses the denser alphanumeric mode, which frees up more spare capacity.';
    $('contentInfo').textContent = s;
    const sel = $('version');
    for (const opt of sel.options) if (+opt.value) opt.disabled = +opt.value < minV;
  }

  /* ---------- preview / export ---------- */

  function lum(hex) {
    const n = parseInt(hex.slice(1), 16);
    const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f((n >> 16) & 255) + 0.7152 * f((n >> 8) & 255) + 0.0722 * f(n & 255);
  }

  function finderIntact(eff, L) {
    for (let i = 0; i < L.N; i++) if (L.role[i] === ROLE.FINDER && eff[i] !== L.fixed[i]) return false;
    return true;
  }

  function finderOrigins(size) { return [[0, 0], [size - 7, 0], [0, size - 7]]; }

  function roundRectPath(g, x, y, w, h, r) {
    if (g.roundRect) { g.roundRect(x, y, w, h, r); return; }
    g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
  }

  function drawSymbol(g, eff, L, px, withLogo) {
    const st = S.style, size = L.size, q = st.quiet, dim = (size + 2 * q) * px;
    g.fillStyle = st.bg;
    g.fillRect(0, 0, dim, dim);
    const custom = st.finder !== 'square' && finderIntact(eff, L);
    const s = st.scale / 100, w = px * s, off = (px - w) / 2;
    g.fillStyle = st.fg;
    g.beginPath();
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const i = y * size + x;
      if (!eff[i] || (custom && L.role[i] === ROLE.FINDER)) continue;
      const X = (x + q) * px, Y = (y + q) * px;
      if (st.shape === 'dots') { g.moveTo(X + px / 2 + w / 2, Y + px / 2); g.arc(X + px / 2, Y + px / 2, w / 2, 0, Math.PI * 2); }
      else if (st.shape === 'rounded') roundRectPath(g, X + off, Y + off, w, w, w * 0.32);
      else g.rect(X + off, Y + off, w, w);
    }
    g.fill();
    if (custom) {
      for (const [fx, fy] of finderOrigins(size)) {
        const X = (fx + q) * px, Y = (fy + q) * px;
        if (st.finder === 'circle') {
          g.fillStyle = st.fg; g.beginPath(); g.arc(X + 3.5 * px, Y + 3.5 * px, 3.5 * px, 0, Math.PI * 2); g.fill();
          g.fillStyle = st.bg; g.beginPath(); g.arc(X + 3.5 * px, Y + 3.5 * px, 2.5 * px, 0, Math.PI * 2); g.fill();
          g.fillStyle = st.fg; g.beginPath(); g.arc(X + 3.5 * px, Y + 3.5 * px, 1.5 * px, 0, Math.PI * 2); g.fill();
        } else {
          g.fillStyle = st.fg; g.beginPath(); roundRectPath(g, X, Y, 7 * px, 7 * px, 2.2 * px); g.fill();
          g.fillStyle = st.bg; g.beginPath(); roundRectPath(g, X + px, Y + px, 5 * px, 5 * px, 1.5 * px); g.fill();
          g.fillStyle = st.fg; g.beginPath(); roundRectPath(g, X + 2 * px, Y + 2 * px, 3 * px, 3 * px, 1 * px); g.fill();
        }
      }
    }
    if (withLogo && logoImg && S.logo.inExport) {
      const r = logoRect(size);
      g.imageSmoothingQuality = 'high';
      g.drawImage(logoImg, (r.x + q) * px, (r.y + q) * px, r.w * px, r.h * px);
    }
    return dim;
  }

  function renderPreview() {
    const c = $('preview'), L = ctx.layout;
    const px = Math.max(2, Math.floor(560 / (L.size + 2 * S.style.quiet)));
    const dim = (L.size + 2 * S.style.quiet) * px;
    c.width = c.height = dim;
    drawSymbol(c.getContext('2d'), result.effective, L, px, true);
  }

  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  function fileBase() { return 'qr-doodle-v' + ctx.ver + ctx.ecl; }

  function exportPng() {
    const L = ctx.layout, target = S.style.exportPx, n = L.size + 2 * S.style.quiet;
    const px = Math.max(1, Math.round(target / n));
    const c = document.createElement('canvas');
    c.width = c.height = n * px;
    drawSymbol(c.getContext('2d'), result.effective, L, px, true);
    c.toBlob((b) => download(b, fileBase() + '.png'), 'image/png');
  }

  function exportSvg() {
    const L = ctx.layout, st = S.style, size = L.size, q = st.quiet, n = size + 2 * q, eff = result.effective;
    const custom = st.finder !== 'square' && finderIntact(eff, L);
    const s = st.scale / 100, w = s, off = (1 - w) / 2, f = (v) => +v.toFixed(3);
    let d = '';
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const i = y * size + x;
      if (!eff[i] || (custom && L.role[i] === ROLE.FINDER)) continue;
      const X = x + q, Y = y + q;
      if (st.shape === 'dots') { const r = w / 2; d += `M${f(X + 0.5 - r)} ${f(Y + 0.5)}a${f(r)} ${f(r)} 0 1 0 ${f(2 * r)} 0a${f(r)} ${f(r)} 0 1 0 ${f(-2 * r)} 0z`; }
      else if (st.shape === 'rounded') d += rrPath(X + off, Y + off, w, w, w * 0.32, f);
      else d += s === 1 ? `M${X} ${Y}h1v1h-1z` : `M${f(X + off)} ${f(Y + off)}h${f(w)}v${f(w)}h${f(-w)}z`;
    }
    const parts = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="${n * 10}" height="${n * 10}"${st.shape === 'square' && s === 1 ? ' shape-rendering="crispEdges"' : ''}>`,
      `<rect width="${n}" height="${n}" fill="${st.bg}"/>`, `<path fill="${st.fg}" d="${d}"/>`];
    if (custom) for (const [fx, fy] of finderOrigins(size)) {
      const X = fx + q, Y = fy + q;
      if (st.finder === 'circle') {
        parts.push(`<circle cx="${X + 3.5}" cy="${Y + 3.5}" r="3.5" fill="${st.fg}"/><circle cx="${X + 3.5}" cy="${Y + 3.5}" r="2.5" fill="${st.bg}"/><circle cx="${X + 3.5}" cy="${Y + 3.5}" r="1.5" fill="${st.fg}"/>`);
      } else {
        parts.push(`<rect x="${X}" y="${Y}" width="7" height="7" rx="2.2" fill="${st.fg}"/><rect x="${X + 1}" y="${Y + 1}" width="5" height="5" rx="1.5" fill="${st.bg}"/><rect x="${X + 2}" y="${Y + 2}" width="3" height="3" rx="1" fill="${st.fg}"/>`);
      }
    }
    if (logoImg && S.logo.inExport) {
      const r = logoRect(size);
      parts.push(`<image href="${S.logo.src}" x="${f(r.x + q)}" y="${f(r.y + q)}" width="${f(r.w)}" height="${f(r.h)}" preserveAspectRatio="none"/>`);
    }
    parts.push('</svg>');
    download(new Blob([parts.join('\n')], { type: 'image/svg+xml' }), fileBase() + '.svg');
  }
  function rrPath(x, y, w, h, r, f) {
    return `M${f(x + r)} ${f(y)}h${f(w - 2 * r)}a${f(r)} ${f(r)} 0 0 1 ${f(r)} ${f(r)}v${f(h - 2 * r)}a${f(r)} ${f(r)} 0 0 1 ${f(-r)} ${f(r)}h${f(-(w - 2 * r))}a${f(r)} ${f(r)} 0 0 1 ${f(-r)} ${f(-r)}v${f(-(h - 2 * r))}a${f(r)} ${f(r)} 0 0 1 ${f(r)} ${f(-r)}z`;
  }

  /* ---------- real decoder test ---------- */

  let jsqrPromise = null;
  function loadJsQR() {
    if (window.jsQR) return Promise.resolve(window.jsQR);
    if (!jsqrPromise) jsqrPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'vendor/jsQR.js';
      s.onload = () => resolve(window.jsQR);
      s.onerror = () => { jsqrPromise = null; reject(new Error('could not load vendor/jsQR.js')); };
      document.head.appendChild(s);
    });
    return jsqrPromise;
  }

  let scanSeq = 0, scanTimer = 0;
  function scheduleAutoScan() {
    clearTimeout(scanTimer);
    if (S.autoScan) scanTimer = setTimeout(() => runScan(4), 350);
  }
  async function runScan(px) {
    const seq = ++scanSeq;
    const L = ctx.layout, expected = S.text;
    const c = document.createElement('canvas');
    const n = L.size + 2 * Math.max(S.style.quiet, 0);
    c.width = c.height = n * px;
    const g = c.getContext('2d', { willReadFrequently: true });
    drawSymbol(g, result.effective, L, px, true);
    const out = [];
    try {
      const jsQR = await loadJsQR();
      const img = g.getImageData(0, 0, c.width, c.height);
      const res = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
      out.push(['jsQR', res ? res.data : null]);
    } catch (e) { out.push(['jsQR', undefined, e.message]); }
    if ('BarcodeDetector' in window) {
      try {
        const formats = await window.BarcodeDetector.getSupportedFormats();
        if (formats.includes('qr_code')) {
          const det = new window.BarcodeDetector({ formats: ['qr_code'] });
          const codes = await det.detect(c);
          out.push(['Browser (BarcodeDetector)', codes.length ? codes[0].rawValue : null]);
        }
      } catch (e) { /* not available on this platform */ }
    }
    if (seq !== scanSeq) return;
    $('scanResult').innerHTML = out.map(([name, val, err]) => {
      if (val === undefined) return `<div class="muted">${name}: unavailable (${escapeHtml(err || '')})</div>`;
      if (val === null) return `<div class="bad">✗ ${name}: could not decode</div>`;
      if (val === expected) return `<div class="good">✓ ${name}: decoded correctly</div>`;
      return `<div class="bad">✗ ${name}: decoded different text: “${escapeHtml(val.slice(0, 80))}”</div>`;
    }).join('') + `<div class="muted">Tested a ${c.width}px render of the preview.</div>`;
  }

  /* ---------- density comparison ---------- */

  let scanJob = 0;
  async function compareDensities() {
    const job = ++scanJob;
    const out = $('scanOut');
    const err = validateText();
    if (err) { out.innerHTML = `<p class="hint">${escapeHtml(err)}</p>`; return; }
    const seg = Q.makeSegment(S.text, S.mode);
    const start = Q.minVersion(seg, 'L');
    if (!start) { out.innerHTML = '<p class="hint">Content too long.</p>'; return; }
    const curVer = ctx ? ctx.ver : 0;
    const versions = [];
    for (let v = start; v <= Math.min(40, start + 9); v++) versions.push(v);
    if (curVer > versions[versions.length - 1]) versions.push(curVer);
    const ecls = Q.ECL_LIST, margin = S.margin / 100;
    const cells = {};
    const draw = (progress) => {
      let h = '<table class="scan-table"><tr><th>Version</th>' + ecls.map((e) => `<th>${e}</th>`).join('') + '</tr>';
      for (const v of versions) {
        h += `<tr><th>${v} <span class="hint">${v * 4 + 17}²</span></th>`;
        for (const e of ecls) {
          const c = cells[v + e];
          if (c === undefined) h += '<td class="na">…</td>';
          else if (c === null) h += '<td class="na">n/a</td>';
          else {
            const bg = c.level === 'fail' ? 'rgba(239,68,68,.28)' : c.level === 'risky' ? 'rgba(245,158,11,.28)' : 'rgba(34,197,94,.28)';
            const label = c.decodable ? Math.round(c.ratio * 100) + '%' : '✗';
            const cur = ctx && ctx.ver === v && ctx.ecl === e ? ' cur' : '';
            h += `<td><button class="${cur}" style="background:${bg}" data-v="${v}" data-e="${e}" title="v${v}-${e}: worst block ${c.worst}/${c.cap}, best mask ${c.mask}">${label}</button></td>`;
          }
        }
        h += '</tr>';
      }
      h += '</table>';
      if (progress < 1) h += `<p class="hint">Working… ${Math.round(progress * 100)}%</p>`;
      else h += '<p class="hint">Cell = worst block\'s share of its error budget, using the best mask. Click a cell to switch.</p>';
      out.innerHTML = h;
    };
    const total = versions.length * ecls.length;
    let done = 0;
    for (const v of versions) for (const e of ecls) {
      if (job !== scanJob) return;
      const c2 = Q.fits(seg, v, e) ? Q.createContext(S.text, v, e, S.mode) : null;
      if (!c2) cells[v + e] = null;
      else {
        const t = buildTargets(c2), unc = uncertainMask;
        let best = null, bestScore = Infinity;
        for (let m = 0; m < 8; m++) {
          const r = Q.evaluate(c2, m, t, { useSpare: S.useSpare, uncertain: unc });
          const sc = Q.designScore(r);
          if (sc < bestScore) { bestScore = sc; best = r; }
        }
        cells[v + e] = { ratio: best.worstRatio, decodable: best.decodable, worst: best.worst, cap: best.capacity, mask: best.mask, level: levelFor(best, margin) };
      }
      done++;
      if (ctx) buildTargets(ctx); // restore uncertainMask for the current symbol
      draw(done / total);
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  $('scanOut').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]');
    if (!b) return;
    S.version = +b.dataset.v; S.ecl = b.dataset.e;
    syncControls();
    schedule(true);
    $('scanOut').querySelectorAll('button.cur').forEach((x) => x.classList.remove('cur'));
    b.classList.add('cur');
  });

  /* ---------- persistence ---------- */

  function serialize() {
    const o = [];
    for (const [k, v] of ov) o.push(ovDx(k), ovDy(k), v);
    return { app: 'qr-doodle', format: 1, appVersion: APP_VERSION, settings: S, overrides: o };
  }
  function applySerialized(data) {
    if (!data || data.app !== 'qr-doodle') throw new Error('Not a QR Doodle design file.');
    S = deepMerge(DEFAULTS, data.settings || {});
    ov = new Map();
    const o = data.overrides || [];
    for (let n = 0; n + 2 < o.length; n += 3) ov.set(ovKey(o[n], o[n + 1]), o[n + 2]);
    chosenMask = 0; ctxKey = '';
  }
  let saveTimer = 0;
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(serialize())); }
      catch (e) {
        try { const d = serialize(); d.settings = clone(S); d.settings.logo.src = null; localStorage.setItem(STORAGE_KEY, JSON.stringify(d)); } catch (e2) { /* ignore */ }
      }
    }, 400);
  }

  /* ---------- controls ---------- */

  function getPath(path) { return path.split('.').reduce((o, k) => o[k], S); }
  function setPath(path, v) { const ks = path.split('.'), last = ks.pop(); ks.reduce((o, k) => o[k], S)[last] = v; }

  const fmt = {
    margin: (v) => v + '%', 'logo.size': (v) => Math.round(v) + '%', 'logo.x': (v) => Math.round(v) + '%', 'logo.y': (v) => Math.round(v) + '%',
    'logo.threshold': (v) => v, 'logo.pad': (v) => v, 'logo.opacity': (v) => v + '%', brush: (v) => v,
    'style.scale': (v) => v + '%', 'style.quiet': (v) => v,
  };
  const bindings = [];
  function bind(id, path, o = {}) {
    const el = $(id);
    const isCheck = el.type === 'checkbox', isRange = el.type === 'range';
    const out = $(id + 'Out');
    const read = () => isCheck ? el.checked : (isRange || o.num) ? Number(el.value) : el.value;
    const write = () => {
      const v = getPath(path);
      if (isCheck) el.checked = !!v; else el.value = v;
      if (out) out.textContent = fmt[path] ? fmt[path](v) : v;
    };
    bindings.push(write);
    const handler = (full) => () => {
      setPath(path, read());
      if (out) out.textContent = fmt[path] ? fmt[path](getPath(path)) : getPath(path);
      if (o.after) o.after();
      if (o.render) { o.render(); if (full) scheduleSave(); }
      else schedule(full);
    };
    if (isRange) { el.addEventListener('input', handler(false)); el.addEventListener('change', handler(true)); }
    else if (el.tagName === 'TEXTAREA') el.addEventListener('input', handler(true));
    else el.addEventListener('change', handler(true));
  }
  function syncControls() {
    bindings.forEach((w) => w());
    document.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === S.tool));
    document.querySelectorAll('[data-paint]').forEach((b) => b.classList.toggle('active', +b.dataset.paint === S.paint));
    document.querySelectorAll('[data-view]').forEach((c) => { c.checked = !!S.view[c.dataset.view]; });
    document.querySelector('.viewbar').classList.toggle('focus', !!S.view.focus);
    $('logoControls').hidden = !logoImg;
    $('logoEmpty').hidden = !!logoImg;
    $('logoRemove').hidden = !logoImg;
    document.querySelectorAll('.trace-only').forEach((el) => { el.hidden = S.logo.mode !== 'trace'; });
    document.querySelectorAll('.knockout-only').forEach((el) => { el.hidden = S.logo.mode !== 'knockout'; });
    if (ctx) updateEditUI();
  }
  function syncLogoSliders() {
    for (const k of ['Size', 'X', 'Y']) {
      const v = S.logo[k.toLowerCase()];
      $('logo' + k).value = v;
      $('logo' + k + 'Out').textContent = Math.round(v) + '%';
    }
  }

  function initControls() {
    const vs = $('version');
    vs.innerHTML = '<option value="0">Auto (smallest)</option>' +
      Array.from({ length: 40 }, (_, n) => `<option value="${n + 1}">${n + 1} (${(n + 1) * 4 + 17}×${(n + 1) * 4 + 17})</option>`).join('');

    bind('text', 'text');
    bind('mode', 'mode');
    bind('ecl', 'ecl');
    bind('version', 'version', { num: true });
    bind('maskMode', 'maskMode');
    bind('useSpare', 'useSpare');
    bind('lockFunc', 'lockFunc');
    bind('margin', 'margin');
    bind('logoMode', 'logo.mode', { after: syncControls });
    bind('logoSize', 'logo.size');
    bind('logoX', 'logo.x');
    bind('logoY', 'logo.y');
    bind('logoThreshold', 'logo.threshold');
    bind('logoInvert', 'logo.invert');
    bind('logoTraceLight', 'logo.traceLight');
    bind('logoShape', 'logo.shape');
    bind('logoPad', 'logo.pad');
    bind('logoFill', 'logo.fill', { num: true });
    bind('logoOpacity', 'logo.opacity', { render: renderEditor });
    bind('logoInExport', 'logo.inExport');
    bind('brush', 'brush', { render: () => {} });
    bind('brushShape', 'brushShape', { render: () => {} });
    bind('symmetry', 'symmetry', { render: () => {} });
    bind('styleShape', 'style.shape');
    bind('styleScale', 'style.scale');
    bind('styleFinder', 'style.finder');
    bind('styleFg', 'style.fg');
    bind('styleBg', 'style.bg');
    bind('styleQuiet', 'style.quiet');
    bind('exportPx', 'style.exportPx', { num: true, render: () => {} });
    bind('autoScan', 'autoScan', { after: () => S.autoScan && scheduleAutoScan(), render: () => {} });
    // colour pickers fire 'input' continuously
    for (const id of ['styleFg', 'styleBg']) $(id).addEventListener('input', (e) => { setPath(id === 'styleFg' ? 'style.fg' : 'style.bg', e.target.value); renderPreview(); });

    document.querySelectorAll('[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
    document.querySelectorAll('[data-paint]').forEach((b) => b.addEventListener('click', () => setPaint(+b.dataset.paint)));
    document.querySelectorAll('[data-view]').forEach((c) => c.addEventListener('change', () => { S.view[c.dataset.view] = c.checked; syncControls(); renderEditor(); scheduleSave(); }));
    bind('focusData', 'view.focusData', { render: renderEditor });

    $('zoomIn').addEventListener('click', () => { S.zoom = Math.min(60, (S.zoom || cell) + Math.max(1, Math.round(cell * 0.2))); renderEditor(); });
    $('zoomOut').addEventListener('click', () => { S.zoom = Math.max(2, (S.zoom || cell) - Math.max(1, Math.round(cell * 0.2))); renderEditor(); });
    $('zoomFit').addEventListener('click', () => { S.zoom = 0; renderEditor(); });

    $('undoBtn').addEventListener('click', undo);
    $('copyBtn').addEventListener('click', copySelection);
    $('cutBtn').addEventListener('click', cutSelection);
    $('pasteBtn').addEventListener('click', startPaste);
    $('deleteSelBtn').addEventListener('click', deleteSelection);
    $('redoBtn').addEventListener('click', redo);
    $('clearBtn').addEventListener('click', () => { if (!ov.size) return; pushUndo(); ov.clear(); schedule(true); });
    $('helpBtn').addEventListener('click', () => $('help').showModal());
    $('saveBtn').addEventListener('click', () => download(new Blob([JSON.stringify(serialize())], { type: 'application/json' }), 'qr-doodle-design.json'));
    $('loadInput').addEventListener('change', (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (!f) return;
      f.text().then((txt) => {
        try {
          applySerialized(JSON.parse(txt));
          undoStack.length = redoStack.length = 0;
          loadLogoSrc(S.logo.src, () => { syncControls(); schedule(true); });
        } catch (err) { alert('Could not load design: ' + err.message); }
      });
    });
    $('logoInput').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) importLogoFile(f); });
    $('logoRemove').addEventListener('click', () => { S.logo.src = null; loadLogoSrc(null, () => { if (S.tool === 'logo') S.tool = 'brush'; syncControls(); schedule(true); }); });
    $('testScan').addEventListener('click', () => { $('scanResult').innerHTML = '<span class="muted">Testing…</span>'; runScan(6); });
    $('exportPng').addEventListener('click', exportPng);
    $('exportSvg').addEventListener('click', exportSvg);
    $('scanBtn').addEventListener('click', compareDensities);

    // drop an image anywhere on the editor to use it as a logo
    wrap.addEventListener('dragover', (e) => { e.preventDefault(); });
    wrap.addEventListener('drop', (e) => {
      e.preventDefault();
      const f = [...(e.dataTransfer.files || [])].find((x) => x.type.startsWith('image/'));
      if (f) importLogoFile(f);
    });

    window.addEventListener('keydown', (e) => {
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || $('help').open) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
      if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
      if (mod) {
        const mk = e.key.toLowerCase();
        if (mk === 'c' && selRect()) copySelection();
        else if (mk === 'x' && selRect()) cutSelection();
        else if (mk === 'v' && clip) startPaste();
        else if (mk === 'a') selectAll();
        else return;
        e.preventDefault();
        return;
      }
      const k = e.key.toLowerCase();
      if (pasting && (k === 'r' || k === 'h' || k === 'v')) {
        pasting.clip = transformClip(pasting.clip, k === 'r' ? 'rot' : k);
        renderEditor(); e.preventDefault(); return;
      }
      if (k === 'escape') {
        if (pasting) endPaste();
        else if (selRect()) { sel = null; renderEditor(); }
        else return;
      }
      else if ((k === 'delete' || k === 'backspace') && selRect()) deleteSelection();
      else if (k === 's') setTool('select');
      else if (k === 'b') setTool('brush');
      else if (k === 'r') setTool('rect');
      else if (k === 'o') setTool('ellipse');
      else if (k === 'm') setTool('logo');
      else if (k === 'f') { S.view.focus = !S.view.focus; syncControls(); renderEditor(); scheduleSave(); }
      else if (k === 'd') setPaint(1);
      else if (k === 'l') setPaint(0);
      else if (k === 'e') setPaint(-1);
      else if (k === '[' || k === ']') { S.brush = clamp(S.brush + (k === ']' ? 1 : -1), 1, 9); syncControls(); renderEditor(); }
      else return;
      e.preventDefault();
    });
    let resizeT = 0;
    window.addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(() => { if (!S.zoom) renderEditor(); }, 60); });
  }
  function setTool(t) { S.tool = t; pasting = null; syncControls(); renderEditor(); scheduleSave(); }
  function setPaint(p) { S.paint = p; if (S.tool === 'logo') S.tool = 'brush'; syncControls(); renderEditor(); scheduleSave(); }

  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  // read-only hook for debugging / automated checks
  window.QRDoodle = { get ctx() { return ctx; }, get result() { return result; }, get settings() { return S; }, get uncertain() { return uncertainMask; } };

  /* ---------- boot ---------- */

  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) applySerialized(JSON.parse(saved));
  } catch (e) { S = clone(DEFAULTS); ov = new Map(); }
  initControls();
  loadLogoSrc(S.logo.src, () => { syncControls(); recompute(true); });
})();
