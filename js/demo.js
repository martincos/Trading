/* Cartera de ejemplo para la primera visita. Valores y precios inventados, con fechas relativas a hoy. */
(function (root) {
  'use strict';
  const TC = root.TC;
  TC.demoData = function (today) {
    const ago = (n, day) => TC.addMonths(today, -n).slice(0, 8) + (day || '05');
    const txs = [];
    let n = 0;
    const push = (date, type, isin, name, shares, price, amount, fee, tax, assetClass) =>
      txs.push({ id: 'demo-' + (++n), date, type, isin, name, assetClass: assetClass || '', shares, price, amount, fee: fee || 0, tax: tax || 0 });
    const W = ['IE00B4L5Y983', 'ETF MSCI World (ejemplo)'], E = ['IE00BKM4GZ66', 'ETF Mercados Emergentes (ejemplo)'];
    push(ago(22, '01'), 'deposit', '', 'Ingreso', 0, 0, 6500);
    for (let m = 22; m >= 1; m--) {
      const k = (22 - m) / 21;
      if (m < 22) push(ago(m, '01'), 'deposit', '', 'Ingreso mensual', 0, 0, 450);
      push(ago(m, '02'), 'buy', W[0], W[1], +(300 / (80 + 28 * k)).toFixed(4), +(80 + 28 * k).toFixed(2), 0, 0, 0, 'ETF');
      push(ago(m, '02'), 'buy', E[0], E[1], +(100 / (30 + 4 * k)).toFixed(4), +(30 + 4 * k).toFixed(2), 0, 0, 0, 'ETF');
      if (m % 3 === 0) push(ago(m, '03'), 'interest', '', 'Intereses del efectivo', 0, 0, 9.2, 0, 2.16);
    }
    push(ago(20, '12'), 'buy', 'US0000000001', 'Tecnológica Norte (ejemplo)', 10, 170, 0, 1);
    push(ago(18, '14'), 'buy', 'NL0000000002', 'Litografía Delta (ejemplo)', 3, 650, 0, 1);
    push(ago(14, '20'), 'buy', 'US0000000003', 'Deportiva Austral (ejemplo)', 20, 95, 0, 1);
    for (const m of [6, 5, 4]) push(ago(m, '18'), 'buy', 'ES0000000004', 'Textil Atlántica (ejemplo)', 1, 47 + (6 - m), 0, 1);
    push(ago(3, '10'), 'sell', 'US0000000001', 'Tecnológica Norte (ejemplo)', 4, 235, 0, 1);
    push(ago(2, '15'), 'dividend', 'US0000000001', 'Tecnológica Norte (ejemplo)', 0, 0, 5.1, 0, 0.9);
    push(ago(2, '22'), 'dividend', 'ES0000000004', 'Textil Atlántica (ejemplo)', 0, 0, 2.43, 0, 0.57);
    const prices = {};
    const set = (isin, price) => { prices[isin] = { price, date: today }; };
    set(W[0], 111); set(E[0], 34.5); set('US0000000001', 240); set('NL0000000002', 720); set('US0000000003', 62); set('ES0000000004', 51);
    const targets = { [W[0]]: 60, [E[0]]: 15, US0000000001: 10, NL0000000002: 10, ES0000000004: 5 };
    return { transactions: txs, prices, targets };
  };
})(typeof self !== 'undefined' ? self : globalThis);
