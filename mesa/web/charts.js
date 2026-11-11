/* Gráficos SVG de la Mesa: velas del día, abanico de la simulación e histograma del cierre.
   Un solo eje por gráfico, niveles etiquetados a la derecha y lectura al pasar el cursor. */
(function () {
  const W = 780, PAD_L = 58, PAD_R = 128, PAD_T = 10, PAD_B = 22;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const money = (x) => x.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' $';
  const KIND = {
    stop: { color: 'var(--neg)', dash: '5 4' }, target: { color: 'var(--pos)', dash: '5 4' },
    entry: { color: 'var(--series-1)', dash: '' }, range: { color: 'var(--ink-3)', dash: '2 3' },
  };

  function scale(lo, hi, h) {
    const pad = (hi - lo || 1) * 0.06;
    lo -= pad; hi += pad;
    return (v) => PAD_T + (hi - v) / (hi - lo) * (h - PAD_T - PAD_B);
  }

  function ticks(lo, hi, n) {
    const raw = (hi - lo) / n, mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || raw;
    const out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) out.push(v);
    return out;
  }

  function levelMarks(levels, y, x0, x1) {
    // etiquetas a la derecha, separadas al menos 14 px entre sí
    const items = levels.filter((l) => typeof l.price === 'number').map((l) => ({ ...l, y: y(l.price) }))
      .sort((a, b) => a.y - b.y);
    let prev = -Infinity;
    for (const it of items) { it.ly = Math.max(it.y, prev + 14); prev = it.ly; }
    return items.map((it) => {
      const k = KIND[it.kind] || KIND.range;
      return `<line x1="${x0}" x2="${x1}" y1="${it.y}" y2="${it.y}" stroke="${k.color}" stroke-width="1.5" stroke-dasharray="${k.dash}"/>` +
        `<line x1="${x1}" x2="${x1 + 8}" y1="${it.y}" y2="${it.ly}" stroke="${k.color}" stroke-width="1"/>` +
        `<text class="lbl" x="${x1 + 11}" y="${it.ly + 4}">${esc(it.label)} ${esc(money(it.price))}</text>`;
    }).join('');
  }

  function hover(root, n, x, onIndex) {
    const svg = root.querySelector('svg'), line = root.querySelector('.cross'), out = root.querySelector('.readout');
    const rest = out.innerHTML;
    const move = (ev) => {
      const r = svg.getBoundingClientRect();
      const px = (ev.clientX - r.left) / r.width * W;
      let i = Math.round((px - x(0)) / ((x(n - 1) - x(0)) / Math.max(1, n - 1)));
      i = Math.max(0, Math.min(n - 1, i));
      line.setAttribute('x1', x(i)); line.setAttribute('x2', x(i)); line.setAttribute('visibility', 'visible');
      out.textContent = onIndex(i);
    };
    svg.addEventListener('pointermove', move);
    svg.addEventListener('pointerdown', move);
    svg.addEventListener('pointerleave', () => { line.setAttribute('visibility', 'hidden'); out.innerHTML = rest; });
  }

  function candles(root, bars, opts) {
    opts = opts || {};
    const levels = opts.levels || [];
    if (!bars.length) { root.innerHTML = '<p class="muted">Todavía no hay velas cerradas de esta sesión.</p>'; return; }
    const H = 300, slots = 78;
    const vals = bars.flatMap((b) => [b.h, b.l]).concat(levels.map((l) => l.price).filter((v) => typeof v === 'number'));
    const lo = Math.min(...vals), hi = Math.max(...vals), y = scale(lo, hi, H);
    const plotW = W - PAD_L - PAD_R, step = plotW / slots, x = (i) => PAD_L + step * (i + 0.5);
    const idx = (b) => { const [h, m] = b.time.split(':').map(Number); return Math.round(((h * 60 + m) - 570) / 5); };
    let g = '';
    for (const v of ticks(lo, hi, 4)) g += `<line class="grid" x1="${PAD_L}" x2="${W - PAD_R}" y1="${y(v)}" y2="${y(v)}"/><text x="${PAD_L - 6}" y="${y(v) + 4}" text-anchor="end">${esc(money(v))}</text>`;
    for (let h = 10; h <= 16; h++) { const i = (h * 60 - 570) / 5; g += `<text x="${PAD_L + step * i}" y="${H - 6}" text-anchor="middle">${h}:00</text>`; }
    if (opts.rangeBars) g += `<rect x="${PAD_L}" y="${PAD_T}" width="${step * opts.rangeBars}" height="${H - PAD_T - PAD_B}" fill="var(--ink-3)" opacity="0.08"/>`;
    let c = '';
    const bw = Math.max(2, step - 3);
    for (const b of bars) {
      const i = idx(b), up = b.c >= b.o, top = y(Math.max(b.o, b.c)), bot = y(Math.min(b.o, b.c));
      c += `<line x1="${x(i)}" x2="${x(i)}" y1="${y(b.h)}" y2="${y(b.l)}" stroke="var(--candle-down)" stroke-width="1"/>` +
        `<rect x="${x(i) - bw / 2}" y="${top}" width="${bw}" height="${Math.max(1, bot - top)}" fill="${up ? 'var(--candle-up)' : 'var(--candle-down)'}" stroke="var(--candle-down)" stroke-width="1"/>`;
    }
    let mark = '';
    if (opts.marker) {
      const b = bars.find((q) => q.time === opts.marker.bar);
      if (b) mark = `<circle cx="${x(idx(b))}" cy="${y(b.c)}" r="5" fill="var(--series-1)" stroke="var(--surface)" stroke-width="2"/>`;
    }
    root.innerHTML = `<div class="readout">${esc(opts.caption || '')}</div>` +
      `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.title || 'Velas de 5 minutos')}">${g}${levelMarks(levels, y, PAD_L, W - PAD_R)}${c}${mark}` +
      `<line class="cross" visibility="hidden" y1="${PAD_T}" y2="${H - PAD_B}" stroke="var(--ink-3)" stroke-width="1"/></svg>` +
      `<div class="legend"><span><i class="box" style="color:var(--candle-down)"></i>vela bajista (rellena)</span><span>vela alcista (hueca)</span>` +
      (opts.rangeBars ? '<span>franja gris: rango de apertura</span>' : '') +
      (opts.marker ? '<span><i class="box" style="color:var(--series-1);border-radius:50%"></i>vela que confirma la entrada</span>' : '') + '</div>';
    const byIdx = {}; bars.forEach((b) => { byIdx[idx(b)] = b; });
    hover(root, slots, x, (i) => {
      const b = byIdx[i];
      return b ? `${b.time}  apertura ${money(b.o)} · máximo ${money(b.h)} · mínimo ${money(b.l)} · cierre ${money(b.c)} · volumen ${b.v.toLocaleString('es-ES')}` : 'sin vela';
    });
  }

  function fan(root, tm) {
    const m = tm.mc, p = tm.plan, bands = m.bands, n = bands.length, H = 300;
    const vals = bands.flatMap((b) => [b[0], b[4]]).concat([p.stop, p.target, p.entry]);
    const lo = Math.min(...vals), hi = Math.max(...vals), y = scale(lo, hi, H);
    const plotW = W - PAD_L - PAD_R, x = (i) => PAD_L + plotW * i / Math.max(1, n - 1);
    const area = (a, b) => bands.map((r, i) => `${x(i)},${y(r[b])}`).concat(bands.map((r, i) => `${x(i)},${y(r[a])}`).reverse()).join(' ');
    let g = '';
    for (const v of ticks(lo, hi, 4)) g += `<line class="grid" x1="${PAD_L}" x2="${W - PAD_R}" y1="${y(v)}" y2="${y(v)}"/><text x="${PAD_L - 6}" y="${y(v) + 4}" text-anchor="end">${esc(money(v))}</text>`;
    const every = Math.max(1, Math.round(n / 6));
    m.band_times.forEach((t, i) => { if (i % every === 0 || i === n - 1) g += `<text x="${x(i)}" y="${H - 6}" text-anchor="${i === n - 1 ? 'end' : i ? 'middle' : 'start'}">${esc(t)}</text>`; });
    const levels = [{ price: p.target, label: 'Objetivo', kind: 'target' }, { price: p.entry, label: 'Entrada', kind: 'entry' }, { price: p.stop, label: 'Stop', kind: 'stop' }];
    root.innerHTML = `<div class="readout">Dónde queda el precio en ${m.band_paths.toLocaleString('es-ES')} sesiones simuladas, vela a vela.</div>` +
      `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Abanico de la simulación">${g}` +
      `<polygon points="${area(0, 4)}" fill="var(--band)" opacity="0.16"/><polygon points="${area(1, 3)}" fill="var(--band)" opacity="0.30"/>` +
      `<polyline points="${bands.map((r, i) => `${x(i)},${y(r[2])}`).join(' ')}" fill="none" stroke="var(--band)" stroke-width="2"/>` +
      levelMarks(levels, y, PAD_L, W - PAD_R) +
      `<line class="cross" visibility="hidden" y1="${PAD_T}" y2="${H - PAD_B}" stroke="var(--ink-3)" stroke-width="1"/></svg>` +
      `<div class="legend"><span><i style="color:var(--band)"></i>mediana</span><span><i class="box" style="color:var(--band);opacity:.45"></i>la mitad central (25 % a 75 %)</span><span><i class="box" style="color:var(--band);opacity:.2"></i>9 de cada 10 (5 % a 95 %)</span></div>`;
    hover(root, n, x, (i) => `${m.band_times[i]}  mediana ${money(bands[i][2])} · mitad central ${money(bands[i][1])} a ${money(bands[i][3])} · 9 de cada 10 entre ${money(bands[i][0])} y ${money(bands[i][4])}`);
  }

  function hist(root, tm) {
    const m = tm.mc, p = tm.plan, h = m.hist, bins = h.bins, n = bins.length, H = 190;
    const total = bins.reduce((a, b) => a + b, 0) || 1, top = Math.max(...bins) || 1;
    const plotW = W - PAD_L - PAD_R, bw = plotW / n, base = H - PAD_B;
    const xv = (v) => PAD_L + (v - h.lo) / (h.hi - h.lo) * plotW;
    let bars = '';
    bins.forEach((c, i) => {
      const bh = (base - PAD_T - 14) * c / top;
      const lo = h.lo + (h.hi - h.lo) * i / n, hi2 = h.lo + (h.hi - h.lo) * (i + 1) / n;
      bars += `<rect x="${PAD_L + bw * i + 1}" y="${base - bh}" width="${Math.max(1, bw - 2)}" height="${bh}" rx="2" fill="var(--band)" opacity="0.75"><title>${esc(money(lo))} a ${esc(money(hi2))}: ${(100 * c / total).toFixed(1).replace('.', ',')} % de las simulaciones</title></rect>`;
    });
    let marks = '';
    for (const [v, label, kind] of [[p.stop, 'Stop', 'stop'], [p.entry, 'Entrada', 'entry'], [p.target, 'Objetivo', 'target']]) {
      if (v < h.lo || v > h.hi) continue;
      marks += `<line x1="${xv(v)}" x2="${xv(v)}" y1="${PAD_T + 10}" y2="${base}" stroke="${KIND[kind].color}" stroke-width="1.5" stroke-dasharray="${KIND[kind].dash}"/><text class="lbl" x="${xv(v)}" y="${PAD_T + 6}" text-anchor="middle">${label}</text>`;
    }
    let axis = `<line class="grid" x1="${PAD_L}" x2="${W - PAD_R}" y1="${base}" y2="${base}"/>`;
    for (const v of ticks(h.lo, h.hi, 5)) axis += `<text x="${xv(v)}" y="${H - 6}" text-anchor="middle">${esc(money(v))}</text>`;
    root.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Precio al final de cada simulación">${axis}${bars}${marks}</svg>`;
  }

  window.Charts = { candles, fan, hist, money };
})();
