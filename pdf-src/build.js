// Builds ENFRA_CRM_Decision_Guide.pdf from guide.html, pulling all copy verbatim from index.html / team.html.
// Usage (from the project root, with a static server on :8934):  node pdf-src/build.js
const path = require('path');
const puppeteer = require('/opt/homebrew/lib/node_modules/puppeteer-core');

const BASE = 'http://127.0.0.1:8934/';
const OUT = path.join(__dirname, '..', 'ENFRA_CRM_Decision_Guide.pdf');
const STRIP = '.vc-plus,.src-pop,.halo,.chev,.hit,.beckon,.hover-hint,.q-glare,.q-num,.c-wm,.g-num,.g-hint,.fc-flip,.q-flip,.q-check,.q-chips,.tick,.mail,.org,.mdrawer';

function extract(sels, strip) {
  const PROPS = ['fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'stroke-dashoffset', 'opacity', 'fill-opacity',
    'stroke-opacity', 'font-size', 'font-weight', 'font-family', 'text-anchor', 'dominant-baseline', 'stroke-linecap', 'stroke-linejoin', 'letter-spacing'];
  const out = {};
  for (const s of sels) {
    if (s === 'title') { out[s] = { html: document.title, text: document.title, srcs: [] }; continue; }
    const el = document.querySelector(s);
    if (!el) { out[s] = null; continue; }
    el.querySelectorAll('svg *').forEach(n => {
      const cs = getComputedStyle(n);
      for (const p of PROPS) n.style.setProperty(p, cs.getPropertyValue(p));
    });
    const c = el.cloneNode(true);
    c.querySelectorAll(strip).forEach(n => n.remove());
    c.querySelectorAll('img').forEach(n => { n.setAttribute('src', new URL(n.getAttribute('src'), location.href).href); });
    c.querySelectorAll('[id]').forEach(n => { if (!/^s\d+$/.test(n.id) && !n.closest('svg')) n.removeAttribute('id'); });
    c.querySelectorAll('[hidden]').forEach(n => n.remove());
    const srcs = [...c.querySelectorAll('.src')].map(n => n.outerHTML);
    const t = c.cloneNode(true);
    t.querySelectorAll('.src').forEach(n => n.remove());
    out[s] = { html: c.innerHTML, text: t.textContent.replace(/\s+/g, ' ').trim(), srcs };
  }
  return out;
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new', args: ['--no-sandbox', '--disable-gpu'], userDataDir: '/tmp/enfra_pdf_' + Date.now(),
  });
  try {
    const guide = await browser.newPage();
    await guide.goto(BASE + 'pdf-src/guide.html', { waitUntil: 'domcontentloaded' });
    const want = await guide.evaluate(() => {
      const w = { index: new Set(), team: new Set() };
      document.querySelectorAll('[data-from]').forEach(e => w[e.dataset.page || 'index'].add(e.dataset.from));
      document.querySelectorAll('[data-excerpt]').forEach(e => w.index.add(e.dataset.excerpt));
      document.querySelectorAll('[data-chip]').forEach(e => w.index.add(e.dataset.chip));
      return { index: [...w.index], team: [...w.team] };
    });

    const data = {};
    for (const [name, file] of [['index', 'index.html'], ['team', 'team.html']]) {
      const p = await browser.newPage();
      await p.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
      await p.setViewport({ width: 1280, height: 900 });
      await p.goto(BASE + file, { waitUntil: 'load' });
      if (name === 'index') await p.waitForFunction(() => document.querySelectorAll('#timeline *').length > 10, { timeout: 4000 });
      data[name] = await p.evaluate(extract, want[name], STRIP);
      await p.close();
    }
    const missing = Object.entries(data).flatMap(([n, m]) => Object.entries(m).filter(([, v]) => !v).map(([k]) => n + ': ' + k));
    if (missing.length) throw new Error('Selectors not found:\n  ' + missing.join('\n  '));

    const problems = await guide.evaluate((data) => {
      const errs = [];
      document.querySelectorAll('[data-from]').forEach(e => {
        const v = data[e.dataset.page || 'index'][e.dataset.from];
        if (e.dataset.from === 'title') e.textContent = v.text; else e.innerHTML = v.html;
      });
      document.querySelectorAll('[data-excerpt]').forEach(e => {
        const v = data.index[e.dataset.excerpt], want = e.dataset.text;
        if (!v.text.includes(want)) { errs.push('Excerpt not verbatim: "' + want + '" in ' + e.dataset.excerpt); return; }
        e.innerHTML = '<span class="q"></span>' + v.srcs.join('');
        e.firstChild.textContent = want;
      });
      document.querySelectorAll('[data-chip]').forEach(e => {
        const v = data.index[e.dataset.chip], want = e.dataset.text;
        if (!v.text.includes(want)) { errs.push('Chip not verbatim: "' + want + '" in ' + e.dataset.chip); return; }
        e.textContent = want;
      });
      document.querySelectorAll('[data-mark]').forEach(e => {
        for (const spec of e.dataset.mark.split('|')) {
          const cls = spec.slice(0, 1), frag = spec.slice(2);
          const w = document.createTreeWalker(e, NodeFilter.SHOW_TEXT);
          let n, done = false;
          while ((n = w.nextNode())) {
            const i = n.data.indexOf(frag);
            if (i < 0) continue;
            const r = n.splitText(i); r.splitText(frag.length);
            const m = document.createElement('mark'); m.className = cls;
            r.replaceWith(m); m.appendChild(r); done = true; break;
          }
          if (!done) errs.push('Highlight not verbatim: "' + frag + '" in ' + e.dataset.from);
        }
      });
      return errs;
    }, data);
    if (problems.length) throw new Error(problems.join('\n'));

    await guide.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all([...document.images].map(i => i.complete ? 0 : new Promise(r => { i.onload = i.onerror = r; })));
    });
    await guide.emulateMediaType('print');
    const fit = await guide.evaluate(() => [...document.querySelectorAll('.page')].map((pg, i) => {
      const pb = pg.querySelector('.pb');
      const limit = Math.min(pg.querySelector('.pf').getBoundingClientRect().top, pg.getBoundingClientRect().bottom - 28);
      const bottom = Math.max(...[...pb.children].map(c => c.getBoundingClientRect().bottom));
      const pad = parseFloat(getComputedStyle(pb).paddingBottom);
      return { page: i + 1, spare: Math.round(limit - pad - bottom) };
    }));
    console.log('Spare space per page (px, negative = overflow):', JSON.stringify(fit));
    await guide.pdf({ path: OUT, preferCSSPageSize: true, printBackground: true });
    console.log('Wrote', OUT);
    if (fit.some(f => f.spare < 0)) process.exitCode = 2;
  } finally {
    await browser.close();
  }
})().catch(e => { console.error(e.message || e); process.exit(1); });
