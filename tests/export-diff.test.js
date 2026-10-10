const puppeteer = require('puppeteer-core');
(async () => {
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new' });
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 950 });
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await page.goto(process.env.APP_URL || 'http://localhost:8765/', { waitUntil: 'networkidle0' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle0' });
  await page.select('#version', '8');
  await (await page.$('#logoInput')).uploadFile(__dirname + '/logo.svg');
  await new Promise(r => setTimeout(r, 1000));
  const setRange = (id, v) => page.evaluate((id, v) => { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event('input')); e.dispatchEvent(new Event('change')); }, id, v);
  const setCheck = (id, v) => page.evaluate((id, v) => { const e = document.getElementById(id); if (e.checked !== v) e.click(); }, id, v);
  const check = async (label) => {
    await new Promise(r => setTimeout(r, 1200));
    const out = await page.evaluate(() => {
      const { ctx, result, settings } = window.QRDoodle;
      const c = document.getElementById('preview'), g = c.getContext('2d');
      const size = ctx.size, q = settings.style.quiet, px = c.width / (size + 2 * q);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let diff = 0;
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const X = Math.floor((x + q + 0.5) * px), Y = Math.floor((y + q + 0.5) * px), p = (Y * c.width + X) * 4;
        const lum = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
        const U = window.QRDoodle.uncertain; if (U && U[y * size + x]) continue; if ((lum < 128 ? 1 : 0) !== result.effective[y * size + x]) { diff++; (window.__d = window.__d || []).push([x, y, Math.round(lum), result.effective[y*size+x], result.natural[y*size+x]]); }
      }
      const dl = window.__d; window.__d = []; return { dl, diff, badge: document.getElementById('statusBadge').textContent, meter: document.getElementById('meterLabel').textContent,
        issues: document.getElementById('issues').innerText.replace(/\n/g, ' || '), scan: document.getElementById('scanResult').innerText.split('\n').slice(0, 2).join(' / ') };
    });
    console.log(label, JSON.stringify(out));
    return out;
  };
  await page.select('#logoMode', 'knockout'); await setCheck('logoInExport', true);
  await check('knockout 30% inExport');
  await setRange('logoSize', 45);
  await check('knockout 45% inExport (covers alignment)');
  await setRange('logoSize', 30);
  await page.select('#logoMode', 'trace');
  await check('trace inExport');
  await setCheck('logoInExport', false);
  await check('trace no export');
  await page.select('#ecl', 'M'); await page.select('#version', '15'); await setCheck('logoInExport', true); await page.select('#logoMode', 'knockout'); await setRange('logoSize', 25);
  await check('v15-M knockout 25% inExport');
  console.log('errors', errs);
  await browser.close();
})();
