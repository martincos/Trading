/* Fiscalidad (España), rebalanceo, proyección y recomendaciones. */
(function (root, factory) {
  const api = factory((typeof module === 'object' && module.exports) ? require('./portfolio.js') : root.TC);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TC = Object.assign(root.TC || {}, api);
})(typeof self !== 'undefined' ? self : globalThis, function (P) {
  'use strict';
  const { addMonths, keyOf } = P;

  // Base del ahorro del IRPF, escala estatal + autonómica vigente desde 2025.
  const SAVINGS_BRACKETS = [[6000, 0.19], [50000, 0.21], [200000, 0.23], [300000, 0.27], [Infinity, 0.30]];

  function taxOnSavings(base) {
    let tax = 0, prev = 0;
    for (const [limit, rate] of SAVINGS_BRACKETS) {
      if (base <= prev) break;
      tax += (Math.min(base, limit) - prev) * rate;
      prev = limit;
    }
    return Math.max(0, tax);
  }

  /** Base del ahorro a partir de ganancias patrimoniales netas y rendimientos (dividendos e intereses brutos). */
  function savingsBase(netGains, incomeGross) {
    if (netGains >= 0) return { base: netGains + incomeGross, carry: 0 };
    // Las pérdidas compensan como máximo el 25 % de los rendimientos; el resto queda pendiente 4 años.
    const offset = Math.min(-netGains, 0.25 * Math.max(0, incomeGross));
    return { base: incomeGross - offset, carry: -netGains - offset };
  }

  function taxSummary(portfolio, year) {
    const inYear = (r) => r.date.slice(0, 4) === String(year);
    const ops = portfolio.realized.filter(inYear);
    const gains = ops.filter((r) => r.gain > 0).reduce((s, r) => s + r.gain, 0);
    const losses = ops.filter((r) => r.gain < 0).reduce((s, r) => s + r.gain, 0);
    const inc = portfolio.income.filter(inYear);
    const incomeGross = inc.reduce((s, r) => s + r.gross, 0);
    const withheld = inc.reduce((s, r) => s + r.tax, 0);
    const { base, carry } = savingsBase(gains + losses, incomeGross);
    const tax = taxOnSavings(base);
    return { year, ops, gains, losses, net: gains + losses, incomeGross, withheld, base, tax, due: tax - withheld, carry };
  }

  /**
   * Regla de los dos meses: una pérdida no se puede declarar si se compran valores homogéneos
   * en los dos meses anteriores o posteriores a la venta y se siguen teniendo.
   */
  function washSales(transactions, portfolio) {
    const buys = transactions.filter((t) => t.type === 'buy');
    const out = [];
    for (const r of portfolio.realized) {
      if (r.gain >= 0) continue;
      const from = addMonths(r.date, -2), to = addMonths(r.date, 2);
      const after = buys.filter((b) => keyOf(b) === r.key && b.date > r.date && b.date <= to);
      const before = r.sharesAfter > 1e-6 ? buys.filter((b) => keyOf(b) === r.key && b.date >= from && b.date <= r.date) : [];
      if (after.length || before.length) out.push({ ...r, rebuys: before.concat(after).map((b) => b.date) });
    }
    return out;
  }

  /** Posiciones en pérdidas que podrían venderse para reducir el impuesto de este año. */
  function harvestCandidates(portfolio, year) {
    const s = taxSummary(portfolio, year);
    const limit = addMonths(portfolio.today, -2);
    return portfolio.positions.filter((p) => p.pnl < -1).map((p) => {
      const after = savingsBase(s.net + p.pnl, s.incomeGross);
      return {
        key: p.key, name: p.name, loss: p.pnl, value: p.value,
        saving: Math.max(0, s.tax - taxOnSavings(after.base)),
        recentBuy: p.lastBuyDate >= limit ? p.lastBuyDate : '',
      };
    }).sort((a, b) => b.saving - a.saving || a.loss - b.loss);
  }

  /**
   * Reparte una aportación solo con compras para acercar la cartera a los pesos objetivo.
   * targets: { clave: porcentaje }. Los valores sin objetivo quedan fuera del cálculo.
   */
  function rebalancePlan(positions, targets, contribution) {
    const inPlan = positions.filter((p) => targets[p.key] > 0);
    const sumT = inPlan.reduce((s, p) => s + targets[p.key], 0);
    const value = inPlan.reduce((s, p) => s + p.value, 0);
    const total = value + Math.max(0, contribution);
    const rows = inPlan.map((p) => {
      const target = targets[p.key] / sumT;
      const weight = value > 0 ? p.value / value : 0;
      return { key: p.key, name: p.name, price: p.price, value: p.value, weight, target, drift: weight - target, gap: Math.max(0, target * total - p.value), buy: 0 };
    });
    const gaps = rows.reduce((s, r) => s + r.gap, 0);
    rows.forEach((r) => {
      r.buy = gaps > 0 ? r.gap * Math.min(1, contribution / gaps) : 0;
      r.sharesApprox = r.price > 0 ? r.buy / r.price : 0;
      r.weightAfter = total > 0 ? (r.value + r.buy) / total : 0;
    });
    return { rows, targetSum: sumT, excluded: positions.filter((p) => !(targets[p.key] > 0)).map((p) => p.name) };
  }

  /** Proyección anual con aportaciones mensuales. Tipos en tanto por uno. */
  function projection({ initial, monthly, years, annualReturn, annualCost, inflation }) {
    const rate = (r) => Math.pow(1 + r, 1 / 12) - 1;
    const rNet = rate(annualReturn - annualCost), rGross = rate(annualReturn);
    let value = initial, noCost = initial, contributed = initial;
    const out = [{ year: 0, contributed, value, noCost, real: value }];
    for (let m = 1; m <= years * 12; m++) {
      value = value * (1 + rNet) + monthly;
      noCost = noCost * (1 + rGross) + monthly;
      contributed += monthly;
      if (m % 12 === 0) out.push({ year: m / 12, contributed, value, noCost, real: value / Math.pow(1 + inflation, m / 12) });
    }
    return out;
  }

  const eur2 = (n) => new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR', useGrouping: 'always' }).format(n);
  const eur = (n) => new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0, useGrouping: 'always' }).format(n);
  const pct = (n) => new Intl.NumberFormat('es-ES', { style: 'percent', maximumFractionDigits: 1 }).format(n);

  /**
   * Tamaño de una operación (solo compras) a partir de entrada, stop y objetivo.
   * Los títulos son el menor de tres límites: pérdida máxima, peso máximo y efectivo disponible.
   * Las comisiones de entrada y salida cuentan en la pérdida y en la ganancia.
   */
  function sizeTrade({ entry, stop, target, account, cash, heldValue, rules }) {
    const fee = rules.fee || 0;
    const risk = entry - stop;
    const checks = [];
    const check = (name, ok, detail) => checks.push({ name, ok, detail });
    const validStop = stop > 0 && risk > 0;
    const validTarget = target > entry;
    check('Stop por debajo de la entrada', validStop, validStop ? `Arriesgas ${eur2(risk)} por título (${pct(risk / entry)} del precio).` : 'Sin un stop válido no hay forma de limitar la pérdida.');
    if (validStop) check('Stop con margen suficiente', risk / entry >= 0.0005, risk / entry >= 0.0005 ? 'El stop no salta con el movimiento normal del precio.' : 'El stop está a menos del 0,05 % de la entrada: saltaría con cualquier oscilación.');
    check('Objetivo por encima de la entrada', validTarget, validTarget ? `Buscas ${eur2(target - entry)} por título.` : 'El objetivo debe estar por encima del precio de entrada.');
    if (!validStop || !validTarget || !(entry > 0)) return { ok: false, shares: 0, checks, limits: [], risk };

    const limits = [
      { id: 'loss', name: 'Pérdida máxima por operación', shares: Math.floor((rules.maxLoss - 2 * fee) / risk), detail: `(${eur2(rules.maxLoss)} − ${eur2(2 * fee)} de comisiones) ÷ ${eur2(risk)}` },
      { id: 'position', name: 'Peso máximo por valor', shares: Math.floor((account * rules.maxPositionPct / 100 - (heldValue || 0)) / entry), detail: `${rules.maxPositionPct} % de ${eur(account)}${heldValue ? ` − ${eur(heldValue)} que ya tienes` : ''}, ÷ ${eur2(entry)}` },
      { id: 'cash', name: 'Efectivo tras el colchón', shares: Math.floor((cash - account * rules.cashBufferPct / 100 - fee) / entry), detail: `${eur(cash)} − colchón del ${rules.cashBufferPct} %, ÷ ${eur2(entry)}` },
    ];
    limits.forEach((l) => { l.shares = Math.max(0, l.shares); });
    const shares = Math.min(...limits.map((l) => l.shares));
    const decidedBy = limits.find((l) => l.shares === shares).id;
    const lossAtStop = shares * risk + 2 * fee;
    const gainAtTarget = shares * (target - entry) - 2 * fee;
    const rr = (target - entry) / risk;
    const netRR = shares > 0 ? gainAtTarget / lossAtStop : 0;
    check('Cabe al menos un título', shares > 0, shares > 0 ? `${shares} títulos, ${eur(shares * entry)}.` : `Lo impide el límite «${limits.find((l) => l.id === decidedBy).name.toLowerCase()}». No se reduce el stop para que quepa.`);
    if (shares > 0) check(`Rentabilidad:riesgo de al menos ${String(rules.minRR).replace('.', ',')}`, netRR >= rules.minRR, `${netRR.toFixed(2).replace('.', ',')} después de comisiones (${rr.toFixed(2).replace('.', ',')} antes).`);
    return {
      ok: checks.every((c) => c.ok), shares, checks, limits, decidedBy, risk, rr, netRR,
      lossAtStop, gainAtTarget, cost: shares * entry + fee, breakEven: shares > 0 && netRR > 0 ? 1 / (1 + netRR) : null,
    };
  }

  /** Niveles de precio vigilados, comparados con el precio actual de cada posición. */
  function checkLevels(levels, positions) {
    return (levels || []).map((l) => {
      const p = positions.find((x) => x.key === l.key);
      const current = p ? p.price : null;
      const hit = current != null && (l.type === 'below' ? current <= l.price : current >= l.price);
      return { ...l, name: p ? p.name : l.name, current, held: !!p, hit };
    });
  }

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /**
   * Simulación de Montecarlo de la cartera con aportaciones mensuales y rentabilidades lognormales.
   * Misma semilla y mismos datos dan siempre el mismo resultado. Tipos en tanto por uno.
   */
  function simulate({ initial, monthly, years, annualReturn, annualCost, volatility, paths, seed }) {
    paths = paths || 5000;
    seed = seed == null ? 19 : seed;
    const rand = mulberry32(seed);
    const sigma = volatility / Math.sqrt(12);
    const mu = Math.log(Math.max(1e-6, 1 + annualReturn - annualCost)) / 12 - sigma * sigma / 2;
    const byYear = Array.from({ length: years }, () => new Float64Array(paths));
    for (let p = 0; p < paths; p++) {
      let value = initial;
      for (let m = 1; m <= years * 12; m++) {
        const z = Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
        value = value * Math.exp(mu + sigma * z) + monthly;
        if (m % 12 === 0) byYear[m / 12 - 1][p] = value;
      }
    }
    const q = (sorted, f) => sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))];
    const rows = [{ year: 0, contributed: initial, p10: initial, p50: initial, p90: initial }];
    byYear.forEach((arr, i) => {
      const sorted = Float64Array.from(arr).sort();
      rows.push({ year: i + 1, contributed: initial + monthly * 12 * (i + 1), p10: q(sorted, 0.1), p50: q(sorted, 0.5), p90: q(sorted, 0.9) });
    });
    const contributed = rows[rows.length - 1].contributed;
    const last = byYear[years - 1];
    let below = 0;
    for (let p = 0; p < paths; p++) if (last[p] < contributed) below++;
    return { rows, probBelow: below / paths, paths, seed };
  }

  /** Lista priorizada de acciones concretas sobre la cartera. */
  function insights(portfolio, transactions, targets, cash, opts) {
    const rules = Object.assign({ maxPositionPct: 25, cashBufferPct: 0 }, opts && opts.rules);
    const list = [];
    const year = Number(portfolio.today.slice(0, 4));
    const total = portfolio.invested + Math.max(0, cash);
    const add = (severity, view, title, detail, impact) => list.push({ severity, view, title, detail, impact: impact || 0 });
    if (!portfolio.positions.length) return list;

    const stale = portfolio.positions.filter((p) => p.priceSource === 'last' || p.priceDate < addMonths(portfolio.today, -1));
    if (stale.length) add('media', 'posiciones', `Actualiza el precio de ${stale.length} ${stale.length === 1 ? 'valor' : 'valores'}`,
      'Se están valorando con el precio de su último movimiento o con un precio de hace más de un mes. Todo lo demás depende de este dato.');

    const harvest = harvestCandidates(portfolio, year).filter((h) => h.saving > 5);
    if (harvest.length) {
      const best = harvest[0];
      add('alta', 'fiscalidad', `Puedes ahorrar hasta ${eur(best.saving)} de IRPF vendiendo ${best.name}`,
        `Tiene ${eur(best.loss)} de pérdida latente que compensaría ganancias ya realizadas en ${year}.` +
        (best.recentBuy ? ` Ojo: compraste el ${best.recentBuy}; por la regla de los dos meses parte de la pérdida no sería deducible todavía.` : ' No recompres el mismo valor en los dos meses siguientes.'),
        best.saving);
    }

    const wash = washSales(transactions, portfolio).filter((w) => w.date.slice(0, 4) === String(year));
    if (wash.length) add('alta', 'fiscalidad', `${wash.length} ${wash.length === 1 ? 'venta con pérdidas puede no ser deducible' : 'ventas con pérdidas pueden no ser deducibles'}`,
      `Hay compras del mismo valor a menos de dos meses de la venta (${wash.map((w) => w.name).join(', ')}). Revisa los planes de inversión automáticos: también cuentan.`,
      -wash.reduce((s, w) => s + w.gain, 0) * 0.19);

    for (const p of portfolio.positions) {
      if (p.weight > rules.maxPositionPct / 100 && portfolio.positions.length > 1 && !/etf|fund|fond|ucits|msci|index|ftse|s&p|stoxx/i.test(p.assetClass + ' ' + p.name)) {
        add('media', 'rebalanceo', `${p.name} pesa el ${pct(p.weight)} de lo invertido`,
          'Una caída del 30 % en este valor restaría ' + eur(p.value * 0.3) + ' a la cartera. Dirige las próximas aportaciones al resto antes que vender.');
      }
    }

    for (const l of checkLevels(opts && opts.levels, portfolio.positions).filter((x) => x.hit)) {
      add('alta', 'operacion', `${l.name} ha ${l.type === 'below' ? 'bajado hasta' : 'alcanzado'} tu nivel de ${eur2(l.price)}`,
        `Su precio actual es ${eur2(l.current)}. ${l.type === 'below' ? 'Es el punto en el que decidiste salir: revisa la posición en tu bróker.' : 'Es el objetivo que te marcaste: decide si recoges beneficios o subes el nivel.'}`);
    }
    if (rules.cashBufferPct > 0 && total > 0 && cash < total * rules.cashBufferPct / 100) add('media', 'operacion', `El efectivo está por debajo de tu colchón del ${rules.cashBufferPct} %`,
      `Tienes ${eur(cash)} y tu regla pide ${eur(total * rules.cashBufferPct / 100)}. Repón el colchón antes de nuevas compras.`);

    const drift = Object.keys(targets || {}).length ? rebalancePlan(portfolio.positions, targets, 0).rows.filter((r) => Math.abs(r.drift) > 0.05) : [];
    if (drift.length) add('media', 'rebalanceo', `${drift.length} ${drift.length === 1 ? 'valor se ha desviado' : 'valores se han desviado'} más de 5 puntos de su objetivo`,
      drift.map((r) => `${r.name} ${pct(r.weight)} frente a ${pct(r.target)}`).join(' · ') + '. Corrígelo con la próxima aportación.');
    else if (!Object.keys(targets || {}).length && portfolio.positions.length > 1) add('info', 'posiciones', 'Fija un peso objetivo para cada valor',
      'Con objetivos, cada aportación se reparte hacia lo que va por debajo y evitas comprar solo lo que más ha subido.');

    const small = transactions.filter((t) => t.type === 'buy' && t.fee > 0 && t.fee / (t.shares * t.price) > 0.01 && t.date >= addMonths(portfolio.today, -12));
    if (small.length >= 2) {
      const fees = small.reduce((s, t) => s + t.fee, 0);
      add('media', 'datos', `${small.length} compras del último año pagaron más de un 1 % de comisión`,
        `Suman ${eur(fees)}. En órdenes pequeñas la comisión fija pesa mucho: agrupa compras o usa planes de inversión, que no tienen comisión de ejecución.`, fees);
    }

    if (total > 0 && cash / total > 0.2 && cash > 500) add('info', 'proyeccion', `El ${pct(cash / total)} de la cuenta está en efectivo`,
      `Son ${eur(cash)}. Decide cuánto es colchón y programa el resto como aportaciones periódicas.`);

    const order = { alta: 0, media: 1, info: 2 };
    return list.sort((a, b) => order[a.severity] - order[b.severity] || b.impact - a.impact);
  }

  return { SAVINGS_BRACKETS, taxOnSavings, savingsBase, taxSummary, washSales, harvestCandidates, rebalancePlan, projection, insights, sizeTrade, checkLevels, simulate };
});
