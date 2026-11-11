/* Mesa de Operaciones: interfaz. Cada pantalla es un skill; cada botón ejecuta su script en el servidor local. */
(function () {
  'use strict';
  const TOKEN = document.querySelector('meta[name="mesa-token"]').content;
  const S = { st: null, view: 'hoy', sym: '', res: {}, f: {}, busy: null, chart: {}, auto: null, watch: null };
  const $ = (sel, el) => (el || document).querySelector(sel);
  const h = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (x, d) => (typeof x === 'number' ? x.toLocaleString('es-ES', { minimumFractionDigits: d == null ? 2 : d, maximumFractionDigits: d == null ? 2 : d }) : '–');
  const usd = (x, d) => (typeof x === 'number' ? num(x, d) + ' $' : '–');
  const pct = (x, d) => (typeof x === 'number' ? (x > 0 ? '+' : '') + num(x, d == null ? 1 : d) + ' %' : '–');
  const F = () => (S.st && S.st.files) || {};
  // la señal en pantalla lleva «trigger»; la guardada en entry.json trae hora y precio sueltos
  const trig = (e) => (e ? e.trigger || (e.status === 'triggered' && e.price ? { time: e.time, price: e.price, bar_start: e.bar_start } : null) : null);
  const cfg = () => F().config || {};

  const VIEWS = [
    ['hoy', 'Hoy', null], ['escaner', 'Escáner', 'trader-scanner'], ['noticias', 'Noticias', 'trader-news'],
    ['analista', 'Analista', 'trader-analyst'], ['congreso', 'Congreso', 'trader-pelosi'], ['entrada', 'Entrada', 'trader-entry'],
    ['salida', 'Salida', 'trader-exit'], ['maquina', 'Máquina del tiempo', 'trader-timemachine'],
    ['presupuesto', 'Presupuesto', 'trader-budget'], ['riesgo', 'Riesgo', 'trader-risk'], ['broker', 'Bróker', 'trader-broker'],
    ['alertas', 'Alertas', 'trader-alerts'], ['reglas', 'Mis reglas', null],
  ];
  const SETUPS = {
    breakout_20d: 'Máximo de cierre de 20 días', bull_flag: 'Bandera alcista', reclaim_ma20: 'Recupera la media de 20 días',
    oversold: 'Sobrevendido (RSI bajo 30)', oversold_bounce: 'Rebote desde sobreventa', orb: 'Ruptura del rango de apertura',
  };
  const STATUS = { triggered: ['Confirmada', 'ok'], waiting: ['Esperando', 'warn'], expired: ['Caducada', 'bad'], closed: ['Mercado cerrado', ''], no_data: ['Sin datos', 'bad'] };

  // ---------------------------------------------------------------- servidor
  async function api(path, body) {
    const opt = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Mesa-Token': TOKEN }, body: JSON.stringify(body) };
    const r = await fetch(path, opt);
    const data = await r.json().catch(() => ({ error: 'respuesta no válida del servidor' }));
    if (!r.ok) throw new Error(data.error || ('error ' + r.status));
    return data;
  }
  async function refresh() { S.st = await api('/api/state'); }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function run(action, params, opt) {
    opt = opt || {};
    const key = opt.key || action;
    if (S.busy) { toast('Espera a que termine el paso en curso.'); return null; }
    S.busy = key; paint();
    let job;
    try {
      const { job: id } = await api('/api/run', { action, params: params || {} });
      for (;;) {
        job = await api('/api/job/' + id);
        if (job.status !== 'running') break;
        await sleep(350);
      }
    } catch (e) {
      job = { action, code: 2, stdout: '', stderr: e.message, cmd: '', status: 'done' };
    }
    S.res[key] = job;
    S.busy = null;
    try { await refresh(); } catch (e) { /* el servidor se ha parado */ }
    if (!opt.quiet) paint();
    return job;
  }
  async function chain(steps) {
    for (const [action, params, key] of steps) {
      const job = await run(action, params, { key, quiet: true });
      if (!job || job.code > 1 || (job.code === 1 && action !== 'risk.check' && action !== 'alerts.check')) break;
    }
    paint();
  }
  function toast(msg, ms) {
    const el = document.createElement('div');
    el.className = 'toast'; el.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), ms || 6000);
  }

  // ---------------------------------------------------------------- piezas de formulario
  function fv(form, name, def) {
    const v = (S.f[form] || {})[name];
    return v === undefined ? def : v;
  }
  function field(form, name, label, o) {
    o = o || {};
    const v = fv(form, name, o.def == null ? '' : o.def);
    if (o.options) {
      return `<label>${h(label)}<select name="${name}">${o.options.map(([val, txt]) => `<option value="${h(val)}"${String(v) === String(val) ? ' selected' : ''}>${h(txt)}</option>`).join('')}</select></label>`;
    }
    if (o.type === 'checkbox') return `<label class="check"><input type="checkbox" name="${name}"${v ? ' checked' : ''}> ${h(label)}</label>`;
    return `<label>${h(label)}<input type="${o.type || 'text'}" name="${name}" value="${h(v)}" placeholder="${h(o.ph || '')}"${o.step ? ` step="${o.step}"` : ''}${o.type === 'number' ? ' inputmode="decimal"' : ''}></label>`;
  }
  const btn = (label, o) => `<button type="submit" class="${o && o.plain ? '' : 'primary'}" data-do="${h((o && o.do) || '')}">${h(label)}</button>`;
  const go = (view, label, sym) => `<button type="button" class="link" data-go="${view}"${sym ? ` data-sym="${h(sym)}"` : ''}>${h(label)}</button>`;
  function raw(key) {
    const j = S.res[key];
    if (!j) return '';
    const out = j.json ? JSON.stringify(j.json, null, 2) : j.stdout;
    return `<details class="raw"><summary>Salida del skill${j.code ? ` (código ${j.code})` : ''}</summary>` +
      (j.cmd ? `<pre>${h(j.cmd)}</pre>` : '') + (j.stderr ? `<pre class="err">${h(j.stderr)}</pre>` : '') +
      (out ? `<pre>${h(out.length > 30000 ? out.slice(0, 30000) + '\n…' : out)}</pre>` : '') + '</details>';
  }
  function failure(key) {
    const j = S.res[key];
    if (!j || !j.stderr || j.json) return '';
    return `<div class="note bad">${h(j.stderr.trim())}</div>`;
  }
  const head = (title, skill, lead) => `<div class="view-head">${skill ? `<span class="eyebrow">${h(skill)}</span>` : ''}<h2>${h(title)}</h2><p class="lead">${lead}</p></div>`;
  const card = (title, body, extra) => `<section class="card"><h3><span>${h(title)}</span>${extra || ''}</h3>${body}</section>`;
  const table = (cols, rows) => `<div class="table-wrap"><table><thead><tr>${cols.map((c) => `<th${c[1] ? ' class="r"' : ''}>${h(c[0])}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
  const tag = (txt, kind) => `<span class="tag ${kind || ''}">${h(txt)}</span>`;
  const english = '<p class="small muted">Los mensajes del skill se muestran tal cual, en inglés.</p>';

  // ---------------------------------------------------------------- estado del día
  function day() {
    const st = S.st, f = F(), d = (st.market || {}).date;
    const log = ((f.state.broker || {}).orders || []).filter((o) => o.date === d);
    const entries = log.filter((o) => o.status === 'placed' && o.kind === 'entry');
    const plan = f.plan && f.plan.date === d ? f.plan : null;
    const entry = f.entry && f.entry.date === d ? f.entry : null;
    const tm = f.timemachine && plan && f.timemachine.plan && f.timemachine.plan.symbol === plan.symbol &&
      f.timemachine.plan.entry === plan.entry && f.timemachine.plan.stop === plan.stop && f.timemachine.plan.target === plan.target ? f.timemachine : null;
    const orders = (f.orders || {}).orders || [];
    const risk = f.state.risk && f.state.risk.date === d ? f.state.risk : null;
    const rules = ((f.alerts || {}).rules || []).filter((r) => !r.date || r.date === d);
    const rung = (f.state.alerts || {}).rung || {};
    return { d, log, entries, plan, entry, tm, orders, risk, rules, rung,
      trades: entries.length, atRisk: entries.reduce((a, o) => a + (o.max_loss || 0), 0),
      positions: ((f.portfolio || {}).positions || []).filter((p) => p.shares > 0) };
  }
  function pipeline() {
    const f = F(), D = day(), wl = f.watchlist;
    const last = D.log[D.log.length - 1];
    return [
      ['escaner', wl ? 'on' : 'off', wl ? `${(wl.hits || []).length} gráficos coinciden con una regla (${wl.mode === 'orb' ? 'ruptura del rango' : 'diario'}, ${wl.as_of})` : 'Sin lista de seguimiento'],
      ['noticias', S.res['news.check'] ? 'on' : 'off', S.res['news.check'] && S.res['news.check'].json ? `${S.res['news.check'].json.items.length} novedades en la última comprobación` : 'Sin comprobar en esta sesión'],
      ['entrada', D.entry ? (D.entry.status === 'triggered' ? 'on' : 'wait') : 'off', D.entry ? `${D.entry.symbol}: ${(STATUS[D.entry.status] || [D.entry.status])[0].toLowerCase()}${trig(D.entry) ? ` a las ${trig(D.entry).time} en ${usd(trig(D.entry).price)}` : ''}` : 'Sin señal guardada hoy'],
      ['salida', D.plan ? 'on' : 'off', D.plan ? `${D.plan.symbol}: stop ${usd(D.plan.stop)}, objetivo ${usd(D.plan.target)}, fuera antes de las ${D.plan.flat_by}` : 'Sin plan para hoy'],
      ['maquina', D.tm ? 'on' : 'off', D.tm ? D.tm.verdict : 'Sin simular este plan'],
      ['presupuesto', D.orders.length ? 'on' : 'off', D.orders.length ? D.orders.map((o) => `${o.side === 'buy' ? 'Comprar' : 'Vender'} ${o.qty || o.notional} ${o.symbol}`).join(', ') : 'Sin orden propuesta'],
      ['riesgo', D.risk ? (D.risk.block ? 'bad' : 'on') : 'off', D.risk ? `${D.risk.pass} pasan, ${D.risk.block} bloqueadas (${D.risk.now_new_york.slice(11)})` : 'Sin comprobar hoy'],
      ['broker', last ? 'on' : 'off', last ? `Último registro: ${last.status}${last.symbol ? ' ' + last.symbol : ''}` : 'Nada registrado hoy'],
      ['alertas', D.rules.length ? 'on' : 'off', D.rules.length ? `${D.rules.length} alertas activas hoy, ${D.rules.filter((r) => D.rung[r.id]).length} han sonado` : 'Sin alertas'],
    ];
  }
  function nextStep() {
    const D = day(), f = F();
    if (!f.watchlist) return ['escaner', 'Empieza por el escáner para tener una lista de gráficos que cumplen una regla.'];
    if (D.positions.length) return ['alertas', `Tienes ${D.positions.map((p) => p.ticker).join(', ')} abierta. Vigila el stop, el objetivo y la hora de salida.`];
    if (!D.entry || D.entry.status !== 'triggered') return ['entrada', 'Elige un valor de la lista y comprueba si su entrada se ha confirmado.'];
    if (!D.plan) return ['salida', 'La entrada está confirmada: fija el stop y el objetivo antes de comprar nada.'];
    if (!D.tm) return ['maquina', 'Repite el plan 10.000 veces antes de arriesgar dinero.'];
    if (!D.orders.length) return ['presupuesto', 'Calcula cuántos títulos caben en tu pérdida máxima.'];
    if (!D.risk) return ['riesgo', 'Comprueba la orden contra tus límites.'];
    return ['broker', 'Revisa el ticket y decide.'];
  }

  // ---------------------------------------------------------------- pantallas
  const V = {};

  V.hoy = () => {
    const st = S.st, m = st.market || {}, D = day(), c = cfg();
    const maxT = c.max_trades_per_day || 0, maxL = c.max_daily_loss_usd || 0;
    const [nv, ntext] = nextStep();
    const names = Object.fromEntries(VIEWS.map((v) => [v[0], v[1]]));
    const pos = D.positions.length ? table([['Valor'], ['Títulos', 1], ['Coste', 1], ['']], D.positions.map((p) =>
      `<tr><td><strong>${h(p.ticker)}</strong></td><td class="r">${num(p.shares, 0)}</td><td class="r">${usd((p.lots || []).reduce((a, l) => a + (l.cost || 0), 0))}</td><td><button type="button" data-flatten="${h(p.ticker)}">Preparar venta de cierre</button></td></tr>`)) : '<p class="muted">Sin posiciones abiertas.</p>';
    return head('Hoy', null, 'El recorrido de una operación intradía, de la búsqueda a la salida. Cada paso es un skill y deja escrito su resultado para el siguiente.') +
      `<div class="kpis">
        <div class="kpi"><span class="kpi-label">Bolsa de Nueva York</span><span class="kpi-value">${m.open ? 'Abierta' : 'Cerrada'}</span><span class="kpi-note">${h(m.reason || '')}${!m.open && m.next_open ? ` · abre ${h(m.next_open)}` : ''}${m.early_close ? ' · hoy cierra a las 13:00' : ''}</span></div>
        <div class="kpi"><span class="kpi-label">Operaciones hoy</span><span class="kpi-value">${D.trades} de ${maxT}</span><div class="meter${D.trades >= maxT ? ' full' : ''}"><span style="width:${maxT ? Math.min(100, 100 * D.trades / maxT) : 0}%"></span></div></div>
        <div class="kpi"><span class="kpi-label">Riesgo comprometido hoy</span><span class="kpi-value">${usd(D.atRisk)}</span><div class="meter${D.atRisk >= maxL ? ' full' : ''}"><span style="width:${maxL ? Math.min(100, 100 * D.atRisk / maxL) : 0}%"></span></div><span class="kpi-note">límite diario ${usd(maxL, 0)}</span></div>
        <div class="kpi"><span class="kpi-label">Efectivo</span><span class="kpi-value">${usd(F().portfolio ? F().portfolio.cash : c.budget)}</span><span class="kpi-note">${F().portfolio ? 'según lo registrado' : 'cuenta nueva: tu presupuesto'} · ${c.paper === false ? 'cuenta REAL' : 'cuenta de papel'}</span></div>
      </div>` +
      `<div class="note info"><strong>Siguiente paso: ${h(names[nv])}.</strong> ${h(ntext)} ${go(nv, 'Ir')}</div>` +
      card('El día, paso a paso', `<ul class="steps">${pipeline().map(([v, s, text], i) =>
        `<li><span class="dot ${s === 'on' ? 'on' : s === 'bad' ? 'bad' : s === 'wait' ? 'wait' : 'off'}"></span><strong>${i + 1}. ${h(names[v])}</strong><span class="what muted">${h(text)}</span>${go(v, 'Abrir')}</li>`).join('')}</ul>` +
        '<p class="small muted">El Analista y el Congreso son consultas de contexto: úsalos cuando un valor te interese, antes de planificar la entrada.</p>') +
      card('Posiciones abiertas', pos) +
      (D.log.length ? card('Registro de hoy', table([['Hora'], ['Estado'], ['Orden']], D.log.map((o) =>
        `<tr><td>${h((o.at || '').slice(11, 16))}</td><td>${tag(o.status, o.status === 'placed' || o.status === 'filled' ? 'ok' : o.status === 'approved' ? 'info' : '')}</td><td>${h(o.plain || `${o.side || ''} ${o.qty || ''} ${o.symbol || ''} ${o.price ? 'a ' + o.price : ''}`)}</td></tr>`))) : '');
  };

  V.escaner = () => {
    const st = S.st, wl = F().watchlist, demo = st.mode === 'demo';
    const j = S.res['scanner.daily'], k = S.res['scanner.orb'];
    const counts = (job) => job && job.json && job.json.counts ? (() => {
      const c = job.json.counts;
      const none = c.requested && !c.fetched ? '<div class="note bad">No ha llegado ningún gráfico. Comprueba la conexión a internet o que Yahoo no esté limitando las peticiones, y vuelve a intentarlo.</div>' : '';
      return none + `<p class="small muted">Pedidos ${c.requested}, recibidos ${c.fetched}, analizados ${c.scanned}, coinciden ${c.hits}${job.json.failed ? `, ${job.json.failed} fallaron o no tienen datos` : ''}${c.illiquid ? `, ${c.illiquid} bajo el suelo de precio o volumen` : ''}${c.unconfirmed ? `, ${c.unconfirmed} candidatos sin confirmar (resultado PARCIAL)` : ''}.</p>`;
    })() : '';
    let hits = '<p class="muted">Aún no hay lista de seguimiento. Lanza un escaneo.</p>';
    if (wl && (wl.hits || []).length) {
      const orb = wl.mode === 'orb';
      hits = table(orb ? [['Valor'], ['Hora'], ['Cierre', 1], ['Rango de apertura', 1], ['Sobre el máximo', 1], ['']] : [['Valor'], ['Regla'], ['Cierre', 1], ['RSI', 1], ['Volumen', 1], ['']],
        wl.hits.map((x) => `<tr${x.symbol === S.sym ? ' class="hl"' : ''}><td><strong>${h(x.symbol)}</strong>${st.demo_symbols[x.symbol] ? `<br><span class="small muted">${h(st.demo_symbols[x.symbol])}</span>` : ''}</td>` +
          (orb ? `<td>${h(x.at)}</td><td class="r">${usd(x.price)}</td><td class="r">${num(x.or_low)} – ${num(x.or_high)}</td><td class="r">${pct(x.pct_over, 2)}</td>`
            : `<td>${x.setups.map((s) => tag(SETUPS[s] || s)).join(' ')}</td><td class="r">${usd(x.price)}</td><td class="r">${num(x.rsi, 1)}</td><td class="r">${x.volume ? x.volume.toLocaleString('es-ES') : '–'}</td>`) +
          `<td>${go('noticias', 'Noticias', x.symbol)} · ${go('entrada', 'Entrada', x.symbol)}</td></tr>`));
    } else if (wl) hits = '<p class="muted">El último escaneo no encontró ningún gráfico que cumpla una regla.</p>';
    return head('Escáner de gráficos', 'trader-scanner', 'Recorre miles de gráficos y lista los que cumplen una regla. Es una lista de gráficos que coinciden con una regla, no una lista de valores que comprar.') +
      `<div class="grid2">${card('Antes de la apertura: cierres diarios', `<form data-form="scanner.daily">
          <div class="fields">${field('scanner.daily', 'symbols', 'Valores (vacío = todo el universo)', { ph: 'TSLA, NVDA, AMD' })}${field('scanner.daily', 'limit', 'Solo los primeros N', { type: 'number', ph: 'todos' })}${field('scanner.daily', 'min_price', 'Precio mínimo ($)', { type: 'number', def: 5 })}${field('scanner.daily', 'min_volume', 'Volumen mínimo', { type: 'number', def: 1000000 })}</div>
          <div class="actions">${btn('Escanear cierres diarios')}</div></form>
          <p class="small muted">Máximo de 20 días, bandera alcista, recuperación de la media de 20, sobreventa y rebote. ${demo ? '' : 'El universo completo son unas 300 peticiones a Yahoo: tarda dos o tres minutos.'}</p>${failure('scanner.daily')}${counts(j)}${raw('scanner.daily')}`) +
      card('Con el mercado abierto: ruptura del rango', `<form data-form="scanner.orb">
          <div class="fields">${field('scanner.orb', 'symbols', 'Valores', { ph: 'vacío = universo' })}${field('scanner.orb', 'or_minutes', 'Minutos del rango', { type: 'number', def: 15 })}${demo ? '' : field('scanner.orb', 'at', 'Cortar el reloj a las', { type: 'time' })}${field('scanner.orb', 'min_price', 'Precio mínimo ($)', { type: 'number', def: 5 })}</div>
          ${field('scanner.orb', 'use_watchlist', 'Escanear solo mi lista de seguimiento actual', { type: 'checkbox' })}
          <div class="actions">${btn('Buscar rupturas')}</div></form>
          <p class="small muted">Primera vela de 5 minutos que CIERRA por encima del máximo de los primeros 15 minutos. Disponible a partir de las 9:50 de Nueva York.</p>${failure('scanner.orb')}${counts(k)}${raw('scanner.orb')}`)}</div>` +
      (demo ? '' : card('Universo de valores', `<p>${st.universe ? 'Ya tienes <span class="mono">trader/universe.txt</span>. Conviene renovarlo una vez por semana.' : 'Aún no has descargado la lista de valores cotizados en EE. UU. Sin ella, indica tú los tickers.'}</p><div class="actions"><button type="button" data-run="scanner.universe">Descargar la lista de Nasdaq Trader</button></div>${failure('scanner.universe')}${raw('scanner.universe')}`)) +
      card('Lista de seguimiento', hits + (wl ? `<p class="small muted">${wl.mode === 'orb' ? 'Rupturas del rango' : 'Escaneo diario'}, datos a ${h(wl.as_of)}. Una coincidencia caduca cuando el precio se ha movido: vuelve a escanear antes de actuar.</p>` : ''));
  };

  V.noticias = () => {
    const j = S.res['news.check'], d = j && j.json, st = S.st;
    const ny = (iso) => iso ? new Date(iso).toLocaleString('es-ES', { timeZone: 'America/New_York', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
    let out = '';
    if (d) {
      out += card('Movimiento frente al cierre de ayer', d.moves.length ? table([['Valor'], ['Precio', 1], ['Cierre anterior', 1], ['Variación', 1], ['']], d.moves.map((m) =>
        `<tr><td><strong>${h(m.ticker)}</strong></td><td class="r">${usd(m.price)}</td><td class="r">${usd(m.prev_close)}</td><td class="r">${pct(m.pct, 2)}</td><td>${m.moving ? tag('SE MUEVE', 'warn') : ''}</td></tr>`)) : '<p class="muted">Sin precios.</p>');
      out += card(`Novedades (${d.items.length})`, d.items.length ? `<ul class="plain">${d.items.map((it) =>
        `<li><span class="small muted">${h(ny(it.time))} NY · ${h(it.source)}</span> ${(it.touches || []).map((t) => tag(t, 'info')).join(' ')} ${(it.tags || []).map((t) => tag(t)).join(' ')}${it.important ? ' ' + tag('8-K importante', 'bad') : ''}<br>` +
        `${/^https:\/\//.test(it.link || '') ? `<a href="${h(it.link)}" target="_blank" rel="noopener noreferrer">${h(it.title)}</a>` : h(it.title)}${it.summary ? `<br><span class="small muted">${h(it.summary)}</span>` : ''}</li>`).join('')}</ul>` : '<p class="muted">Nada nuevo desde la última comprobación.</p>') +
        (d.notes || []).map((n) => `<div class="note warn">${h(n)}</div>`).join('');
    }
    return head('Monitor de noticias', 'trader-news', 'Titulares de Yahoo Finance y comunicaciones 8-K de la SEC de cada valor que sigues, solo lo nuevo. Un titular es una pista, no un hecho: abre la noticia o el documento antes de darlo por cierto.') +
      card('Comprobar', `<form data-form="news.check"><div class="fields">${field('news.check', 'tickers', 'Valores (vacío = lista, plan y posiciones)', { def: S.sym, ph: 'TSLA NVDA' })}${field('news.check', 'hours', 'Últimas horas', { type: 'number', def: 48 })}${field('news.check', 'forms', 'Formularios SEC', { def: '8-K' })}</div>
        ${field('news.check', 'all', 'Mostrar también lo ya visto', { type: 'checkbox' })}${field('news.check', 'no_sec', 'Solo titulares, sin la SEC', { type: 'checkbox' })}
        <div class="actions">${btn('Comprobar noticias')}</div></form>` +
        (st.mode !== 'demo' && !st.sec_ua_ok ? `<div class="note warn">La SEC exige identificarse con nombre y correo. Sin eso, los 8-K se omiten. Añádelo en ${go('reglas', 'Mis reglas')}.</div>` : '') +
        (j && j.code === 1 && !d ? '<p class="muted">Nada nuevo.</p>' : '') + failure('news.check') + raw('news.check')) + out;
  };

  V.analista = () => {
    const j = S.res['analyst.facts'], st = S.st;
    const M = (v) => (typeof v === 'number' ? num(v / 1e6, 0) : '–');
    let out = '';
    for (const co of (j && Array.isArray(j.json) ? j.json : [])) {
      const r = co.result;
      if (!r) { out += card(co.ticker, `<div class="note bad">${h(co.error || 'sin datos')}</div>`); continue; }
      const fl = co.filings || {};
      out += card(`${r.entity || co.ticker} (${co.ticker})`, table([['Trimestre'], ['Fiscal'], ['Ingresos (M$)', 1], ['Interanual', 1], ['Margen bruto', 1], ['Margen operativo', 1], ['Margen neto', 1], ['Beneficio (M$)', 1], ['BPA diluido', 1], ['Interanual', 1]],
        r.rows.map((q) => `<tr><td>${h(q.end)}${q.derived ? ' ' + tag('derivado') : ''}</td><td>${h(q.fiscal)}</td><td class="r">${M(q.revenue)}</td><td class="r">${pct(q.revenue_yoy)}</td><td class="r">${q.gross_margin == null ? '–' : num(q.gross_margin, 1) + ' %'}</td><td class="r">${q.operating_margin == null ? '–' : num(q.operating_margin, 1) + ' %'}</td><td class="r">${q.net_margin == null ? '–' : num(q.net_margin, 1) + ' %'}</td><td class="r">${M(q.net_income)}</td><td class="r">${num(q.eps_diluted)}</td><td class="r">${pct(q.eps_yoy)}</td></tr>`)) +
        (r.ttm && r.ttm.revenue ? `<p>Últimos cuatro trimestres: ingresos ${M(r.ttm.revenue)} M$, beneficio ${M(r.ttm.net_income)} M$, BPA diluido ${num(r.ttm.eps_diluted)} $.</p>` : '') +
        `<ul class="plain">${(co.changes || []).map((c) => `<li>${h(c)}</li>`).join('')}</ul>` +
        (co.note ? `<div class="note warn">${h(co.note)}</div>` : '') +
        `<p class="small">${fl.report ? `Último ${h(fl.report.form)} (periodo ${h(fl.report.period)}, presentado ${h(fl.report.filed)}): <a href="${h(fl.report.url)}" target="_blank" rel="noopener noreferrer">documento</a>. ` : ''}${fl.earnings_8k ? `Último 8-K de resultados (${h(fl.earnings_8k.filed)}): <a href="${h(fl.earnings_8k.exhibit || fl.earnings_8k.index)}" target="_blank" rel="noopener noreferrer">${fl.earnings_8k.exhibit ? 'nota de prensa' : 'índice'}</a>.` : ''}</p>`, r.cik ? `<span class="small muted">CIK ${h(r.cik)}</span>` : '');
    }
    return head('Analista de resultados', 'trader-analyst', 'Las cifras que la empresa presentó a la SEC, trimestre a trimestre y contra el mismo trimestre del año anterior. No dice si un valor está caro o barato.') +
      card('Consultar', `<form data-form="analyst.facts"><div class="fields">${field('analyst.facts', 'tickers', 'Valores', { def: S.sym, ph: 'TSLA NVDA' })}${field('analyst.facts', 'quarters', 'Trimestres', { type: 'number', def: 6 })}</div><div class="actions">${btn('Leer las cuentas')}</div></form>` +
        (st.mode !== 'demo' && !st.sec_ua_ok ? `<div class="note warn">Este skill no llama a la SEC sin tu nombre y correo. Añádelos en ${go('reglas', 'Mis reglas')}.</div>` : '') +
        '<p class="small muted">La fecha del próximo informe no está en los datos de la SEC: búscala en los titulares o en la web de la empresa. Un stop no protege de un hueco de apertura tras unos resultados.</p>' + failure('analyst.facts') + raw('analyst.facts')) + out + (out ? english : '');
  };

  V.congreso = () => {
    const j = S.res['pelosi.list'], rep = S.res['pelosi.fetch'], st = S.st;
    const rows = j && j.json ? (Array.isArray(j.json) ? j.json : j.json.new || []) : null;
    const held = new Set(day().positions.map((p) => p.ticker));
    let out = '';
    if (rows) {
      out += card(`Declaraciones (${rows.length})`, rows.length ? table([['Presentada'], ['Miembro'], ['Distrito'], ['Tipo'], ['Documento'], ['']], rows.map((r) =>
        `<tr><td>${h(r.filed)}</td><td>${h(r.name)}</td><td>${h(r.district)}</td><td>${h(r.type_name)}</td><td><a href="${h(r.url)}" target="_blank" rel="noopener noreferrer">${h(r.doc_id)}</a></td><td>${r.type === 'P' ? `<button type="button" data-ptr="${h(r.doc_id)}" data-filed="${h(r.filed)}">Leer</button>` : ''}</td></tr>`)) : '<p class="muted">Nada nuevo.</p>');
    }
    const R = rep && rep.json;
    if (R && R.rows) {
      out += card(`${R.name || 'Declaración'} · ${R.district || ''} · documento ${R.doc_id || ''}`, table([['Titular'], ['Operación'], ['Activo'], ['Detalle'], ['Importe (rango)'], ['Fecha'], ['Días hasta declararla', 1]], R.rows.map((r) =>
        `<tr${held.has(r.ticker) ? ' class="hl"' : ''}><td>${h(r.owner_name)}</td><td>${h(r.type_name)}</td><td>${h(r.asset)}${r.ticker ? ` <strong>(${h(r.ticker)})</strong>` : ''}${held.has(r.ticker) ? ' ' + tag('lo tienes', 'info') : ''}</td>` +
        `<td>${r.option ? `${r.option.exercised ? 'ejercidas ' : ''}${r.option.contracts} opciones ${h(r.option.kind)}, strike ${num(r.option.strike, 0)} $, vencen ${h(r.option.expires)}` : r.shares ? r.shares.toLocaleString('es-ES') + ' acciones' : h(r.description || '')}</td>` +
        `<td>${h(r.amount)}</td><td>${h(r.date)}</td><td class="r">${r.days_to_disclose == null ? '–' : r.days_to_disclose}${r.late ? ' ' + tag('tarde', 'bad') : ''}</td></tr>`)) +
        (R.rows.length ? '' : '<p class="muted">No se han encontrado filas: abre el PDF y léelo directamente.</p>'));
    }
    return head('Operaciones del Congreso', 'trader-pelosi', 'Las operaciones que los miembros de la Cámara de Representantes deben declarar (STOCK Act), leídas del índice público del Clerk. Es rápido, no es anticipado: una declaración llega hasta 45 días después de la operación. No hay información privilegiada aquí.') +
      card('Buscar', `<form data-form="pelosi.list"><div class="fields">${field('pelosi.list', 'member', 'Miembro (apellido, o varios con comas)', { ph: st.mode === 'demo' ? 'Ejemplo' : 'Pelosi' })}${field('pelosi.list', 'since', 'Presentadas desde', { type: 'date' })}</div>
        <div class="actions">${btn('Ver el índice', { do: 'index' })}${btn('Solo lo nuevo desde la última vez', { do: 'new', plain: true })}</div></form>` +
        (st.mode !== 'demo' && !st.pdftotext ? '<div class="note warn">No está instalado <span class="mono">pdftotext</span> (poppler): se descargará el PDF pero habrá que leerlo a mano.</div>' : '') +
        failure('pelosi.list') + raw('pelosi.list')) + out + failure('pelosi.fetch') + (rep ? `<section class="card">${raw('pelosi.fetch')}</section>` : '') +
      '<div class="note">Los importes son rangos, nunca cifras exactas. El titular importa: «spouse» es el cónyuge. Una opción comprada no es una compra de acciones. El Senado publica en efdsearch.senate.gov y pide aceptar a mano un aviso legal: esa ruta no se automatiza.</div>';
  };

  function levelsFor(sym) {
    const D = day(), e = D.entry && D.entry.symbol === sym ? D.entry : null, p = D.plan && D.plan.symbol === sym ? D.plan : null;
    const L = [], or = (p && p.opening_range) || (e && e.opening_range);
    if (p) L.push({ price: p.target, label: 'Objetivo', kind: 'target' }, { price: p.entry, label: 'Entrada', kind: 'entry' }, { price: p.stop, label: 'Stop', kind: 'stop' });
    if (or && typeof or.high === 'number') { L.push({ price: or.high, label: 'Máx. rango', kind: 'range' }); if (!p) L.push({ price: or.low, label: 'Mín. rango', kind: 'range' }); }
    else if (e && e.level) L.push({ price: e.level, label: 'Nivel', kind: 'range' });
    const bar = trig(e) ? trig(e).bar_start : null;
    return { levels: L, marker: bar ? { bar } : null, rangeBars: or ? Math.round((or.minutes || 15) / 5) : 0 };
  }
  const chartBox = (sym) => sym ? `<div class="chart" data-chart="${h(sym)}"><p class="muted">Cargando el gráfico de ${h(sym)}…</p></div>` : '';

  V.entrada = () => {
    const j = S.res['entry.check'], e = j && j.json, D = day(), sym = (e && e.symbol) || S.sym || (D.entry && D.entry.symbol) || '';
    let out = '';
    if (e) {
      const [label, kind] = STATUS[e.status] || [e.status, ''];
      const or = e.opening_range || {};
      out = card(`${e.symbol} · ${e.date}`, `<p>${tag(label, kind)} ${h(e.reason || '')}</p>
        <dl class="dl">${or.high ? `<dt>Rango de apertura</dt><dd>${usd(or.low)} a ${usd(or.high)} (${or.bars} de ${or.of} velas)</dd>` : ''}
        ${e.trigger ? `<dt>Entrada</dt><dd>${h(e.trigger.time)} en ${usd(e.trigger.price)}, ${pct(e.trigger.pct_over, 2)} sobre el nivel · volumen ${num(e.trigger.volume_x, 2)} veces el del rango</dd>` : ''}
        ${e.last ? `<dt>Último cierre</dt><dd>${usd(e.last.close)} (vela de las ${h(e.last.bar_start)}), ${pct(e.last.vs_level_pct, 2)} respecto al nivel</dd>` : ''}
        ${e.forming ? `<dt>Vela en curso</dt><dd>no cuenta hasta que cierre</dd>` : ''}
        <dt>Ventana de entradas</dt><dd>${h(e.no_entries_before || '–')} a ${h(e.no_entries_after || '–')} (Nueva York)</dd></dl>` +
        (e.status === 'triggered' ? `<div class="note ok">La vela ha cerrado por encima del nivel. No se ha comprado nada. ${e.minutes_since > 5 ? `La señal tiene ya ${e.minutes_since} minutos: una entrada tardía es otra operación. ` : ''}${D.entry && D.entry.symbol === e.symbol && D.entry.status === 'triggered' ? `Señal guardada: ${go('salida', 'fija el stop y el objetivo')}.` : 'Guárdala para planificar la salida.'}</div>` : '') + english);
    }
    const w = S.res['entry.watchlist'];
    return head('Momento de entrada', 'trader-entry', 'Vigila un valor vela a vela y avisa cuando una vela CIERRA por encima del máximo del rango de apertura (o de un nivel que tú indiques). Una mecha por encima no es una entrada. Solo operaciones al alza.') +
      card('Comprobar un valor', `<form data-form="entry.check"><div class="fields">${field('entry.check', 'symbol', 'Valor', { def: sym, ph: 'TSLA' })}${field('entry.check', 'setup', 'Regla', { options: [['orb', 'Rango de apertura'], ['level', 'Nivel que yo indico']] })}${field('entry.check', 'level', 'Nivel ($), si aplica', { type: 'number', step: '0.01' })}${field('entry.check', 'interval', 'Velas', { options: [['5m', '5 minutos'], ['1m', '1 minuto']] })}${field('entry.check', 'or_minutes', 'Minutos del rango', { type: 'number', def: 15 })}${field('entry.check', 'min_volume_x', 'Volumen mínimo (× rango)', { type: 'number', step: '0.1', ph: 'sin filtro' })}</div>
        <div class="actions">${btn('Comprobar y guardar la señal', { do: 'write' })}${btn('Solo mirar', { do: 'look', plain: true })}${btn('Vigilar hasta que salte', { do: 'watch', plain: true })}</div></form>` +
        failure('entry.check') + raw('entry.check')) +
      (S.watch ? card('Vigilancia', `<p class="small muted">Una línea por vela cerrada. Se detiene al saltar la señal o al caducar. Mantén el ordenador despierto.</p><pre id="watchout">${h(S.watch.out || 'Esperando la primera vela…')}</pre><div class="actions">${S.watch.done ? '' : '<button type="button" class="danger" data-stopwatch="1">Detener</button>'}</div>`) : '') +
      out + (sym ? card(`Sesión de ${sym} en velas de 5 minutos`, chartBox(sym)) : '') +
      card('Toda la lista de seguimiento', `<div class="actions"><button type="button" data-run="entry.watchlist">Comprobar cada valor de la lista</button></div>${failure('entry.watchlist')}${w && w.stdout ? `<pre>${h(w.stdout)}</pre>` : ''}`);
  };

  V.salida = () => {
    const D = day(), e = D.entry, p = D.plan, j = S.res['exit.plan'];
    const stopKind = fv('exit.plan', 'stop_kind', e && e.setup === 'level' ? 'pct' : 'or-mid');
    const targetKind = fv('exit.plan', 'target_kind', '2R');
    let out = '';
    if (p) {
      out = card(`Plan de ${p.symbol} · ${p.date}`, `<div class="kpis">
          <div class="kpi"><span class="kpi-label">Entrada</span><span class="kpi-value">${usd(p.entry)}</span><span class="kpi-note">${h(p.entry_time || '')}</span></div>
          <div class="kpi"><span class="kpi-label">Stop</span><span class="kpi-value">${usd(p.stop)}</span><span class="kpi-note">${h(p.stop_label || '')}</span></div>
          <div class="kpi"><span class="kpi-label">Objetivo</span><span class="kpi-value">${usd(p.target)}</span><span class="kpi-note">${h(p.target_label || '')}</span></div>
          <div class="kpi"><span class="kpi-label">Riesgo por título</span><span class="kpi-value">${usd(p.risk_per_share)}</span><span class="kpi-note">${num(100 * p.risk_per_share / p.entry, 2)} % de la entrada</span></div>
          <div class="kpi"><span class="kpi-label">Beneficio : riesgo</span><span class="kpi-value">${num(p.reward_risk, 1)}</span><span class="kpi-note">fuera antes de las ${h(p.flat_by)} NY</span></div></div>` +
        (p.stop_detail ? `<p class="small muted">${h(p.stop_detail)}</p>` : '') + (p.warnings || []).map((w) => `<div class="note warn">${h(w)}</div>`).join('') +
        `<div class="note">Un stop es un plan, no una garantía: un hueco o un mercado rápido pueden ejecutarlo más abajo. Siguiente: ${go('maquina', 'repite el plan en la Máquina del tiempo')} y ${go('alertas', 'pon las alertas')}.</div>` + chartBox(p.symbol));
    }
    return head('Plan de salida', 'trader-exit', 'Decide cómo termina la operación antes de que empiece: el stop donde la idea ha fallado y el objetivo donde recoges. Se fijan antes de entrar, nunca después.') +
      card('Señal de partida', e ? `<p><strong>${h(e.symbol)}</strong> ${tag((STATUS[e.status] || [e.status])[0], (STATUS[e.status] || [])[1])} ${trig(e) ? `entrada ${usd(trig(e).price)} a las ${h(trig(e).time)}` : h(e.reason || '')}${e.opening_range && e.opening_range.high ? ` · rango ${usd(e.opening_range.low)} a ${usd(e.opening_range.high)}` : ''}</p>` : `<p class="muted">No hay señal guardada hoy. ${go('entrada', 'Comprueba una entrada')} o planifica a mano más abajo.</p>`) +
      card('Fijar stop y objetivo', `<form data-form="exit.plan"><div class="fields">
          ${field('exit.plan', 'stop_kind', 'Stop', { def: stopKind, options: [['or-mid', 'Punto medio del rango'], ['or-low', 'Mínimo del rango'], ['price', 'Mi precio'], ['pct', 'Un % bajo la entrada'], ['atr', 'Múltiplo del ATR']] })}
          ${['price', 'pct', 'atr'].includes(stopKind) ? field('exit.plan', 'stop_value', stopKind === 'price' ? 'Precio del stop ($)' : stopKind === 'pct' ? 'Porcentaje' : 'Veces el ATR', { type: 'number', step: '0.01' }) : ''}
          ${field('exit.plan', 'target_kind', 'Objetivo', { def: targetKind, options: [['2R', '2R: dos veces el riesgo'], ['1R', '1R'], ['1.5R', '1,5R'], ['3R', '3R'], ['price', 'Mi precio']] })}
          ${targetKind === 'price' ? field('exit.plan', 'target_value', 'Precio objetivo ($)', { type: 'number', step: '0.01' }) : ''}
          ${field('exit.plan', 'flat_by', 'Fuera antes de (NY)', { type: 'time', def: cfg().flat_by || '15:55' })}
          ${field('exit.plan', 'entry', 'Entrada prevista ($), para planificar por adelantado', { type: 'number', step: '0.01', ph: 'la de la señal' })}</div>
          <details class="raw"><summary>Planificar a mano, sin señal guardada</summary><div class="fields">${field('exit.plan', 'manual', 'Usar estos datos', { type: 'checkbox' })}${field('exit.plan', 'symbol', 'Valor', { def: S.sym })}${field('exit.plan', 'or_high', 'Máximo del rango ($)', { type: 'number', step: '0.01' })}${field('exit.plan', 'or_low', 'Mínimo del rango ($)', { type: 'number', step: '0.01' })}${field('exit.plan', 'time', 'Hora de entrada (NY)', { type: 'time' })}</div></details>
          <div class="actions">${btn('Escribir el plan')}</div></form>` + failure('exit.plan') + raw('exit.plan')) + out + (j && j.json ? english : '');
  };

  V.maquina = () => {
    const D = day(), p = D.plan, tm = D.tm;
    let out = '';
    if (tm) {
      const m = tm.mc, hs = tm.history, pc = (x) => num(100 * x, 1) + ' %';
      out = card('Veredicto', `<p class="verdict">${h(tm.verdict)}</p>${(tm.verdict_notes || []).map((n) => `<p>${h(n)}</p>`).join('')}
        <div class="odds" role="img" aria-label="Reparto de resultados"><span class="t" style="width:${100 * m.p_target}%"></span><span class="s" style="width:${100 * m.p_stop}%"></span><span class="n" style="width:${100 * m.p_neither}%"></span></div>
        <div class="kpis">
          <div class="kpi"><span class="kpi-label"><span class="dot on"></span> Objetivo primero</span><span class="kpi-value">${pc(m.p_target)}</span></div>
          <div class="kpi"><span class="kpi-label"><span class="dot bad"></span> Stop primero</span><span class="kpi-value">${pc(m.p_stop)}</span></div>
          <div class="kpi"><span class="kpi-label"><span class="dot off"></span> Ninguno</span><span class="kpi-value">${pc(m.p_neither)}</span><span class="kpi-note">seguía abierta a las ${h(m.until)}</span></div>
          <div class="kpi"><span class="kpi-label">En verde</span><span class="kpi-value">${pc(m.p_green)}</span><span class="kpi-note">objetivo, o por encima de la entrada a las ${h(m.until)}</span></div>
          <div class="kpi"><span class="kpi-label">R medio</span><span class="kpi-value">${(m.avg_R > 0 ? '+' : '') + num(m.avg_R, 3)}</span><span class="kpi-note">+${num(m.r_at_target, 1)}R en el objetivo, −1R en el stop</span></div>
        </div>
        <p class="small muted">${m.replays.toLocaleString('es-ES')} repeticiones del resto de la sesión (${m.bars_left} velas de 5 minutos), semilla ${m.seed}. Misma semilla, mismos números. Construido con las ${m.pool_sessions} sesiones completas de ${h(tm.plan.symbol)} entre ${h(m.pool_from)} y ${h(m.pool_to)}.</p>
        <div class="note warn">Es una simulación hecha con las últimas sesiones del propio valor, no una predicción. Resultados, noticias y suspensiones pueden hacer cosas que esas sesiones nunca hicieron.</div>`) +
        card('Abanico de precios hasta la salida', '<div class="chart" data-fan="1"></div>') +
        card(`Precio a las ${m.until}`, `<p>Mediana ${usd(m.median_close)}; 9 de cada 10 repeticiones entre ${usd(m.p5_close)} y ${usd(m.p95_close)}.</p><div class="chart" data-hist="1"></div>`) +
        card('Lo que pasó de verdad', `<p>La misma regla en ${hs.sessions} sesiones reales saltó ${hs.triggered} veces: <strong>${hs.target} objetivo, ${hs.stop} stop, ${hs.close} ninguno</strong>. R medio ${(hs.avg_R > 0 ? '+' : '') + num(hs.avg_R, 3)}.</p>` +
          `<details class="raw"><summary>Ver las ${hs.trades.length} veces</summary>${table([['Fecha'], ['Hora'], ['Entrada', 1], ['Stop', 1], ['Objetivo', 1], ['Resultado'], ['R', 1]], hs.trades.map((t) =>
            `<tr><td>${h(t.date)}</td><td>${h(t.time)}</td><td class="r">${num(t.entry)}</td><td class="r">${num(t.stop)}</td><td class="r">${num(t.target)}</td><td>${tag(t.outcome === 'target' ? 'objetivo' : t.outcome === 'stop' ? 'stop' : 'ninguno', t.outcome === 'target' ? 'ok' : t.outcome === 'stop' ? 'bad' : '')}</td><td class="r">${num(t.R, 2)}</td></tr>`))}</details>`) +
        `<div class="note">Si después de esto sigues queriendo la operación: ${go('presupuesto', 'calcula el tamaño')}.</div>` + english;
    }
    return head('Máquina del tiempo', 'trader-timemachine', 'Antes de arriesgar un dólar: si hoy se parece a las últimas 60 sesiones del valor, ¿cuántas veces llega antes al objetivo, al stop o a ninguno? 10.000 repeticiones y el historial real de la misma regla.') +
      card('Repetir el plan', (p ? `<p>${h(p.symbol)}: entrada ${usd(p.entry)}, stop ${usd(p.stop)}, objetivo ${usd(p.target)} (${num(p.target_r, 1)}R).</p>` : `<p class="muted">No hay plan para hoy. ${go('salida', 'Escribe uno primero')}.</p>`) +
        `<form data-form="tm.run"><div class="fields">${field('tm.run', 'replays', 'Repeticiones', { type: 'number', def: 10000 })}${field('tm.run', 'seed', 'Semilla', { type: 'number', def: 19 })}${field('tm.run', 'window', 'Ventana horaria (± velas)', { type: 'number', def: 2 })}${field('tm.run', 'until', 'Terminar a las (NY)', { type: 'time', def: (p && p.flat_by) || '15:55' })}</div>
        <div class="actions">${btn('Ejecutar la simulación')}</div></form>` + failure('tm.run') + raw('tm.run')) + out;
  };

  V.presupuesto = () => {
    const j = S.res['budget.size'], d = j && j.json, s = d && d.sizing, D = day(), c = cfg();
    const NAMES = { 'max loss': 'Pérdida máxima por operación', 'position cap': 'Tope por posición', 'max order': 'Orden máxima', cash: 'Efectivo disponible' };
    let out = '';
    if (s) {
      out = card(`Tamaño para ${s.symbol}`, (s.refusal ? `<div class="note bad"><strong>Sin orden.</strong> ${h(s.refusal)}</div>` : `<div class="kpis">
          <div class="kpi"><span class="kpi-label">Títulos</span><span class="kpi-value">${num(s.qty, 0)}</span><span class="kpi-note">lo decide: ${h(NAMES[s.bound_by] || s.bound_by)}</span></div>
          <div class="kpi"><span class="kpi-label">Importe</span><span class="kpi-value">${usd(s.cost)}</span><span class="kpi-note">a ${usd(s.entry)} (${s.entry_from === 'plan' ? 'entrada del plan' : h(s.entry_from)})</span></div>
          <div class="kpi"><span class="kpi-label">Pérdida máxima en el stop</span><span class="kpi-value">${usd(s.max_loss)}</span><span class="kpi-note">límite ${usd(s.max_loss_per_trade_usd, 0)}</span></div></div>`) +
        table([['Límite'], ['Cálculo'], ['Títulos', 1]], (s.limits || []).map((l) => `<tr${l.binds ? ' class="hl"' : ''}><td>${h(NAMES[l.name] || l.name)}${l.binds ? ' ' + tag('decide', 'info') : ''}</td><td>${h(l.how)}</td><td class="r">${num(l.shares, 0)}</td></tr>`)) +
        (d.notes || []).map((n) => `<div class="note warn">${h(n)}</div>`).join('') +
        (d.orders && d.orders.length ? `<p class="small muted">Orden propuesta, con la forma exacta de <span class="mono">place_stock_order</span> de Alpaca. No se ha enviado nada.</p><pre>${h(JSON.stringify(d.orders[0], null, 2))}</pre><div class="note">Una orden stop es una orden, no una promesa: en un mercado rápido puede ejecutarse por debajo. Siguiente: ${go('riesgo', 'pásala por el control de riesgo')}.</div>` : '') + english);
    } else if (D.orders.length) out = card('Orden propuesta en trader/orders.json', `<pre>${h(JSON.stringify(D.orders, null, 2))}</pre>`);
    const w = S.res['budget.weights'];
    return head('Presupuesto y tamaño', 'trader-budget', 'Convierte el plan en una orden exacta dentro de tus reglas. El stop decide el tamaño: cuanto más lejos, menos títulos. Un stop demasiado lejano para tu pérdida máxima es una negativa, no una orden más pequeña.') +
      card('Calcular el tamaño', (D.plan ? `<p>${h(D.plan.symbol)}: riesgo de ${usd(D.plan.risk_per_share)} por título. Presupuesto ${usd(c.budget, 0)}, pérdida máxima por operación ${usd(c.max_loss_per_trade_usd, 0)}.</p>` : `<p class="muted">No hay plan para hoy. ${go('salida', 'Escribe uno primero')}.</p>`) +
        `<form data-form="budget.size"><div class="fields">${field('budget.size', 'type', 'Tipo de orden', { options: [['market', 'A mercado'], ['limit', 'Limitada']] })}${field('budget.size', 'limit_price', 'Precio límite ($)', { type: 'number', step: '0.01', ph: 'la entrada del plan' })}${field('budget.size', 'budget', 'Otro presupuesto ($)', { type: 'number', ph: 'el de mis reglas' })}</div>
        <div class="actions">${btn('Calcular y proponer la orden')}</div></form>` + failure('budget.size') + raw('budget.size')) + out +
      card('Repartir un presupuesto por pesos (cartera a largo plazo)', `<form data-form="budget.weights"><div class="fields">${field('budget.weights', 'weights', 'Pesos', { ph: 'AAPL=40, KO=35, BAC=25' })}${field('budget.weights', 'budget', 'Presupuesto ($)', { type: 'number', ph: 'el de mis reglas' })}</div>${field('budget.weights', 'whole_shares', 'Solo títulos enteros (necesita precios: pídelos en Alertas)', { type: 'checkbox' })}
        <div class="actions">${btn('Repartir', { plain: true })}</div></form><p class="small muted">Son compras sin stop: el control de riesgo las bloquea mientras «exigir stop» esté activo.</p>${failure('budget.weights')}${w && w.stdout ? `<pre>${h(w.stdout)}</pre>` : ''}`);
  };

  V.riesgo = () => {
    const j = S.res['risk.check'], d = (j && j.json) || day().risk, D = day();
    let out = '';
    if (d && d.results) {
      out = card(`Resultado a las ${h((d.now_new_york || '').slice(11))} de Nueva York`, d.results.map((r) =>
        `<div class="note ${r.verdict === 'PASS' ? 'ok' : 'bad'}"><strong>${r.verdict === 'PASS' ? 'PASA' : 'BLOQUEADA'}</strong> · orden ${r.index}: ${r.side === 'buy' ? 'comprar' : 'vender'} ${h(r.amount)} de ${h(r.symbol)} (${r.kind === 'entry' ? 'entrada' : 'salida'})</div>` +
        `<ul class="plain">${(r.info || []).map((x) => `<li>${h(x)}</li>`).join('')}${(r.reasons || []).map((x) => `<li class="neg"><strong>Motivo:</strong> ${h(x)}</li>`).join('')}${(r.warnings || []).map((x) => `<li><strong>Aviso:</strong> ${h(x)}</li>`).join('')}</ul>`).join('') +
        (d.warnings || []).map((w) => `<div class="note warn">${h(w)}</div>`).join('') +
        `<p>${d.pass} pasan, ${d.block} bloqueadas. Efectivo tras las órdenes que pasan: ${usd(d.cash_after)} (${d.paper ? 'cuenta de papel' : 'cuenta REAL'}).</p>` +
        `<div class="note">${d.block ? 'Un bloqueo es definitivo para esa orden. Arreglos posibles: menos títulos, un stop más cercano, esperar a la ventana o dejar pasar la operación. Los límites solo los cambias tú.' : `Un PASA solo significa que la orden puede enseñarse. No es un sí. ${go('broker', 'Ver el ticket')}.`}</div>` + english);
    }
    return head('Control de riesgo', 'trader-risk', 'La puerta entre una propuesta y el bróker. Comprueba cada orden contra tus límites: stop obligatorio, pérdida por operación, beneficio:riesgo, pérdida diaria, operaciones por día y ventana de entradas. Salir nunca se bloquea por un límite diario.') +
      card('Comprobar', (D.orders.length ? `<p>${D.orders.length} orden(es) en <span class="mono">trader/orders.json</span>: ${D.orders.map((o) => `${o.side === 'buy' ? 'comprar' : 'vender'} ${h(o.qty || o.notional)} ${h(o.symbol)}`).join(', ')}.</p>` : `<p class="muted">No hay orden propuesta. ${go('presupuesto', 'Calcula el tamaño primero')}.</p>`) +
        `<div class="actions"><button type="button" class="primary" data-riskcheck="1">Refrescar el precio y comprobar</button><button type="button" data-run="risk.check" data-params='{"no_write":true}'>Mirar sin registrar</button></div>
        <p class="small muted">Si el precio ha subido desde el plan, el riesgo se mide desde el precio nuevo. Si la orden cambia en algo, hay que comprobarla otra vez.</p>` + failure('risk.check') + raw('risk.check')) + out;
  };

  V.broker = () => {
    const j = S.res['broker.show'], tickets = j && Array.isArray(j.json) ? j.json : null, D = day(), c = cfg();
    let out = '';
    if (tickets) {
      out = tickets.map((t) => {
        const approved = /^APPROVED/.test(t.status), sym = t.tool_input.symbol;
        return card(`Orden ${t.index} · ${t.paper ? 'cuenta de PAPEL' : 'cuenta REAL'} · ${h(t.broker)}`,
          `<p><strong>${h(t.plain.split(' / ')[0])}</strong></p><ul class="plain">${t.plain.split(' / ').slice(1).map((x) => `<li>${h(x)}</li>`).join('')}${t.why ? `<li class="muted">${h(t.why)}</li>` : ''}</ul>
          <p>${tag(t.ready ? 'LISTA' : approved ? 'APROBADA' : 'NO LISTA', t.ready ? 'ok' : approved ? 'info' : 'warn')} ${h(t.status)}</p>
          <p class="small muted">JSON exacto para <span class="mono">${h(t.tool)}</span>:</p><pre>${h(JSON.stringify(t.tool_input, null, 2))}</pre>` +
          (t.ready ? `<form data-form="broker.approve" data-index="${t.index}"><div class="fields">${field('broker.approve', 'reply' + t.index, '¿Colocar esta orden? Escribe yes o no', { ph: 'yes' })}</div><div class="actions">${btn('Registrar mi respuesta')}</div></form><p class="small muted">Una respuesta vale para una orden, nunca para el lote. El skill solo acepta un «yes» explícito.</p>` : '') +
          (approved ? `<div class="note info">Tu sí está registrado. Esta aplicación no envía órdenes. Tienes dos caminos:</div>
            <div class="grid2"><div><h3>Simular la ejecución en papel</h3><p class="small muted">Lee una cotización de ${h(sym)} y la registra como ejecutada aquí, en local. No sale nada de este ordenador.</p><div class="actions"><button type="button" class="primary" data-run="broker.simulate" data-params='{"index":${t.index}}'>Simular ejecución</button></div></div>
            <div><h3>Registrar lo que hizo tu bróker</h3><p class="small muted">Si colocaste la orden con Claude y Alpaca (<span class="mono">/trader-broker</span>), apunta aquí el resultado.</p>
            <form data-form="broker.result" data-index="${t.index}"><div class="fields">${field('broker.result', 'status', 'Resultado', { options: [['placed', 'Colocada'], ['denied', 'Denegada'], ['failed', 'Falló']] })}${field('broker.result', 'broker_id', 'Id. del bróker')}${field('broker.result', 'filled_qty', 'Títulos ejecutados', { type: 'number', def: t.tool_input.qty || '' })}${field('broker.result', 'filled_price', 'Precio de ejecución ($)', { type: 'number', step: '0.01' })}</div><div class="actions">${btn('Registrar', { plain: true })}</div></form></div></div>` : '') +
          (!t.ready && !approved ? `<p>${go('riesgo', 'Vuelve al control de riesgo')}: solo se enseña al usuario una orden que ha pasado hoy.</p>` : ''));
      }).join('') + english;
    }
    const pos = D.positions;
    return head('Bróker: ticket y decisión', 'trader-broker', 'El paso más estricto. Una orden solo llega al mercado tras tres puertas: el control de riesgo la ha pasado hoy, tú has escrito un sí para esa orden y has pulsado «Permitir una vez» en la tarjeta de Claude. Esta aplicación cubre las dos primeras y no envía nada.') +
      card('Tickets', `<div class="actions"><button type="button" class="primary" data-run="broker.show">Ver los tickets</button></div>${!D.orders.length ? '<p class="muted">No hay órdenes propuestas.</p>' : ''}` + failure('broker.show') + failure('broker.approve') + failure('broker.result') + failure('broker.simulate') +
        (S.res['broker.approve'] && S.res['broker.approve'].stdout ? `<pre>${h(S.res['broker.approve'].stdout)}</pre>` : '') + raw('broker.simulate')) + out +
      card('Mientras está abierta y al cierre', (pos.length ? table([['Valor'], ['Títulos', 1], ['']], pos.map((p) => `<tr><td><strong>${h(p.ticker)}</strong></td><td class="r">${num(p.shares, 0)}</td><td><button type="button" data-flatten="${h(p.ticker)}">Preparar venta de cierre</button></td></tr>`)) : '<p class="muted">Sin posiciones abiertas.</p>') +
        `<p class="small muted">«Preparar venta de cierre» escribe una venta a mercado, la pasa por el control de riesgo y te la enseña como ticket. Antes de las ${h(c.flat_by || '15:55')} de Nueva York no debe quedar nada abierto.</p>
        <details class="raw"><summary>Apuntar una ejecución a mano (el stop o el objetivo saltaron en el bróker)</summary><form data-form="broker.fill"><div class="fields">${field('broker.fill', 'symbol', 'Valor', { def: pos[0] ? pos[0].ticker : '' })}${field('broker.fill', 'side', 'Lado', { def: 'sell', options: [['sell', 'Venta'], ['buy', 'Compra']] })}${field('broker.fill', 'qty', 'Títulos', { type: 'number', def: pos[0] ? pos[0].shares : '' })}${field('broker.fill', 'price', 'Precio ($)', { type: 'number', step: '0.01', def: D.plan ? D.plan.stop : '' })}</div><div class="actions">${btn('Apuntar ejecución', { plain: true })}</div></form></details>` + failure('broker.fill') + failure('broker.flatten')) +
      card('Conectar un bróker de verdad', `<p>La conexión se hace en Claude, no aquí. Con Alpaca: su servidor MCP oficial en Claude Desktop, cuenta de papel por defecto, las claves en el fichero de configuración y nunca en el chat, y <span class="mono">place_stock_order</span> en «Necesita aprobación». Los pasos están en <span class="mono">.claude/skills/trader-broker/SKILL.md</span>; después pide <span class="mono">/trader-broker</span> en Claude y pega el JSON del ticket.</p><p class="small muted">Bróker configurado: ${h(c.broker || 'alpaca')} · ${c.paper === false ? 'REAL' : 'papel'}. Pasar de papel a real es una decisión que tomas tú, a mano, en <span class="mono">trader/config.json</span>.</p>`) +
      (D.log.length ? card('Registro de hoy', table([['Hora'], ['Estado'], ['Detalle']], D.log.map((o) => `<tr><td>${h((o.at || '').slice(11, 16))}</td><td>${tag(o.status)}</td><td>${h(o.plain || `${o.side || ''} ${o.qty || ''} ${o.symbol || ''} ${o.price ? 'a ' + o.price : ''}`)}${o.reply ? ` · respuesta «${h(o.reply)}»` : ''}${o.broker_order_id ? ` · id ${h(o.broker_order_id)}` : ''}</td></tr>`))) : '');
  };

  V.alertas = () => {
    const st = S.st, m = st.market || {}, f = F(), D = day(), j = S.res['alerts.check'], d = j && j.json;
    const all = (f.alerts || {}).rules || [], rung = (f.state.alerts || {}).rung || {};
    const TYPES = { stop: 'Stop', target: 'Objetivo', above: 'Por encima de', below: 'Por debajo de', pct_move: 'Movimiento de', time: 'Hora', opening_bell: 'Campana de apertura' };
    const kind = fv('alerts.add', 'kind', 'above');
    const prices = (f.prices || {}).prices || {}, det = (f.prices || {}).detail || {};
    return head('Alertas de precio', 'trader-alerts', 'Vigila los números por ti: el stop, el objetivo, la hora de salida, un movimiento porcentual o la campana de apertura. Una alerta es información, nunca una orden: cuando suena el stop, este skill no vende nada.') +
      `<div class="kpis"><div class="kpi"><span class="kpi-label">Nueva York</span><span class="kpi-value">${h((m.now_new_york || '').slice(11))}</span><span class="kpi-note">${h(m.weekday || '')} ${h(m.date || '')}</span></div>
        <div class="kpi"><span class="kpi-label">Bolsa</span><span class="kpi-value">${m.open ? 'Abierta' : 'Cerrada'}</span><span class="kpi-note">${h(m.reason || '')}</span></div>
        <div class="kpi"><span class="kpi-label">Sesión de hoy</span><span class="kpi-value">${m.opens ? h(m.opens) + ' – ' + h(m.closes) : '–'}</span><span class="kpi-note">${m.early_close ? 'cierre adelantado' : m.next_open ? 'próxima apertura ' + h(m.next_open) : ''}</span></div></div>` +
      card('Comprobar ahora', `<div class="actions"><button type="button" class="primary" data-run="alerts.check">Comprobar las alertas</button>${st.mode === 'demo' ? '' : `<label class="check"><input type="checkbox" id="auto"${S.auto ? ' checked' : ''}> Repetir cada 5 minutos mientras esta página esté abierta</label>`}</div>` +
        (d ? (d.rings.length ? d.rings.map((r) => `<div class="note warn"><strong>ALERTA</strong> ${h(r.message)}</div>`).join('') : `<p class="muted">Nada ha saltado.${Object.keys(d.quotes || {}).length ? ' ' + Object.entries(d.quotes).map(([s, p]) => `${h(s)} ${usd(p)}`).join(', ') + '.' : ''}</p>`) + (d.errors || []).map((e) => `<div class="note bad">${h(e)}</div>`).join('') : '') +
        '<p class="small muted">Cada comprobación lee la última cotización con retraso; un precio puede cruzar un nivel entre dos comprobaciones. Si suena el stop o el objetivo, lo más probable es que la orden del bróker ya se haya ejecutado: compruébalo y apúntalo en Bróker.</p>' + failure('alerts.check') + raw('alerts.check')) +
      card(`Alertas (${all.length})`, (all.length ? table([['Id'], ['Valor'], ['Tipo'], ['Nivel'], ['Día'], ['Estado'], ['']], all.map((r) =>
        `<tr><td class="mono">${h(r.id)}</td><td>${h(r.symbol || '–')}</td><td>${h(TYPES[r.type] || r.type)}</td><td>${r.price != null ? usd(r.price) : r.pct != null ? num(r.pct, 1) + ' %' : h(r.at || '')}${r.note ? `<br><span class="small muted">${h(r.note)}</span>` : ''}${r.label ? `<br><span class="small muted">${h(r.label)}</span>` : ''}</td><td>${h(r.date || 'todos')}</td><td>${rung[r.id] ? tag('sonó', 'warn') : (!r.date || r.date === D.d ? tag('vigilando', 'ok') : tag('otro día'))}</td><td>${rung[r.id] ? `<button type="button" data-run="alerts.reset" data-params='${h(JSON.stringify({ id: r.id }))}'>Rearmar</button>` : ''}</td></tr>`)) : '<p class="muted">Sin alertas todavía.</p>') +
        `<div class="actions"><button type="button" data-run="alerts.add" data-params='{"kind":"from_plan"}'${D.plan ? '' : ' disabled title="No hay plan"'}>Stop, objetivo y hora de salida del plan</button><button type="button" data-run="alerts.add" data-params='{"kind":"opening_bell"}'>Campana de apertura</button></div>` + failure('alerts.add') + failure('alerts.reset')) +
      card('Nueva alerta', `<form data-form="alerts.add"><div class="fields">${field('alerts.add', 'kind', 'Tipo', { def: kind, options: [['above', 'Precio por encima de'], ['below', 'Precio por debajo de'], ['stop', 'Stop'], ['target', 'Objetivo'], ['pct', 'Movimiento % desde el cierre anterior'], ['time', 'A una hora (NY)']] })}
          ${kind === 'time' ? field('alerts.add', 'at', 'Hora', { type: 'time', def: '15:55' }) + field('alerts.add', 'label', 'Texto', { def: 'cerrar posiciones' }) : field('alerts.add', 'value', kind === 'pct' ? 'Porcentaje' : 'Precio ($)', { type: 'number', step: '0.01' })}
          ${field('alerts.add', 'symbol', kind === 'time' ? 'Valor (opcional)' : 'Valor', { def: S.sym })}${field('alerts.add', 'date', 'Solo este día', { type: 'date' })}</div>
          ${kind === 'time' ? field('alerts.add', 'before_close', 'Adelantar 3 horas los días de cierre a las 13:00', { type: 'checkbox' }) : kind === 'pct' ? '' : field('alerts.add', 'rearm', 'Rearmar sola cuando el precio vuelva a cruzar', { type: 'checkbox' })}
          <div class="actions">${btn('Añadir alerta', { plain: true })}</div></form>`) +
      card('Cotizaciones', `<form data-form="alerts.quote"><div class="fields">${field('alerts.quote', 'symbols', 'Valores', { def: S.sym, ph: 'TSLA KO' })}</div>${field('alerts.quote', 'holdings', 'Añadir mis posiciones y el valor del plan', { type: 'checkbox', def: true })}<div class="actions">${btn('Pedir precios', { plain: true })}</div></form>` +
        (Object.keys(prices).length ? table([['Valor'], ['Precio', 1], ['Cierre anterior', 1], ['Hora del precio']], Object.keys(prices).sort().map((s) => `<tr><td><strong>${h(s)}</strong></td><td class="r">${usd(prices[s])}</td><td class="r">${usd((det[s] || {}).prev_close)}</td><td>${h((det[s] || {}).time || '')}</td></tr>`)) : '') +
        '<p class="small muted">Precios gratuitos, con retraso y no oficiales: sirven para alertas y para comprobar un tamaño, no para afinar una orden. El precio que cuenta es el de tu bróker. El control de riesgo solo usa precios de menos de 15 minutos.</p>' + failure('alerts.quote') + raw('alerts.quote'));
  };

  V.reglas = () => {
    const c = cfg(), st = S.st, f = (n, l, o) => field('config', n, l, Object.assign({ def: c[n] == null ? '' : c[n] }, o || {}));
    const yn = (v) => (v ? 'sí' : 'no');
    return head('Mis reglas', null, 'Los límites que usan todos los skills. Se fijan una vez, con calma y fuera del horario de mercado. Solo dinero que puedas permitirte perder.') +
      (st.config_from_example ? '<div class="note warn">Estos son los valores de ejemplo del skill. Revísalos y guárdalos antes de calcular ningún tamaño.</div>' : '') +
      card('Límites', `<form data-form="config"><h3>Dinero</h3><div class="fields">${f('budget', 'Presupuesto ($)', { type: 'number' })}${f('cash_buffer_pct', 'Siempre en efectivo (%)', { type: 'number' })}${f('max_position_pct', 'Tope por posición (%)', { type: 'number' })}${f('max_order_usd', 'Orden máxima ($)', { type: 'number' })}${f('min_order_usd', 'Orden mínima ($)', { type: 'number' })}</div>
        <h3>Riesgo</h3><div class="fields">${f('max_loss_per_trade_usd', 'Pérdida máxima por operación ($)', { type: 'number' })}${f('max_daily_loss_usd', 'Pérdida máxima diaria ($)', { type: 'number' })}${f('max_trades_per_day', 'Operaciones por día', { type: 'number' })}${f('max_orders_per_day', 'Órdenes por día', { type: 'number' })}${f('min_reward_risk', 'Beneficio:riesgo mínimo', { type: 'number', step: '0.1' })}</div>
        <h3>Horario (Nueva York)</h3><div class="fields">${f('no_entries_before', 'Sin entradas antes de', { type: 'time' })}${f('no_entries_after', 'Sin entradas después de', { type: 'time' })}${f('flat_by', 'Todo cerrado antes de', { type: 'time' })}</div>
        <h3>Otros</h3><div class="fields">${field('config', 'blocked', 'Valores que nunca opero', { def: (c.blocked || []).join(', '), ph: 'GME, AMC' })}${f('broker', 'Bróker', { options: [['alpaca', 'Alpaca'], ['ibkr', 'Interactive Brokers']] })}${field('config', 'sec_user_agent', 'Identificación para la SEC (nombre y correo)', { def: c.sec_user_agent || '', ph: 'Nombre Apellido correo@ejemplo.com' })}</div>
        ${field('config', 'require_stop', 'Exigir un stop en cada entrada', { type: 'checkbox', def: c.require_stop !== false })}${field('config', 'pdt_guard', 'Vigilar la regla de pattern day trader (si tu bróker aún la aplica)', { type: 'checkbox', def: !!c.pdt_guard })}${field('config', 'fractional', 'Permitir fracciones en el reparto por pesos', { type: 'checkbox', def: !!c.fractional })}
        <div class="actions">${btn('Guardar mis reglas')}</div></form>
        <p class="small muted">La SEC pide que cada cliente automático se identifique con un nombre y un correo reales; ese dato solo se envía a sec.gov cuando usas Noticias o Analista.</p>`) +
      card('Lo que no se cambia desde aquí', `<dl class="dl"><dt>Cuenta</dt><dd>${c.paper === false ? 'REAL' : 'de papel'}</dd><dt>Opciones</dt><dd>${yn(c.allow_options)}</dd><dt>Margen</dt><dd>${yn(c.allow_margin)}</dd><dt>Ventas en corto</dt><dd>${yn(c.allow_short)}</dd></dl><p class="small muted">Pasar a cuenta real o abrir opciones, margen o cortos es una decisión tuya que se toma editando a mano <span class="mono">${h(st.workspace)}/config.json</span>.</p>`) +
      card('Mantenimiento', `<div class="actions"><button type="button" data-reset="day">Empezar un día nuevo</button>${st.mode === 'demo' ? '<button type="button" class="danger" data-reset="demo">Reiniciar la demostración</button>' : ''}</div><p class="small muted">«Día nuevo» borra la señal, el plan, la simulación y la orden propuesta. Conserva tus reglas, la cartera, las alertas y el registro. Los datos están en <span class="mono">${h(st.workspace)}</span>.</p>`);
  };

  // ---------------------------------------------------------------- pintar
  function paint() {
    if (!S.st) return;
    const st = S.st, m = st.market || {}, demo = st.mode === 'demo', dots = Object.fromEntries(pipeline().map((p) => [p[0], p[1]]));
    $('#tools').innerHTML = `<div class="clock"><span class="dot ${m.open ? 'on' : 'off'}"></span><span>${h((m.now_new_york || '').slice(0, 16))} NY · ${m.open ? 'abierta' : 'cerrada'}</span></div>` +
      (demo ? `<label class="check small">Reloj <input type="time" id="clock" step="300" value="${h(st.clock)}"></label><button type="button" data-clock="5">+5 min</button><button type="button" data-clock="30">+30 min</button>` : '') +
      `<div class="seg" role="group" aria-label="Modo"><button type="button" data-mode="real" aria-pressed="${!demo}">Real</button><button type="button" data-mode="demo" aria-pressed="${demo}">Demostración</button></div>`;
    $('#banner').innerHTML = (demo ? `<div class="banner"><span><strong>Modo demostración.</strong> Mercado inventado del ${h(st.demo_day)}: las empresas, los precios, los titulares, las cuentas y las personas no existen. Mueve el reloj para avanzar la sesión.</span></div>` : '') +
      (st.missing_skills.length ? `<div class="banner">Faltan skills en .claude/skills: ${h(st.missing_skills.join(', '))}.</div>` : '') +
      (m.error ? `<div class="banner">${h(m.error)}</div>` : '') + (m.calendar_known === false ? '<div class="banner">El calendario de festivos del skill solo cubre 2026 y 2027: comprueba esta fecha en nyse.com.</div>' : '');
    let n = 0;
    $('#nav').innerHTML = VIEWS.map(([id, label, skill]) => {
      const flow = dots[id] !== undefined, sep = id === 'escaner' || id === 'reglas' ? '<div class="sep"></div>' : '';
      if (flow) n += 1;
      return `${sep}<a href="#${id}"${S.view === id ? ' aria-current="page"' : ''}><span class="step">${flow ? n : ''}</span><span>${h(label)}</span>${flow ? `<span class="dot ${dots[id] === 'on' ? 'on' : dots[id] === 'bad' ? 'bad' : dots[id] === 'wait' ? 'wait' : 'off'}"></span>` : '<span></span>'}</a>`;
    }).join('');
    const label = S.busy ? { scanner: 'trader-scanner', news: 'trader-news', analyst: 'trader-analyst', pelosi: 'trader-pelosi', entry: 'trader-entry', exit: 'trader-exit', tm: 'trader-timemachine', budget: 'trader-budget', risk: 'trader-risk', broker: 'trader-broker', alerts: 'trader-alerts' }[S.busy.split('.')[0]] : '';
    $('#view').innerHTML = (S.busy ? `<div class="note info"><span class="spin"></span>Ejecutando ${h(label || S.busy)}…</div>` : '') + (V[S.view] || V.hoy)();
    if (S.busy) document.querySelectorAll('#view button').forEach((b) => { b.disabled = true; });
    drawCharts();
  }

  async function drawCharts() {
    for (const el of document.querySelectorAll('[data-chart]')) {
      const sym = el.dataset.chart, key = sym + '|' + S.st.clock + '|' + S.st.mode;
      try {
        if (!S.chart[key]) S.chart = { [key]: await api('/api/chart/' + encodeURIComponent(sym)) };
        const c = S.chart[key];
        if (!el.isConnected) continue;
        Charts.candles(el, c.bars, Object.assign({ caption: `${sym}, velas de 5 minutos (hora de Nueva York). ${c.source}.` }, levelsFor(sym)));
      } catch (e) { if (el.isConnected) el.innerHTML = `<p class="muted">No se pudo cargar el gráfico: ${h(e.message)}</p>`; }
    }
    const tm = day().tm;
    if (tm) {
      const fan = $('[data-fan]'), hist = $('[data-hist]');
      if (fan) Charts.fan(fan, tm);
      if (hist) Charts.hist(hist, tm);
    }
  }

  // ---------------------------------------------------------------- acciones
  const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== '' && v != null));
  const SUBMIT = {
    'scanner.daily': (v) => run('scanner.daily', clean(v)),
    'scanner.orb': (v) => run('scanner.orb', clean(v)),
    'news.check': (v) => run('news.check', clean(v)),
    'analyst.facts': (v) => run('analyst.facts', clean(v)),
    'pelosi.list': (v, what) => run(what === 'new' ? 'pelosi.new' : 'pelosi.index', clean(Object.assign({ read: false }, v)), { key: 'pelosi.list' }),
    'entry.check': (v, what) => {
      S.sym = String(v.symbol || '').toUpperCase();
      if (what === 'watch') return watch(clean(v));
      return run('entry.check', clean(Object.assign({}, v, { write: what === 'write' })));
    },
    'exit.plan': (v) => {
      const p = clean({ flat_by: v.flat_by, entry: v.entry, manual: v.manual, symbol: v.symbol, or_high: v.or_high, or_low: v.or_low, time: v.time });
      const sk = v.stop_kind || 'or-mid', tk = v.target_kind || '2R';
      const D = day();
      if (!(sk === 'or-mid' && D.entry && D.entry.setup === 'level')) p.stop = ['price', 'pct', 'atr'].includes(sk) ? `${sk}:${v.stop_value || ''}` : sk;
      p.target = tk === 'price' ? `price:${v.target_value || ''}` : tk;
      if (p.manual) p.setup = p.or_high ? 'orb' : 'level';
      return run('exit.plan', p);
    },
    'tm.run': (v) => run('tm.run', clean(v)),
    'budget.size': (v) => run('budget.size', clean({ limit: v.type === 'limit', limit_price: v.type === 'limit' ? v.limit_price : '', budget: v.budget })),
    'budget.weights': (v) => run('budget.weights', clean(v)),
    'broker.approve': (v, what, form) => {
      const i = Number(form.dataset.index), reply = String(v['reply' + i] || '').trim();
      if (/^no\b/i.test(reply)) return chain([['broker.decline', { index: i }, 'broker.approve'], ['broker.show', {}, 'broker.show']]);
      return chain([['broker.approve', { index: i, reply }, 'broker.approve'], ['broker.show', {}, 'broker.show']]);
    },
    'broker.result': (v, what, form) => chain([['broker.result', clean(Object.assign({ index: Number(form.dataset.index) }, v, v.status === 'placed' ? {} : { filled_qty: '', filled_price: '' })), 'broker.result'], ['broker.show', {}, 'broker.show']]),
    'broker.fill': (v) => run('broker.fill', clean(v)),
    'alerts.add': (v) => run('alerts.add', clean(v)),
    'alerts.quote': (v) => run('alerts.quote', clean(v)),
    config: async (v) => {
      try { await api('/api/config', { config: v }); await refresh(); S.f.config = {}; toast('Reglas guardadas.'); }
      catch (e) { toast('No se han guardado: ' + e.message, 9000); }
      paint();
    },
  };

  async function watch(params) {
    try {
      const { job } = await api('/api/run', { action: 'entry.watch', params: Object.assign({ until: cfg().no_entries_after || '15:30' }, params) });
      S.watch = { id: job, out: '', done: false };
      paint();
      for (;;) {
        const j = await api('/api/job/' + job);
        S.watch.out = j.stdout + (j.stderr ? '\n' + j.stderr : '');
        const pre = $('#watchout');
        if (pre) { pre.textContent = S.watch.out || 'Esperando la primera vela…'; pre.scrollTop = pre.scrollHeight; }
        if (j.status !== 'running') {
          S.watch.done = true;
          toast(j.code === 0 ? 'La señal ha saltado: se ha guardado en trader/entry.json.' : 'La vigilancia ha terminado sin señal.', 9000);
          break;
        }
        await sleep(S.st.mode === 'demo' ? 500 : 5000);
      }
      await refresh(); paint();
    } catch (e) { toast(e.message, 9000); }
  }

  async function flatten(sym) {
    S.view = 'broker'; location.hash = 'broker';
    await chain([['broker.flatten', { symbol: sym }, 'broker.flatten'], ['risk.check', {}, 'risk.check'], ['broker.show', {}, 'broker.show']]);
  }
  async function riskCheck() {
    const syms = [...new Set(day().orders.map((o) => o.symbol).filter(Boolean))];
    const steps = [['risk.check', {}, 'risk.check'], ['broker.show', {}, 'broker.show']];
    if (syms.length) steps.unshift(['alerts.quote', { symbols: syms }, 'alerts.quote']);
    await chain(steps);
  }
  async function setMode(mode, clock) {
    try {
      S.st = await api('/api/mode', { mode, clock });
      S.chart = {};
      if (mode !== (S.lastMode || mode)) { S.res = {}; S.watch = null; }
      S.lastMode = mode;
      paint();
      if (mode === 'demo' && clock && ((F().alerts || {}).rules || []).length && !S.busy) {
        const j = await run('alerts.check', {}, { quiet: true });
        for (const r of ((j && j.json && j.json.rings) || [])) toast('ALERTA: ' + r.message, 12000);
        paint();
      }
    } catch (e) { toast(e.message, 9000); }
  }
  const addMin = (hhmm, n) => { const [a, b] = hhmm.split(':').map(Number), t = Math.min(20 * 60, a * 60 + b + n); return String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0'); };

  document.addEventListener('input', (ev) => {
    const form = ev.target.closest('form[data-form]');
    if (!form || !ev.target.name) return;
    const store = (S.f[form.dataset.form] = S.f[form.dataset.form] || {});
    store[ev.target.name] = ev.target.type === 'checkbox' ? ev.target.checked : ev.target.value;
    if (['stop_kind', 'target_kind', 'kind'].includes(ev.target.name)) paint();
  });
  document.addEventListener('change', (ev) => {
    if (ev.target.id === 'clock' && ev.target.value) setMode('demo', ev.target.value);
    if (ev.target.id === 'auto') {
      clearInterval(S.auto); S.auto = null;
      if (ev.target.checked) S.auto = setInterval(async () => {
        if (S.busy) return;
        const j = await run('alerts.check', {}, { quiet: true });
        for (const r of ((j && j.json && j.json.rings) || [])) toast('ALERTA: ' + r.message, 15000);
        if (S.view === 'alertas' || S.view === 'hoy') paint();
      }, 5 * 60 * 1000);
    }
  });
  document.addEventListener('submit', (ev) => {
    const form = ev.target.closest('form[data-form]');
    if (!form) return;
    ev.preventDefault();
    const name = form.dataset.form, vals = {};
    for (const el of form.elements) if (el.name) vals[el.name] = el.type === 'checkbox' ? el.checked : el.value;
    S.f[name] = Object.assign(S.f[name] || {}, vals);
    if (vals.symbol && /^[A-Za-z.]{1,7}$/.test(vals.symbol)) S.sym = vals.symbol.toUpperCase();
    SUBMIT[name](vals, ev.submitter ? ev.submitter.dataset.do : '', form);
  });
  document.addEventListener('click', async (ev) => {
    const b = ev.target.closest('button, a');
    if (!b) return;
    const d = b.dataset;
    if (d.go) { if (d.sym) { S.sym = d.sym; for (const k of ['news.check', 'analyst.facts', 'entry.check', 'alerts.add', 'alerts.quote']) delete (S.f[k] || {})[k === 'entry.check' || k === 'alerts.add' ? 'symbol' : k === 'alerts.quote' ? 'symbols' : 'tickers']; } location.hash = d.go; }
    else if (d.run) {
      const params = d.params ? JSON.parse(d.params) : {};
      if (d.run === 'broker.simulate') await chain([['broker.simulate', params, 'broker.simulate'], ['broker.show', {}, 'broker.show']]);
      else await run(d.run, params);
    } else if (d.riskcheck) riskCheck();
    else if (d.flatten) flatten(d.flatten);
    else if (d.ptr) run('pelosi.fetch', clean({ doc_id: d.ptr, filed: d.filed }));
    else if (d.mode) setMode(d.mode);
    else if (d.clock) setMode('demo', addMin(S.st.clock, Number(d.clock)));
    else if (d.stopwatch && S.watch) api('/api/cancel', { job: S.watch.id });
    else if (d.reset) {
      if (!confirm(d.reset === 'demo' ? '¿Borrar todo lo hecho en la demostración y volver a las 09:00?' : '¿Borrar la señal, el plan, la simulación y la orden propuesta de hoy?')) return;
      try { S.st = await api('/api/reset', { scope: d.reset }); S.res = {}; S.watch = null; S.chart = {}; toast('Hecho.'); } catch (e) { toast(e.message); }
      paint();
    }
  });
  function route() {
    const id = location.hash.slice(1);
    S.view = VIEWS.some((v) => v[0] === id) ? id : 'hoy';
    paint();
    if (S.view === 'broker' && !S.res['broker.show'] && day().orders.length && !S.busy) run('broker.show');
    window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', route);
  setInterval(async () => { if (!S.busy && S.st && S.st.mode === 'real') { try { await refresh(); if (S.view === 'hoy') paint(); else $('#tools .clock') && paintClock(); } catch (e) { /* servidor parado */ } } }, 60000);
  function paintClock() { const m = S.st.market || {}; $('#tools .clock').innerHTML = `<span class="dot ${m.open ? 'on' : 'off'}"></span><span>${h((m.now_new_york || '').slice(0, 16))} NY · ${m.open ? 'abierta' : 'cerrada'}</span>`; }

  refresh().then(() => { S.lastMode = S.st.mode; route(); }).catch((e) => { $('#view').innerHTML = `<div class="note bad">No se puede hablar con el servidor: ${h(e.message)}</div>`; });
})();
