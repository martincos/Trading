/* Motor de cartera: posiciones por FIFO, plusvalías realizadas, efectivo y rentabilidad anual. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TC = Object.assign(root.TC || {}, api);
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const EPS = 1e-9;
  const DAY = 86400000;
  const keyOf = (t) => t.isin || t.name;
  const toTime = (iso) => Date.parse(iso + 'T00:00:00Z');
  const TYPE_ORDER = { deposit: 0, interest: 1, dividend: 1, buy: 2, sell: 3, fee: 4, tax: 4, withdrawal: 5 };

  function addMonths(iso, n) {
    const d = new Date(iso + 'T00:00:00Z');
    const day = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + n);
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, last));
    return d.toISOString().slice(0, 10);
  }

  /** Tasa interna de retorno anualizada de una serie de flujos {date, amount}. null si no se puede calcular. */
  function xirr(flows) {
    if (flows.length < 2) return null;
    const t0 = Math.min(...flows.map((f) => toTime(f.date)));
    const pts = flows.map((f) => [(toTime(f.date) - t0) / DAY / 365, f.amount]);
    if (!pts.some((p) => p[1] > 0) || !pts.some((p) => p[1] < 0)) return null;
    if (Math.max(...pts.map((p) => p[0])) < 1 / 365) return null;
    const npv = (r) => pts.reduce((s, [t, a]) => s + a / Math.pow(1 + r, t), 0);
    let lo = -0.9999, hi = 100;
    let flo = npv(lo), fhi = npv(hi);
    if (!Number.isFinite(flo) || !Number.isFinite(fhi) || flo * fhi > 0) return null;
    for (let i = 0; i < 200; i++) {
      const mid = (lo + hi) / 2, fm = npv(mid);
      if (flo * fm <= 0) { hi = mid; fhi = fm; } else { lo = mid; flo = fm; }
      if (hi - lo < 1e-9) break;
    }
    return (lo + hi) / 2;
  }

  /**
   * transactions: movimientos normalizados. prices: { clave: { price, date } } con precios introducidos a mano.
   * Si falta el precio de un valor se usa el de su último movimiento.
   */
  function computePortfolio(transactions, prices, opts) {
    prices = prices || {};
    const today = (opts && opts.today) || new Date().toISOString().slice(0, 10);
    const txs = transactions.slice().sort((a, b) =>
      a.date < b.date ? -1 : a.date > b.date ? 1 : (TYPE_ORDER[a.type] ?? 9) - (TYPE_ORDER[b.type] ?? 9));

    const book = new Map();
    const realized = [], income = [], warnings = [], flows = [];
    const totals = { fees: 0, deposits: 0, withdrawals: 0, dividends: 0, interest: 0, realized: 0, buyVolume: 0, taxesPaid: 0 };
    let cash = 0;

    const entry = (t) => {
      const key = keyOf(t);
      if (!book.has(key)) book.set(key, { key, isin: t.isin, name: t.name || t.isin, assetClass: t.assetClass || '', lots: [], lastPrice: 0, lastPriceDate: '', lastBuyDate: '' });
      const e = book.get(key);
      if (t.name && (!e.name || e.name === e.isin)) e.name = t.name;
      return e;
    };

    for (const t of txs) {
      if (t.type === 'buy') {
        const e = entry(t);
        const cost = t.shares * t.price + t.fee;
        e.lots.push({ date: t.date, shares: t.shares, cost });
        e.lastPrice = t.price; e.lastPriceDate = t.date; e.lastBuyDate = t.date;
        cash -= cost; totals.fees += t.fee; totals.buyVolume += t.shares * t.price;
        flows.push({ date: t.date, amount: -cost });
      } else if (t.type === 'sell') {
        const e = entry(t);
        const proceeds = t.shares * t.price - t.fee;
        let left = t.shares, cost = 0;
        while (left > EPS && e.lots.length) {
          const lot = e.lots[0];
          const take = Math.min(lot.shares, left);
          const part = lot.cost * (take / lot.shares);
          cost += part; lot.shares -= take; lot.cost -= part; left -= take;
          if (lot.shares <= EPS) e.lots.shift();
        }
        const incomplete = left > 1e-6;
        if (incomplete) warnings.push(`Venta de ${e.name} el ${t.date}: se venden más títulos de los comprados. Faltan movimientos anteriores, así que su plusvalía no es fiable.`);
        const sharesAfter = e.lots.reduce((s, l) => s + l.shares, 0);
        const gain = proceeds - cost;
        realized.push({ date: t.date, key: e.key, name: e.name, shares: t.shares, proceeds, cost, gain, sharesAfter, incomplete });
        e.lastPrice = t.price; e.lastPriceDate = t.date;
        cash += proceeds - t.tax; totals.fees += t.fee; totals.taxesPaid += t.tax; totals.realized += gain;
        flows.push({ date: t.date, amount: proceeds });
      } else if (t.type === 'dividend' || t.type === 'interest') {
        const key = t.type === 'dividend' ? keyOf(t) : '';
        income.push({ date: t.date, type: t.type, key, name: t.name, net: t.amount, tax: t.tax, gross: t.amount + t.tax });
        cash += t.amount; totals.taxesPaid += t.tax;
        if (t.type === 'dividend') { totals.dividends += t.amount; flows.push({ date: t.date, amount: t.amount }); }
        else totals.interest += t.amount;
      } else if (t.type === 'deposit') { cash += t.amount; totals.deposits += t.amount; }
      else if (t.type === 'withdrawal') { cash -= t.amount; totals.withdrawals += t.amount; }
      else if (t.type === 'fee') { cash -= t.amount; totals.fees += t.amount; }
      else if (t.type === 'tax') { cash += t.amount; totals.taxesPaid -= t.amount; }
    }

    const positions = [];
    for (const e of book.values()) {
      const shares = e.lots.reduce((s, l) => s + l.shares, 0);
      if (shares <= 1e-6) continue;
      const cost = e.lots.reduce((s, l) => s + l.cost, 0);
      const manual = prices[e.key] && prices[e.key].price > 0 ? prices[e.key] : null;
      const price = manual ? manual.price : e.lastPrice;
      const value = shares * price;
      positions.push({
        key: e.key, isin: e.isin, name: e.name, assetClass: e.assetClass, shares, cost, avgCost: cost / shares,
        price, priceSource: manual ? 'manual' : 'last', priceDate: manual ? manual.date : e.lastPriceDate,
        value, pnl: value - cost, pnlPct: cost > 0 ? (value - cost) / cost : 0, lastBuyDate: e.lastBuyDate,
        lots: e.lots.map((l) => ({ ...l })), weight: 0,
      });
    }
    const invested = positions.reduce((s, p) => s + p.value, 0);
    positions.forEach((p) => { p.weight = invested > 0 ? p.value / invested : 0; });
    positions.sort((a, b) => b.value - a.value);
    const cost = positions.reduce((s, p) => s + p.cost, 0);
    if (invested > 0) flows.push({ date: today, amount: invested });

    return {
      today, positions, realized, income, warnings, cash,
      invested, cost, unrealized: invested - cost, unrealizedPct: cost > 0 ? (invested - cost) / cost : 0,
      totals, xirr: xirr(flows),
    };
  }

  return { computePortfolio, xirr, addMonths, keyOf };
});
