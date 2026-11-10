const test = require('node:test');
const assert = require('node:assert/strict');
const parse = require('../js/parse.js');
const { computePortfolio, xirr, addMonths } = require('../js/portfolio.js');
const advice = require('../js/advice.js');

const near = (a, b, eps = 0.01) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);
const buy = (date, isin, shares, price, fee = 0) => ({ id: date + isin + shares, date, type: 'buy', isin, name: isin, shares, price, fee, tax: 0, amount: 0 });
const sell = (date, isin, shares, price, fee = 0) => ({ ...buy(date, isin, shares, price, fee), type: 'sell', id: 's' + date + isin });

test('parseNumber entiende formatos europeo y anglosajón', () => {
  assert.equal(parse.parseNumber('1.234,56'), 1234.56);
  assert.equal(parse.parseNumber('1,234.56'), 1234.56);
  assert.equal(parse.parseNumber('-12,5 €'), -12.5);
  assert.equal(parse.parseNumber('0.004321'), 0.004321);
  assert.equal(parse.parseNumber('1,234,567'), 1234567);
  assert.equal(parse.parseNumber(''), null);
  assert.equal(parse.parseNumber('abc'), null);
});

test('parseDate acepta ISO y día/mes/año', () => {
  assert.equal(parse.parseDate('2026-03-05T10:11:12.000Z'), '2026-03-05');
  assert.equal(parse.parseDate('05.03.2026'), '2026-03-05');
  assert.equal(parse.parseDate('5/3/26'), '2026-03-05');
  assert.equal(parse.parseDate('nope'), null);
});

test('importa un CSV con cabeceras en inglés y comas', () => {
  const csv = '﻿datetime,category,type,asset_class,name,symbol,shares,price,amount,fee,tax,transaction_id\n' +
    '2026-01-02T09:00:00Z,CASH,CUSTOMER_INBOUND,,,,,,1000.00,,,a1\n' +
    '2026-01-03T09:00:00Z,TRADING,BUY,STOCK,"Acme, Inc.",US0378331005,2,100.50,-201.00,1.00,,a2\n' +
    '2026-02-03T09:00:00Z,CASH,DIVIDEND,STOCK,"Acme, Inc.",US0378331005,,,1.70,,0.30,a3\n' +
    'basura,,,,,,,,,,,\n';
  const { headers, rows, delimiter } = parse.parseCSV(csv);
  assert.equal(delimiter, ',');
  const { transactions, skipped } = parse.normalizeRows(headers, rows, parse.autoMap(headers));
  assert.deepEqual(transactions.map((t) => t.type), ['deposit', 'buy', 'dividend']);
  assert.equal(transactions[1].name, 'Acme, Inc.');
  assert.equal(transactions[1].shares, 2);
  assert.equal(transactions[1].price, 100.5);
  assert.equal(transactions[2].tax, 0.3);
  assert.equal(skipped.length, 1);
});

test('importa el formato Portfolio Performance en español con punto y coma', () => {
  const csv = 'Fecha;Tipo;Valor;Nota;ISIN;Acciones;Comisiones;Impuestos\n' +
    '03/01/2026;Compra;-1.000,00;MSCI World;IE00B4L5Y983;10;1,00;\n' +
    '10/02/2026;Venta;550,00;MSCI World;IE00B4L5Y983;5;1,00;\n';
  const { headers, rows } = parse.parseCSV(csv);
  const { transactions } = parse.normalizeRows(headers, rows, parse.autoMap(headers));
  assert.equal(transactions[0].type, 'buy');
  assert.equal(transactions[0].price, 100);
  assert.equal(transactions[1].type, 'sell');
  assert.equal(transactions[1].price, 110);
});

test('reimportar el mismo fichero no duplica movimientos', () => {
  const a = [buy('2026-01-01', 'X', 1, 10)];
  const r = parse.mergeTransactions(a, [buy('2026-01-01', 'X', 1, 10), buy('2026-01-02', 'X', 1, 10)]);
  assert.equal(r.added, 1);
  assert.equal(r.duplicates, 1);
});

test('FIFO: la venta consume primero los lotes más antiguos y las comisiones cuentan', () => {
  const txs = [buy('2025-01-10', 'X', 10, 100, 1), buy('2025-06-10', 'X', 10, 200, 1), sell('2026-01-10', 'X', 15, 300, 1)];
  const p = computePortfolio(txs, {}, { today: '2026-02-01' });
  // coste vendido: 1001 + 5 × 200,1 = 2001,5 ; ingresos: 4500 − 1 = 4499
  near(p.realized[0].gain, 4499 - 2001.5);
  near(p.positions[0].shares, 5);
  near(p.positions[0].cost, 1000.5);
  near(p.totals.fees, 3);
  near(p.cash, -1001 - 2001 + 4499);
});

test('los precios manuales tienen prioridad sobre el último movimiento', () => {
  const txs = [buy('2025-01-10', 'X', 10, 100)];
  assert.equal(computePortfolio(txs, {}, { today: '2026-01-10' }).positions[0].value, 1000);
  const p = computePortfolio(txs, { X: { price: 121, date: '2026-01-10' } }, { today: '2026-01-10' });
  assert.equal(p.positions[0].value, 1210);
  near(p.xirr, 0.21, 0.002);
});

test('una venta sin compras suficientes genera un aviso', () => {
  const p = computePortfolio([sell('2026-01-10', 'X', 5, 10)], {}, { today: '2026-02-01' });
  assert.equal(p.warnings.length, 1);
  assert.equal(p.realized[0].incomplete, true);
});

test('xirr de un flujo sencillo', () => {
  near(xirr([{ date: '2025-01-01', amount: -1000 }, { date: '2026-01-01', amount: 1100 }]), 0.10, 0.001);
  assert.equal(xirr([{ date: '2025-01-01', amount: -1000 }]), null);
});

test('addMonths respeta el fin de mes', () => {
  assert.equal(addMonths('2026-12-31', 2), '2027-02-28');
  assert.equal(addMonths('2026-03-15', -2), '2026-01-15');
});

test('escala del ahorro', () => {
  near(advice.taxOnSavings(6000), 1140);
  near(advice.taxOnSavings(10000), 1140 + 840);
  near(advice.taxOnSavings(60000), 1140 + 9240 + 2300);
  assert.equal(advice.taxOnSavings(-50), 0);
});

test('las pérdidas compensan como máximo el 25 % de los rendimientos', () => {
  const r = advice.savingsBase(-1000, 400);
  near(r.base, 300);
  near(r.carry, 900);
});

test('resumen fiscal y candidatos a compensar pérdidas', () => {
  const txs = [
    buy('2025-01-10', 'G', 10, 100), sell('2026-03-10', 'G', 10, 300),
    buy('2025-01-10', 'L', 10, 100),
    { id: 'd', date: '2026-04-01', type: 'dividend', isin: 'L', name: 'L', shares: 0, price: 0, amount: 81, fee: 0, tax: 19 },
  ];
  const p = computePortfolio(txs, { L: { price: 40, date: '2026-06-01' } }, { today: '2026-06-01' });
  const s = advice.taxSummary(p, 2026);
  near(s.net, 2000); near(s.incomeGross, 100); near(s.base, 2100); near(s.tax, 399); near(s.due, 380);
  const h = advice.harvestCandidates(p, 2026);
  assert.equal(h.length, 1);
  near(h[0].loss, -600);
  near(h[0].saving, 600 * 0.19);
  assert.equal(h[0].recentBuy, '');
  const tips = advice.insights(p, txs, {}, 0);
  assert.ok(tips[0].title.includes('IRPF'));
});

test('regla de los dos meses: recompra tras vender con pérdidas', () => {
  const txs = [buy('2025-01-10', 'X', 10, 100), sell('2026-03-10', 'X', 10, 50), buy('2026-04-20', 'X', 5, 55)];
  const p = computePortfolio(txs, {}, { today: '2026-06-01' });
  assert.equal(advice.washSales(txs, p).length, 1);
  const ok = [buy('2025-01-10', 'X', 10, 100), sell('2026-03-10', 'X', 10, 50), buy('2026-06-20', 'X', 5, 55)];
  assert.equal(advice.washSales(ok, computePortfolio(ok, {}, { today: '2026-07-01' })).length, 0);
});

test('el rebalanceo reparte la aportación hacia lo que va por debajo', () => {
  const positions = [{ key: 'A', name: 'A', value: 8000, price: 100 }, { key: 'B', name: 'B', value: 2000, price: 50 }, { key: 'C', name: 'C', value: 500, price: 1 }];
  const plan = advice.rebalancePlan(positions, { A: 60, B: 40 }, 1000);
  const [a, b] = plan.rows;
  near(a.buy, 0); near(b.buy, 1000); near(b.sharesApprox, 20);
  near(a.buy + b.buy, 1000);
  assert.deepEqual(plan.excluded, ['C']);
  const big = advice.rebalancePlan(positions, { A: 50, B: 50 }, 10000);
  near(big.rows[0].buy, 2000); near(big.rows[1].buy, 8000);
  near(big.rows[0].weightAfter, 0.5);
});

test('proyección: sin rentabilidad el valor es lo aportado', () => {
  const out = advice.projection({ initial: 1000, monthly: 100, years: 2, annualReturn: 0, annualCost: 0, inflation: 0 });
  assert.equal(out.length, 3);
  near(out[2].value, 3400); near(out[2].contributed, 3400);
  const g = advice.projection({ initial: 1000, monthly: 0, years: 10, annualReturn: 0.07, annualCost: 0.002, inflation: 0.02 });
  near(g[10].noCost, 1000 * 1.07 ** 10, 0.01);
  assert.ok(g[10].value < g[10].noCost && g[10].real < g[10].value);
});

const RULES = { maxLoss: 50, maxPositionPct: 75, cashBufferPct: 10, minRR: 1, fee: 0 };

test('tamaño de la operación: decide el menor de los límites', () => {
  const r = advice.sizeTrade({ entry: 364.18, stop: 358.32, target: 370.04, account: 5000, cash: 5000, heldValue: 0, rules: RULES });
  assert.equal(r.shares, 8);
  assert.equal(r.decidedBy, 'loss');
  assert.deepEqual(r.limits.map((l) => l.shares), [8, 10, 12]);
  near(r.lossAtStop, 46.88); near(r.rr, 1); near(r.breakEven, 0.5);
  assert.equal(r.ok, true);
});

test('tamaño de la operación: las comisiones reducen títulos y rentabilidad:riesgo', () => {
  const r = advice.sizeTrade({ entry: 364.18, stop: 358.32, target: 370.04, account: 5000, cash: 5000, heldValue: 0, rules: { ...RULES, fee: 1 } });
  assert.equal(r.shares, 8);
  near(r.lossAtStop, 48.88); near(r.gainAtTarget, 44.88);
  assert.equal(r.ok, false); // 0,92 < 1
});

test('tamaño de la operación: un stop demasiado lejano se rechaza, no se encoge', () => {
  const far = advice.sizeTrade({ entry: 364.18, stop: 300, target: 500, account: 5000, cash: 5000, heldValue: 0, rules: RULES });
  assert.equal(far.shares, 0); assert.equal(far.ok, false);
  const bad = advice.sizeTrade({ entry: 100, stop: 101, target: 110, account: 5000, cash: 5000, heldValue: 0, rules: RULES });
  assert.equal(bad.ok, false); assert.equal(bad.limits.length, 0);
  const held = advice.sizeTrade({ entry: 100, stop: 99, target: 103, account: 5000, cash: 5000, heldValue: 3700, rules: RULES });
  assert.equal(held.shares, 0); assert.equal(held.decidedBy, 'position');
});

test('niveles vigilados', () => {
  const positions = [{ key: 'A', name: 'A', price: 62 }];
  const out = advice.checkLevels([{ key: 'A', type: 'below', price: 65 }, { key: 'A', type: 'above', price: 70 }, { key: 'Z', name: 'Z', type: 'above', price: 1 }], positions);
  assert.deepEqual(out.map((l) => l.hit), [true, false, false]);
  assert.equal(out[2].held, false);
});

test('simulación: repetible con la misma semilla y coherente con la hipótesis', () => {
  const args = { initial: 10000, monthly: 0, years: 10, annualReturn: 0.06, annualCost: 0, volatility: 0.15, paths: 4000, seed: 19 };
  const a = advice.simulate(args), b = advice.simulate(args);
  assert.deepEqual(a.rows[10], b.rows[10]);
  const end = a.rows[10];
  assert.ok(end.p10 < end.p50 && end.p50 < end.p90);
  // mediana teórica: 10000 × exp(10 × (ln 1,06 − 0,15²/2)) ≈ 16.003
  near(end.p50, 16003, 700);
  assert.ok(a.probBelow > 0.05 && a.probBelow < 0.25);
  const flat = advice.simulate({ ...args, volatility: 0, monthly: 100 });
  near(flat.rows[10].p10, flat.rows[10].p90, 1e-6);
  assert.equal(flat.probBelow, 0);
});
