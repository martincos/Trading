/* Interfaz: estado en localStorage, seis vistas y gráficos dibujados a mano. */
(function () {
  'use strict';
  const TC = window.TC;
  const STORE_KEY = 'brujula-cartera-v1';
  const VIEWS = ['resumen', 'posiciones', 'rebalanceo', 'fiscalidad', 'proyeccion', 'datos'];
  const VIEW_NAMES = { resumen: 'Resumen', posiciones: 'Posiciones', rebalanceo: 'Rebalanceo', fiscalidad: 'Fiscalidad', proyeccion: 'Proyección', datos: 'Datos' };
  const TYPE_NAMES = { buy: 'Compra', sell: 'Venta', dividend: 'Dividendo', interest: 'Intereses', deposit: 'Ingreso', withdrawal: 'Retirada', fee: 'Comisión', tax: 'Impuesto' };
  const todayISO = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  // ---------- Formato ----------
  const nf = (opts) => new Intl.NumberFormat('es-ES', Object.assign({ useGrouping: 'always' }, opts));
  const fEur = nf({ style: 'currency', currency: 'EUR' });
  const fEur0 = nf({ style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
  const fPct = nf({ style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const fNum = nf({ maximumFractionDigits: 4 });
  const fCompact = nf({ notation: 'compact', maximumFractionDigits: 1 });
  const eur = (n) => fEur.format(n);
  const eur0 = (n) => fEur0.format(n);
  const pct = (n) => fPct.format(n);
  const sign = (n, fmt) => (n > 0 ? '+' : '') + fmt(n);
  const cls = (n) => (n > 0.005 ? 'pos' : n < -0.005 ? 'neg' : '');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fDate = (iso) => (iso ? iso.split('-').reverse().join('/') : '');
  const $ = (sel) => document.querySelector(sel);

  // ---------- Estado ----------
  const defaults = () => ({
    transactions: [], prices: {}, targets: {}, cashOverride: null, isDemo: false,
    contribution: 500, proj: { monthly: 400, years: 20, ret: 6, cost: 0.2, infl: 2 },
  });
  let state = load();
  let ui = { pending: null, notice: '', confirmWipe: false, taxYear: null, backup: '' };

  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) return Object.assign(defaults(), JSON.parse(raw));
    } catch (e) { /* sin almacenamiento: se trabaja en memoria */ }
    return Object.assign(defaults(), TC.demoData(todayISO()), { isDemo: true });
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { /* idem */ }
  }
  function leaveDemo() {
    if (state.isDemo) state = Object.assign(defaults(), { proj: state.proj, contribution: state.contribution });
  }

  function model() {
    const portfolio = TC.computePortfolio(state.transactions, state.prices, { today: todayISO() });
    const cash = state.cashOverride != null ? state.cashOverride : portfolio.cash;
    return { portfolio, cash, total: portfolio.invested + cash };
  }

  // ---------- Vistas ----------
  function kpi(label, value, note, valueClass) {
    return `<div class="kpi"><span class="kpi-label">${label}</span><span class="kpi-value ${valueClass || ''}">${value}</span>${note ? `<span class="kpi-note">${note}</span>` : ''}</div>`;
  }

  function viewResumen(m) {
    const p = m.portfolio;
    if (!p.positions.length) return emptyState();
    const tips = TC.insights(p, state.transactions, state.targets, m.cash);
    const pills = { alta: 'Prioridad alta', media: 'Conviene revisar', info: 'Sugerencia' };
    const tipsHtml = tips.length ? `<ul class="actions">${tips.map((t) => `<li>
        <div class="action-head"><span class="pill ${t.severity}">${pills[t.severity]}</span><strong>${esc(t.title)}</strong></div>
        <p class="small">${esc(t.detail)} <a href="#${t.view}">Abrir ${VIEW_NAMES[t.view]}</a></p></li>`).join('')}</ul>`
      : '<p class="muted">Nada pendiente con los datos actuales.</p>';
    const top = p.positions.slice(0, 8);
    const rest = p.positions.slice(8);
    const bars = top.map((x) => ({ label: x.name, weight: x.weight, value: x.value, target: targetShare(x.key, p) }));
    if (rest.length) bars.push({ label: `Otros (${rest.length})`, weight: rest.reduce((s, x) => s + x.weight, 0), value: rest.reduce((s, x) => s + x.value, 0), target: null });
    const max = Math.max(...bars.map((b) => Math.max(b.weight, b.target || 0)), 0.01);
    const hasTargets = bars.some((b) => b.target != null);
    const t = p.totals;
    return `
    <section>
      <div class="kpis">
        ${kpi('Valor total', eur0(m.total), `${eur0(p.invested)} invertido + ${eur0(m.cash)} en efectivo`)}
        ${kpi('Plusvalía latente', sign(p.unrealized, eur0), `${sign(p.unrealizedPct, pct)} sobre ${eur0(p.cost)} de coste`, cls(p.unrealized))}
        ${kpi('Rentabilidad anual', p.xirr == null ? '—' : sign(p.xirr, pct), 'Ponderada por tus aportaciones (TIR)', p.xirr == null ? '' : cls(p.xirr))}
        ${kpi('Ya realizado', sign(t.realized + t.dividends + t.interest, eur0), `${eur0(t.dividends + t.interest)} en dividendos e intereses`, cls(t.realized + t.dividends + t.interest))}
        ${kpi('Comisiones pagadas', eur(t.fees), t.buyVolume > 0 ? `${nf({ style: 'percent', maximumFractionDigits: 2 }).format(t.fees / t.buyVolume)} de lo comprado` : '')}
      </div>
    </section>
    <div class="two">
      <section class="panel">
        <h2>Qué hacer ahora</h2>
        ${tipsHtml}
      </section>
      <section class="panel">
        <h2>Reparto de lo invertido</h2>
        ${hasTargets ? '<div class="legend"><span><i class="swatch"></i>Peso actual</span><span><i class="swatch tick"></i>Peso objetivo</span></div>' : ''}
        <div class="bars">${bars.map((b) => `
          <div class="bar-row" data-tip="${esc(b.label)}: ${eur0(b.value)} · ${pct(b.weight)}${b.target != null ? ` · objetivo ${pct(b.target)}` : ''}">
            <span class="bar-label">${esc(b.label)}</span>
            <span class="bar-track"><span class="bar-fill" style="width:${(b.weight / max * 100).toFixed(2)}%"></span>${b.target != null ? `<span class="bar-target" style="left:calc(${(b.target / max * 100).toFixed(2)}% - 1px)"></span>` : ''}</span>
            <span class="bar-value">${pct(b.weight)}</span>
          </div>`).join('')}</div>
      </section>
    </div>`;
  }

  function targetShare(key, p) {
    const keys = p.positions.filter((x) => state.targets[x.key] > 0);
    if (!keys.length) return null;
    const sum = keys.reduce((s, x) => s + state.targets[x.key], 0);
    return (state.targets[key] || 0) / sum;
  }

  function emptyState() {
    return `<section class="panel"><h2>Todavía no hay movimientos</h2>
      <p class="lead">Importa la exportación CSV de tu bróker o añade tus compras a mano para ver la cartera.</p>
      <div class="row"><a class="btn" href="#datos">Importar movimientos</a><button class="btn ghost" data-action="load-demo">Ver cartera de ejemplo</button></div></section>`;
  }

  function viewPosiciones(m) {
    const p = m.portfolio;
    if (!p.positions.length) return emptyState();
    const tSum = p.positions.reduce((s, x) => s + (state.targets[x.key] || 0), 0);
    return `
    <section>
      <h2>Posiciones</h2>
      <p class="lead">Escribe el precio actual de cada valor tal como aparece en tu bróker y, si quieres, el peso que debería tener. Sin precio se usa el del último movimiento.</p>
      <div class="panel table-scroll"><table>
        <thead><tr><th>Valor</th><th>Títulos</th><th>Coste medio</th><th>Precio actual</th><th>Valor</th><th>Plusvalía</th><th>%</th><th>Peso</th><th>Objetivo %</th></tr></thead>
        <tbody>${p.positions.map((x, i) => `<tr>
          <td>${esc(x.name)}<span class="sub">${esc(x.isin || '')}${x.priceSource === 'last' ? ' · precio del último movimiento' : ` · precio del ${fDate(x.priceDate)}`}</span></td>
          <td>${fNum.format(x.shares)}</td><td>${eur(x.avgCost)}</td>
          <td><input id="price-${i}" type="number" min="0" step="any" inputmode="decimal" data-action="price" data-key="${esc(x.key)}" value="${x.priceSource === 'manual' ? x.price : ''}" placeholder="${x.price.toFixed(2)}" aria-label="Precio actual de ${esc(x.name)}"></td>
          <td>${eur(x.value)}</td><td class="${cls(x.pnl)}">${sign(x.pnl, eur)}</td><td class="${cls(x.pnl)}">${sign(x.pnlPct, pct)}</td><td>${pct(x.weight)}</td>
          <td><input id="target-${i}" type="number" min="0" max="100" step="any" inputmode="decimal" data-action="target" data-key="${esc(x.key)}" value="${state.targets[x.key] || ''}" placeholder="—" aria-label="Peso objetivo de ${esc(x.name)}"></td>
        </tr>`).join('')}</tbody>
        <tfoot><tr><td>Total invertido</td><td></td><td></td><td></td><td>${eur(p.invested)}</td><td class="${cls(p.unrealized)}">${sign(p.unrealized, eur)}</td><td class="${cls(p.unrealized)}">${sign(p.unrealizedPct, pct)}</td><td></td><td>${tSum ? fNum.format(tSum) + ' %' : ''}</td></tr></tfoot>
      </table></div>
      ${tSum && Math.abs(tSum - 100) > 0.01 ? `<p class="small muted">Los objetivos suman ${fNum.format(tSum)} %. Se reescalan a 100 % al calcular el rebalanceo.</p>` : ''}
    </section>
    <section>
      <h3>Efectivo</h3>
      <div class="form">
        <label class="field">Efectivo en la cuenta (€)
          <input id="cash-override" type="number" step="any" inputmode="decimal" data-action="cash" value="${state.cashOverride != null ? state.cashOverride : ''}" placeholder="${m.portfolio.cash.toFixed(2)}"></label>
        <p class="small muted" style="max-width:52ch">Calculado a partir de los movimientos: ${eur(p.cash)}. Si no coincide con tu saldo real (por ejemplo, por pagos con tarjeta), escribe aquí el saldo correcto.</p>
      </div>
    </section>`;
  }

  function viewRebalanceo(m) {
    const p = m.portfolio;
    if (!p.positions.length) return emptyState();
    const plan = TC.rebalancePlan(p.positions, state.targets, state.contribution);
    const body = plan.rows.length ? `
      <div class="panel table-scroll"><table>
        <thead><tr><th>Valor</th><th>Peso actual</th><th>Objetivo</th><th>Desviación</th><th>Comprar</th><th>Títulos aprox.</th><th>Peso después</th></tr></thead>
        <tbody>${plan.rows.map((r) => `<tr><td>${esc(r.name)}</td><td>${pct(r.weight)}</td><td>${pct(r.target)}</td>
          <td class="${Math.abs(r.drift) > 0.05 ? 'neg' : ''}">${sign(r.drift * 100, (n) => n.toFixed(1).replace('.', ','))} pp</td>
          <td><strong>${r.buy >= 0.5 ? eur(r.buy) : '—'}</strong></td><td>${r.buy >= 0.5 ? fNum.format(r.sharesApprox) : '—'}</td><td>${pct(r.weightAfter)}</td></tr>`).join('')}</tbody>
        <tfoot><tr><td>Total</td><td></td><td></td><td></td><td>${eur(plan.rows.reduce((s, r) => s + r.buy, 0))}</td><td></td><td></td></tr></tfoot>
      </table></div>
      ${plan.excluded.length ? `<p class="small muted">Sin objetivo y fuera del cálculo: ${plan.excluded.map(esc).join(', ')}.</p>` : ''}`
      : '<div class="panel"><p>Aún no has fijado pesos objetivo. <a href="#posiciones">Ponlos en Posiciones</a> y aquí verás cómo repartir cada aportación.</p></div>';
    return `
    <section>
      <h2>Reparto de la próxima aportación</h2>
      <p class="lead">El dinero nuevo va a los valores que están por debajo de su objetivo. Así corriges la cartera sin vender, y por tanto sin adelantar impuestos ni pagar comisiones de venta.</p>
      <div class="form"><label class="field">Aportación (€)
        <input id="contribution" type="number" min="0" step="50" inputmode="decimal" data-action="contribution" value="${state.contribution}"></label></div>
      ${body}
    </section>`;
  }

  function viewFiscalidad(m) {
    const p = m.portfolio;
    const thisYear = Number(p.today.slice(0, 4));
    const years = [...new Set([thisYear, ...p.realized.map((r) => +r.date.slice(0, 4)), ...p.income.map((r) => +r.date.slice(0, 4))])].sort((a, b) => b - a);
    const year = years.includes(ui.taxYear) ? ui.taxYear : thisYear;
    const s = TC.taxSummary(p, year);
    const harvest = year === thisYear ? TC.harvestCandidates(p, year) : [];
    const wash = TC.washSales(state.transactions, p).filter((w) => +w.date.slice(0, 4) === year);
    return `
    <section>
      <div class="row" style="justify-content:space-between">
        <h2>Estimación del IRPF del ahorro</h2>
        <label class="field">Ejercicio <select id="tax-year" data-action="tax-year">${years.map((y) => `<option${y === year ? ' selected' : ''}>${y}</option>`).join('')}</select></label>
      </div>
      <p class="lead">Cálculo con criterio FIFO y la escala del ahorro española (19 % hasta 6.000 €, 21 % hasta 50.000 €, 23 % hasta 200.000 €, 27 % hasta 300.000 € y 30 % en adelante). No incluye otras rentas del ahorro ni pérdidas pendientes de años anteriores.</p>
      <div class="kpis">
        ${kpi('Ganancias y pérdidas', sign(s.net, eur0), `${eur0(s.gains)} ganado, ${eur0(s.losses)} perdido`, cls(s.net))}
        ${kpi('Dividendos e intereses', eur0(s.incomeGross), 'Importe bruto')}
        ${kpi('Base del ahorro', eur0(s.base), s.carry > 0 ? `${eur0(s.carry)} de pérdidas a compensar en 4 años` : '')}
        ${kpi('IRPF estimado', eur0(s.tax), `${eur0(s.withheld)} ya retenido`)}
        ${kpi('A pagar en la renta', eur0(Math.max(0, s.due)), s.due < 0 ? `${eur0(-s.due)} a tu favor` : 'Estimación')}
      </div>
    </section>
    ${wash.length ? `<section><h3>Pérdidas que pueden no ser deducibles</h3>
      <p class="lead">Regla de los dos meses: si compras el mismo valor en los dos meses anteriores o posteriores a venderlo con pérdidas y lo mantienes, esa pérdida queda aplazada hasta que vendas lo recomprado.</p>
      <div class="panel table-scroll"><table><thead><tr><th>Valor</th><th>Venta</th><th>Pérdida</th><th>Compras cercanas</th></tr></thead>
      <tbody>${wash.map((w) => `<tr><td>${esc(w.name)}</td><td>${fDate(w.date)}</td><td class="neg">${eur(w.gain)}</td><td>${w.rebuys.map(fDate).join(', ')}</td></tr>`).join('')}</tbody></table></div></section>` : ''}
    ${year === thisYear ? `<section><h3>Posiciones en pérdidas que podrías aflorar antes del 31 de diciembre</h3>
      ${harvest.length ? `<p class="lead">Vender en pérdidas reduce la base de este año si tienes ganancias realizadas. Solo compensa si el valor ya no encaja en tu plan o puedes sustituirlo por otro distinto: no lo recompres en dos meses.</p>
      <div class="panel table-scroll"><table><thead><tr><th>Valor</th><th>Valor actual</th><th>Pérdida latente</th><th>Ahorro de IRPF este año</th><th>Aviso</th></tr></thead>
      <tbody>${harvest.map((h) => `<tr><td>${esc(h.name)}</td><td>${eur(h.value)}</td><td class="neg">${eur(h.loss)}</td><td><strong>${eur(h.saving)}</strong></td>
        <td>${h.recentBuy ? `Compra el ${fDate(h.recentBuy)}: afecta la regla de los dos meses` : h.saving < 0.5 ? 'Sin ganancias que compensar: quedaría para años futuros' : '—'}</td></tr>`).join('')}</tbody></table></div>`
        : '<p class="muted">Ninguna posición tiene pérdidas latentes.</p>'}</section>` : ''}
    <section><h3>Ventas de ${year}</h3>
      ${s.ops.length ? `<div class="panel table-scroll"><table><thead><tr><th>Valor</th><th>Fecha</th><th>Títulos</th><th>Importe de venta</th><th>Coste de compra</th><th>Resultado</th></tr></thead>
      <tbody>${s.ops.map((r) => `<tr><td>${esc(r.name)}${r.incomplete ? '<span class="sub">Faltan compras anteriores</span>' : ''}</td><td>${fDate(r.date)}</td><td>${fNum.format(r.shares)}</td><td>${eur(r.proceeds)}</td><td>${eur(r.cost)}</td><td class="${cls(r.gain)}">${sign(r.gain, eur)}</td></tr>`).join('')}</tbody></table></div>`
        : '<p class="muted">Sin ventas en este ejercicio.</p>'}
    </section>`;
  }

  function projData(m) {
    const j = state.proj;
    return TC.projection({ initial: Math.max(0, m.total), monthly: j.monthly, years: j.years, annualReturn: j.ret / 100, annualCost: j.cost / 100, inflation: j.infl / 100 });
  }

  function viewProyeccion(m) {
    const j = state.proj;
    const data = projData(m);
    const end = data[data.length - 1];
    const f = (id, label, key, step, min, max) => `<label class="field">${label}<input id="${id}" type="number" step="${step}" min="${min}" max="${max}" inputmode="decimal" data-action="proj" data-key="${key}" value="${j[key]}"></label>`;
    return `
    <section>
      <h2>Proyección a largo plazo</h2>
      <p class="lead">Parte de tu valor actual (${eur0(Math.max(0, m.total))}). La rentabilidad es una hipótesis tuya, no una previsión: prueba también con cifras bajas.</p>
      <div class="form">
        ${f('proj-monthly', 'Aportación mensual (€)', 'monthly', 50, 0, 100000)}
        ${f('proj-years', 'Años', 'years', 1, 1, 50)}
        ${f('proj-ret', 'Rentabilidad anual (%)', 'ret', 0.5, -10, 20)}
        ${f('proj-cost', 'Costes anuales, TER (%)', 'cost', 0.05, 0, 5)}
        ${f('proj-infl', 'Inflación (%)', 'infl', 0.5, 0, 15)}
      </div>
      <div class="kpis">
        ${kpi(`Valor en ${j.years} años`, eur0(end.value), `${eur0(end.real)} en euros de hoy`)}
        ${kpi('Total aportado', eur0(end.contributed), `${eur0(j.monthly * 12)} al año`)}
        ${kpi('Generado por la inversión', sign(end.value - end.contributed, eur0), '', cls(end.value - end.contributed))}
        ${kpi('Lo que se llevan los costes', eur0(end.noCost - end.value), `Con un ${String(j.cost).replace('.', ',')} % anual`)}
      </div>
      <div class="panel">
        <div class="legend"><span><i class="swatch"></i>Valor proyectado</span><span><i class="swatch s2"></i>Total aportado</span></div>
        <div class="chart" id="proj-chart"></div>
      </div>
    </section>`;
  }

  function viewDatos(m) {
    const txs = state.transactions.slice().sort((a, b) => (a.date < b.date ? 1 : -1));
    return `
    <section>
      <h2>Importar movimientos</h2>
      <p class="lead">Descarga la exportación de transacciones en CSV desde tu bróker y cárgala aquí. El fichero se lee en tu navegador y no se envía a ningún sitio. Puedes volver a importarlo más adelante: los movimientos repetidos se descartan.</p>
      <div class="form">
        <label class="field">Fichero CSV o copia de seguridad<input id="file" type="file" accept=".csv,.txt,.json,text/csv,application/json" data-action="file"></label>
      </div>
      <label class="field">O pega aquí el contenido del CSV<textarea id="paste" placeholder="datetime,type,name,symbol,shares,price,amount,fee,tax…"></textarea></label>
      <div class="row"><button class="btn ghost" data-action="paste">Leer texto pegado</button></div>
      ${ui.notice ? `<p class="banner" role="status">${esc(ui.notice)}</p>` : ''}
      ${ui.pending ? pendingHtml() : ''}
    </section>
    <section>
      <h3>Añadir un movimiento a mano</h3>
      <form class="form" id="manual">
        <label class="field">Fecha<input id="m-date" name="date" type="date" required value="${todayISO()}"></label>
        <label class="field">Tipo<select id="m-type" name="type">${Object.keys(TYPE_NAMES).filter((t) => t !== 'tax').map((t) => `<option value="${t}">${TYPE_NAMES[t]}</option>`).join('')}</select></label>
        <label class="field">Nombre del valor<input id="m-name" name="name" type="text"></label>
        <label class="field">ISIN<input id="m-isin" name="isin" type="text" maxlength="12"></label>
        <label class="field">Títulos<input id="m-shares" name="shares" type="number" step="any" min="0" inputmode="decimal"></label>
        <label class="field">Precio (€)<input id="m-price" name="price" type="number" step="any" min="0" inputmode="decimal"></label>
        <label class="field">Importe (€)<input id="m-amount" name="amount" type="number" step="any" min="0" inputmode="decimal"></label>
        <label class="field">Comisión (€)<input id="m-fee" name="fee" type="number" step="any" min="0" inputmode="decimal"></label>
        <button class="btn" type="submit">Añadir</button>
      </form>
      <p class="small muted">Compras y ventas necesitan títulos y precio. El resto de movimientos, solo el importe.</p>
    </section>
    <section>
      <h3>${state.transactions.length} movimientos guardados${state.isDemo ? ' (ejemplo)' : ''}</h3>
      ${m.portfolio.warnings.map((w) => `<p class="banner">${esc(w)}</p>`).join('')}
      ${txs.length ? `<div class="panel table-scroll" style="max-height:420px;overflow-y:auto"><table>
        <thead><tr><th>Movimiento</th><th>Fecha</th><th>Títulos</th><th>Precio</th><th>Importe</th><th>Comisión</th><th></th></tr></thead>
        <tbody>${txs.slice(0, 200).map((t) => {
          const trade = t.type === 'buy' || t.type === 'sell';
          return `<tr><td>${TYPE_NAMES[t.type]}<span class="sub">${esc(t.name || '')}</span></td><td>${fDate(t.date)}</td><td>${trade ? fNum.format(t.shares) : ''}</td><td>${trade ? eur(t.price) : ''}</td>
          <td>${eur(trade ? t.shares * t.price : t.amount)}</td><td>${t.fee ? eur(t.fee) : ''}</td><td><button class="btn link" data-action="del" data-id="${esc(t.id)}" aria-label="Borrar movimiento del ${fDate(t.date)}">Borrar</button></td></tr>`;
        }).join('')}</tbody></table></div>${txs.length > 200 ? '<p class="small muted">Se muestran los 200 más recientes.</p>' : ''}` : ''}
    </section>
    <section>
      <h3>Copia de seguridad</h3>
      <p class="lead">Los datos viven solo en este navegador. Guarda una copia para llevarlos a otro dispositivo o por si borras los datos de navegación.</p>
      <div class="row">
        <button class="btn ghost" data-action="backup">Generar copia</button>
        <button class="btn ghost" data-action="load-demo">Cargar cartera de ejemplo</button>
        <button class="btn danger" data-action="wipe">${ui.confirmWipe ? 'Pulsa otra vez para borrar todo' : 'Borrar todos los datos'}</button>
      </div>
      ${ui.backup ? `<label class="field">Copia en texto: guárdala en un fichero .json. Para restaurarla, cárgala arriba como fichero o pégala en el cuadro de importación.
        <textarea id="backup-text" readonly>${esc(ui.backup)}</textarea></label>
        <div class="row"><button class="btn ghost" data-action="copy-backup">Copiar</button><button class="btn ghost" data-action="download-backup">Descargar fichero</button></div>` : ''}
    </section>`;
  }

  const MAP_FIELDS = ['date', 'type', 'name', 'isin', 'shares', 'price', 'amount', 'fee', 'tax', 'id'];
  function pendingHtml() {
    const pd = ui.pending;
    const res = TC.normalizeRows(pd.headers, pd.rows, pd.mapping);
    pd.result = res;
    const counts = {};
    res.transactions.forEach((t) => { counts[t.type] = (counts[t.type] || 0) + 1; });
    const reasons = {};
    res.skipped.forEach((s) => { reasons[s.reason] = (reasons[s.reason] || 0) + 1; });
    return `<div class="panel">
      <h3>Comprueba las columnas</h3>
      <p class="small muted">Se han leído ${pd.rows.length} filas. Corrige cualquier columna mal asignada antes de importar.</p>
      <div class="form">${MAP_FIELDS.map((f) => `<label class="field">${TC.FIELD_LABELS[f]}
        <select id="map-${f}" data-action="map" data-field="${f}"><option value="-1">No está en el fichero</option>
        ${pd.headers.map((h, i) => `<option value="${i}"${pd.mapping[f] === i ? ' selected' : ''}>${esc(h || `Columna ${i + 1}`)}</option>`).join('')}</select></label>`).join('')}</div>
      <p><strong>${res.transactions.length} movimientos reconocidos</strong>${res.transactions.length ? ': ' + Object.keys(counts).map((k) => `${counts[k]} × ${TYPE_NAMES[k].toLowerCase()}`).join(', ') : ''}.</p>
      ${res.skipped.length ? `<p class="small muted">${res.skipped.length} filas descartadas: ${Object.keys(reasons).map((r) => `${reasons[r]} por «${r.toLowerCase()}»`).join(', ')}.</p>` : ''}
      <div class="row"><button class="btn" data-action="confirm-import"${res.transactions.length ? '' : ' disabled'}>Importar ${res.transactions.length} movimientos</button>
      <button class="btn ghost" data-action="cancel-import">Cancelar</button></div>
      ${state.isDemo ? '<p class="small muted">Al importar se sustituye la cartera de ejemplo.</p>' : ''}
    </div>`;
  }

  // ---------- Gráfico de líneas ----------
  function niceMax(v) {
    const pow = Math.pow(10, Math.floor(Math.log10(v || 1)));
    for (const k of [1, 2, 2.5, 5, 10]) if (v <= k * pow) return k * pow;
    return 10 * pow;
  }

  function drawProjection(m) {
    const el = $('#proj-chart');
    if (!el) return;
    const data = projData(m);
    const W = Math.max(300, el.clientWidth || 640), H = Math.round(Math.min(320, Math.max(220, W * 0.42)));
    const mg = { l: 76, r: 14, t: 12, b: 26 };
    const maxY = niceMax(Math.max(...data.map((d) => Math.max(d.value, d.contributed)), 1));
    const n = data.length - 1;
    const x = (i) => mg.l + (W - mg.l - mg.r) * (i / n);
    const y = (v) => H - mg.b - (H - mg.t - mg.b) * (Math.max(0, v) / maxY);
    const path = (key) => data.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(d[key]).toFixed(1)}`).join('');
    const year0 = Number(m.portfolio.today.slice(0, 4));
    const stepX = Math.max(1, Math.ceil(n / (W < 480 ? 4 : 8)));
    let g = '';
    for (let k = 0; k <= 4; k++) {
      const v = maxY * k / 4;
      g += `<line x1="${mg.l}" x2="${W - mg.r}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)" stroke-width="1"/><text x="${mg.l - 8}" y="${y(v) + 4}" text-anchor="end">${fCompact.format(v)} €</text>`;
    }
    for (let i = 0; i <= n; i += stepX) g += `<text x="${x(i)}" y="${H - 6}" text-anchor="${i === 0 ? 'start' : i === n ? 'end' : 'middle'}">${year0 + i}</text>`;
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Evolución proyectada del valor de la cartera frente al total aportado">
      ${g}
      <path d="${path('value')}L${x(n)},${y(0)}L${x(0)},${y(0)}Z" fill="var(--series-1)" opacity="0.1"/>
      <path d="${path('contributed')}" fill="none" stroke="var(--series-2)" stroke-width="2" stroke-linejoin="round"/>
      <path d="${path('value')}" fill="none" stroke="var(--series-1)" stroke-width="2" stroke-linejoin="round"/>
      <circle cx="${x(n)}" cy="${y(data[n].value)}" r="4" fill="var(--series-1)" stroke="var(--surface)" stroke-width="2"/>
      <g id="cross" visibility="hidden"><line id="cross-line" y1="${mg.t}" y2="${H - mg.b}" stroke="var(--ink-3)" stroke-width="1"/>
        <circle id="cross-a" r="4" fill="var(--series-1)" stroke="var(--surface)" stroke-width="2"/><circle id="cross-b" r="4" fill="var(--series-2)" stroke="var(--surface)" stroke-width="2"/></g>
      <rect id="hit" x="${mg.l}" y="0" width="${W - mg.l - mg.r}" height="${H}" fill="transparent"/>
    </svg>`;
    const svg = el.querySelector('svg'), cross = svg.querySelector('#cross');
    const move = (ev) => {
      const box = svg.getBoundingClientRect();
      const px = (ev.clientX - box.left) * (W / box.width);
      const i = Math.max(0, Math.min(n, Math.round((px - mg.l) / (W - mg.l - mg.r) * n)));
      const d = data[i];
      cross.setAttribute('visibility', 'visible');
      svg.querySelector('#cross-line').setAttribute('x1', x(i)); svg.querySelector('#cross-line').setAttribute('x2', x(i));
      svg.querySelector('#cross-a').setAttribute('cx', x(i)); svg.querySelector('#cross-a').setAttribute('cy', y(d.value));
      svg.querySelector('#cross-b').setAttribute('cx', x(i)); svg.querySelector('#cross-b').setAttribute('cy', y(d.contributed));
      showTip(`<strong>${year0 + i}</strong><br>Valor proyectado: ${eur0(d.value)}<br>Total aportado: ${eur0(d.contributed)}`, ev.clientX, ev.clientY);
    };
    svg.addEventListener('pointermove', move);
    svg.addEventListener('pointerdown', move);
    svg.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); hideTip(); });
  }

  // ---------- Tooltip ----------
  const tip = $('#tip');
  function showTip(html, cx, cy) {
    tip.innerHTML = html;
    tip.hidden = false;
    const w = tip.offsetWidth, h = tip.offsetHeight;
    tip.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, cx + 14)) + 'px';
    tip.style.top = Math.max(8, cy - h - 12) + 'px';
  }
  function hideTip() { tip.hidden = true; }
  document.addEventListener('pointermove', (ev) => {
    const row = ev.target.closest && ev.target.closest('[data-tip]');
    if (row) showTip(esc(row.dataset.tip), ev.clientX, ev.clientY);
    else if (!ev.target.closest || !ev.target.closest('#proj-chart')) hideTip();
  });

  // ---------- Render ----------
  function currentView() {
    const h = location.hash.replace('#', '');
    return VIEWS.includes(h) ? h : 'resumen';
  }
  function render() {
    const view = currentView();
    const m = model();
    document.querySelectorAll('#tabs a').forEach((a) => {
      if (a.getAttribute('href') === '#' + view) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    $('#banner').innerHTML = state.isDemo
      ? `<div class="banner"><span><strong>Cartera de ejemplo.</strong> Valores, precios y movimientos son inventados para mostrar cómo funciona.</span><a class="btn" href="#datos">Importar mis movimientos</a></div>`
      : (m.portfolio.cash < -1 && state.cashOverride == null && state.transactions.length ? `<div class="banner"><span>El efectivo calculado sale negativo (${eur(m.portfolio.cash)}): faltan ingresos en los movimientos. Indica tu saldo real en <a href="#posiciones">Posiciones</a>.</span></div>` : '');
    const fn = { resumen: viewResumen, posiciones: viewPosiciones, rebalanceo: viewRebalanceo, fiscalidad: viewFiscalidad, proyeccion: viewProyeccion, datos: viewDatos }[view];
    $('#view').innerHTML = fn(m);
    if (view === 'proyeccion') drawProjection(m);
  }

  // ---------- Acciones ----------
  function readText(text, name) {
    const trimmed = text.trim();
    ui.notice = ''; ui.pending = null;
    if (!trimmed) { ui.notice = 'No hay nada que leer: el fichero o el texto están vacíos.'; return render(); }
    if (trimmed[0] === '{') {
      try {
        const data = JSON.parse(trimmed);
        if (!Array.isArray(data.transactions)) throw new Error('formato');
        state = Object.assign(defaults(), data, { isDemo: false });
        save();
        ui.notice = `Copia restaurada: ${state.transactions.length} movimientos.`;
      } catch (e) { ui.notice = 'Ese texto no es una copia de seguridad válida de esta aplicación.'; }
      return render();
    }
    const parsed = TC.parseCSV(trimmed);
    if (parsed.headers.length < 2 || !parsed.rows.length) { ui.notice = 'No se reconocen columnas en ese texto. Comprueba que es un CSV con una fila de cabecera.'; return render(); }
    ui.pending = { headers: parsed.headers, rows: parsed.rows, mapping: TC.autoMap(parsed.headers), name };
    render();
  }

  function act(action, el) {
    const key = el.dataset.key;
    const val = el.value === '' || el.value == null ? null : Number(el.value);
    switch (action) {
      case 'price':
        if (val > 0) state.prices[key] = { price: val, date: todayISO() }; else delete state.prices[key];
        break;
      case 'target':
        if (val > 0) state.targets[key] = Math.min(100, val); else delete state.targets[key];
        break;
      case 'cash': state.cashOverride = val == null || !Number.isFinite(val) ? null : val; break;
      case 'contribution': state.contribution = Math.max(0, val || 0); break;
      case 'proj': {
        const lim = { monthly: [0, 1e6], years: [1, 50], ret: [-10, 20], cost: [0, 5], infl: [0, 15] }[key];
        state.proj[key] = Math.max(lim[0], Math.min(lim[1], val == null || !Number.isFinite(val) ? 0 : val));
        if (key === 'years') state.proj.years = Math.round(state.proj.years);
        break;
      }
      case 'tax-year': ui.taxYear = Number(el.value); break;
      case 'map': ui.pending.mapping[el.dataset.field] = Number(el.value); break;
      case 'file': {
        const file = el.files && el.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => readText(String(reader.result), file.name);
        reader.onerror = () => { ui.notice = 'No se ha podido leer el fichero.'; render(); };
        reader.readAsText(file);
        return;
      }
      case 'paste': return readText($('#paste').value, 'texto pegado');
      case 'confirm-import': {
        leaveDemo();
        const r = TC.mergeTransactions(state.transactions, ui.pending.result.transactions);
        state.transactions = r.merged;
        ui.notice = `${r.added} movimientos añadidos` + (r.duplicates ? `, ${r.duplicates} ya estaban y se han omitido.` : '.') + ' Revisa ahora los precios en Posiciones.';
        ui.pending = null;
        break;
      }
      case 'cancel-import': ui.pending = null; break;
      case 'del': state.transactions = state.transactions.filter((t) => t.id !== el.dataset.id); break;
      case 'load-demo': state = Object.assign(defaults(), TC.demoData(todayISO()), { isDemo: true }); ui.notice = ''; break;
      case 'wipe':
        if (!ui.confirmWipe) { ui.confirmWipe = true; return render(); }
        state = defaults(); ui = { pending: null, notice: 'Datos borrados.', confirmWipe: false, taxYear: null, backup: '' };
        break;
      case 'backup': ui.backup = JSON.stringify(state); return render();
      case 'copy-backup': {
        const ta = $('#backup-text');
        const done = () => { el.textContent = 'Copiado'; };
        const fallback = () => { ta.focus(); ta.select(); };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(ui.backup).then(done, fallback); else fallback();
        return;
      }
      case 'download-backup': {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([ui.backup], { type: 'application/json' }));
        a.download = `cartera-${todayISO()}.json`;
        document.body.appendChild(a); a.click(); a.remove();
        return;
      }
      default: return;
    }
    if (action !== 'wipe') ui.confirmWipe = false;
    save();
    render();
  }

  document.addEventListener('change', (ev) => {
    const el = ev.target.closest('[data-action]');
    if (el && el.tagName !== 'BUTTON') act(el.dataset.action, el);
  });
  document.addEventListener('click', (ev) => {
    const el = ev.target.closest('button[data-action]');
    if (el) act(el.dataset.action, el);
  });
  document.addEventListener('submit', (ev) => {
    if (ev.target.id !== 'manual') return;
    ev.preventDefault();
    const f = Object.fromEntries(new FormData(ev.target).entries());
    const trade = f.type === 'buy' || f.type === 'sell';
    const shares = Number(f.shares) || 0, price = Number(f.price) || 0, amount = Number(f.amount) || 0;
    const isin = f.isin.trim().toUpperCase(), name = f.name.trim() || isin;
    if (trade && (!(shares > 0) || !(price > 0) || !name)) { ui.notice = 'Una compra o venta necesita nombre o ISIN, títulos y precio.'; return render(); }
    if (!trade && !(amount > 0)) { ui.notice = 'Indica el importe del movimiento.'; return render(); }
    leaveDemo();
    state.transactions.push({ id: 'manual-' + Date.now(), date: f.date, type: f.type, isin, name, assetClass: '', shares: trade ? shares : 0, price: trade ? price : 0, amount: trade ? 0 : amount, fee: Number(f.fee) || 0, tax: 0 });
    ui.notice = 'Movimiento añadido.';
    save();
    render();
  });
  window.addEventListener('hashchange', () => { ui.confirmWipe = false; render(); window.scrollTo(0, 0); });
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (currentView() === 'proyeccion') drawProjection(model()); }, 150);
  });

  render();
})();
