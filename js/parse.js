/* Lectura de CSV y normalización de movimientos. Sin dependencias; funciona en navegador y en Node. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TC = Object.assign(root.TC || {}, api);
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  function parseNumber(v) {
    if (v == null) return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    let s = String(v).trim().replace(/[€$£\s ']|EUR|USD/gi, '');
    if (!s) return null;
    let neg = false;
    if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
    const hasComma = s.includes(','), hasDot = s.includes('.');
    if (hasComma && hasDot) {
      // El último separador es el decimal: "1.234,56" o "1,234.56".
      if (s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\./g, '').replace(',', '.');
      else s = s.replace(/,/g, '');
    } else if (hasComma) {
      if (/^[-+]?\d{1,3}(,\d{3}){2,}$/.test(s)) s = s.replace(/,/g, '');
      else s = s.replace(',', '.');
    } else if (hasDot && (s.match(/\./g) || []).length > 1) {
      s = s.replace(/\./g, '');
    }
    const n = Number(s);
    if (!Number.isFinite(n)) return null;
    return neg ? -n : n;
  }

  const pad = (n) => String(n).padStart(2, '0');

  /** Devuelve la fecha como "aaaa-mm-dd" o null. Las fechas con barras o puntos se leen como día/mes/año. */
  function parseDate(v) {
    if (v == null) return null;
    const s = String(v).trim();
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    let y, mo, d;
    if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; }
    else {
      m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})/);
      if (!m) return null;
      d = +m[1]; mo = +m[2]; y = +m[3];
      if (y < 100) y += 2000;
    }
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 1990 || y > 2100) return null;
    return `${y}-${pad(mo)}-${pad(d)}`;
  }

  function detectDelimiter(line) {
    const counts = { ';': 0, ',': 0, '\t': 0 };
    let quoted = false;
    for (const ch of line) {
      if (ch === '"') quoted = !quoted;
      else if (!quoted && ch in counts) counts[ch]++;
    }
    return Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
  }

  function parseCSV(text) {
    text = String(text || '').replace(/^﻿/, '');
    const firstLine = text.split(/\r?\n/).find((l) => l.trim()) || '';
    const delimiter = detectDelimiter(firstLine);
    const rows = [];
    let row = [], cell = '', quoted = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quoted) {
        if (ch === '"') {
          if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
        } else cell += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === delimiter) { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); cell = '';
        if (row.some((c) => c.trim() !== '')) rows.push(row);
        row = [];
      } else cell += ch;
    }
    row.push(cell);
    if (row.some((c) => c.trim() !== '')) rows.push(row);
    const headers = (rows.shift() || []).map((h) => h.trim());
    return { headers, rows, delimiter };
  }

  const normHeader = (h) => String(h).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');

  // Nombres de columna conocidos (inglés, alemán y español), por orden de preferencia.
  const FIELD_ALIASES = {
    date: ['datetime', 'date', 'fecha', 'fechahora', 'datum', 'zeitpunkt', 'timestamp', 'buchungstag'],
    type: ['type', 'tipo', 'typ', 'transactiontype', 'tipodemovimiento'],
    category: ['category', 'categoria', 'kategorie'],
    isin: ['isin', 'symbol', 'simbolo'],
    name: ['name', 'nombre', 'instrument', 'instrumento', 'titel', 'wertpapier', 'note', 'nota', 'notiz'],
    shares: ['shares', 'acciones', 'stuck', 'stueck', 'quantity', 'cantidad', 'anzahl', 'titulos', 'units'],
    price: ['price', 'precio', 'kurs', 'preis', 'pricepershare', 'preciounitario'],
    amount: ['amount', 'importe', 'valor', 'wert', 'value', 'betrag', 'total'],
    fee: ['fee', 'fees', 'comisiones', 'comision', 'gebuhren', 'gebuhr'],
    tax: ['tax', 'taxes', 'impuestos', 'impuesto', 'steuern', 'steuer'],
    id: ['transactionid', 'id', 'referencia'],
    assetClass: ['assetclass', 'tipodeactivo', 'claseactivo'],
    description: ['description', 'descripcion', 'beschreibung'],
  };
  const FIELD_LABELS = {
    date: 'Fecha', type: 'Tipo de movimiento', category: 'Categoría', isin: 'ISIN', name: 'Nombre del valor',
    shares: 'Títulos', price: 'Precio por título', amount: 'Importe', fee: 'Comisión', tax: 'Impuestos',
    id: 'Identificador', assetClass: 'Clase de activo', description: 'Descripción',
  };

  /** Propone qué columna del CSV corresponde a cada campo. -1 = sin asignar. */
  function autoMap(headers) {
    const normalized = headers.map(normHeader);
    const used = new Set();
    const mapping = {};
    for (const field of Object.keys(FIELD_ALIASES)) {
      mapping[field] = -1;
      for (const alias of FIELD_ALIASES[field]) {
        const idx = normalized.findIndex((h, i) => h === alias && !used.has(i));
        if (idx >= 0) { mapping[field] = idx; used.add(idx); break; }
      }
    }
    return mapping;
  }

  const TYPE_RULES = [
    ['sell', /sell|verkauf|venta|vender/],
    ['buy', /buy|kauf|compra|savings|sparplan|plan de inversi|round ?up|saveback|redondeo/],
    ['dividend', /dividend|dividendo|distribution|aussch|cupon|coupon/],
    ['interest', /interest|zins|interes/],
    ['fee', /fee|gebuhr|comision/],
    ['tax', /tax|steuer|impuesto|retencion/],
    ['withdrawal', /withdraw|outbound|outgoing|auszahlung|retirada|card|tarjeta|payout|removal/],
    ['deposit', /deposit|inbound|incoming|einzahlung|ingreso|top ?up|transfer/],
  ];

  function classify(typeText, shares, amount) {
    const t = String(typeText || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/_/g, ' ');
    for (const [type, re] of TYPE_RULES) if (re.test(t)) return type;
    if (shares && amount != null) return amount < 0 ? 'buy' : 'sell';
    if (amount != null && amount !== 0) return amount < 0 ? 'withdrawal' : 'deposit';
    return null;
  }

  const ISIN_RE = /^[A-Z]{2}[A-Z0-9]{9}\d$/;

  /**
   * Convierte las filas del CSV en movimientos normalizados.
   * Compras y ventas guardan títulos y precio; el resto guarda el importe.
   */
  function normalizeRows(headers, rows, mapping) {
    const get = (row, field) => (mapping[field] >= 0 ? (row[mapping[field]] || '').trim() : '');
    const transactions = [], skipped = [], seen = {};
    rows.forEach((row, i) => {
      const line = i + 2;
      const date = parseDate(get(row, 'date'));
      if (!date) { skipped.push({ line, reason: 'Fecha no reconocida' }); return; }
      const sharesRaw = parseNumber(get(row, 'shares'));
      const shares = sharesRaw ? Math.abs(sharesRaw) : 0;
      const amount = parseNumber(get(row, 'amount'));
      const fee = Math.abs(parseNumber(get(row, 'fee')) || 0);
      const tax = Math.abs(parseNumber(get(row, 'tax')) || 0);
      let price = parseNumber(get(row, 'price'));
      price = price ? Math.abs(price) : null;
      const typeText = [get(row, 'type'), get(row, 'category')].join(' ');
      let type = classify(get(row, 'type'), shares, amount) || classify(typeText + ' ' + get(row, 'description'), shares, amount);
      if (!type) { skipped.push({ line, reason: 'Tipo de movimiento no reconocido' }); return; }
      let isin = get(row, 'isin').toUpperCase();
      const name = get(row, 'name') || get(row, 'description') || isin;
      if (!ISIN_RE.test(isin)) isin = '';
      const tx = { date, type, isin, name, assetClass: get(row, 'assetClass'), shares: 0, price: 0, amount: 0, fee, tax };
      if (type === 'buy' || type === 'sell') {
        if (!shares) { skipped.push({ line, reason: 'Compra o venta sin número de títulos' }); return; }
        if (!price && amount) price = Math.abs(amount) / shares;
        if (!price) { skipped.push({ line, reason: 'Compra o venta sin precio ni importe' }); return; }
        if (!isin && !name) { skipped.push({ line, reason: 'Compra o venta sin valor identificado' }); return; }
        tx.shares = shares; tx.price = price;
      } else {
        if (amount == null) { skipped.push({ line, reason: 'Movimiento sin importe' }); return; }
        tx.amount = type === 'tax' ? amount : Math.abs(amount);
      }
      const given = get(row, 'id');
      const base = given || [date, type, isin || name, tx.shares, tx.price || tx.amount].join('|');
      seen[base] = (seen[base] || 0) + 1;
      tx.id = given || `${base}#${seen[base]}`;
      transactions.push(tx);
    });
    return { transactions, skipped };
  }

  /** Añade movimientos nuevos a los existentes sin duplicar los que ya estaban. */
  function mergeTransactions(existing, incoming) {
    const ids = new Set(existing.map((t) => t.id));
    const added = incoming.filter((t) => !ids.has(t.id));
    return { merged: existing.concat(added), added: added.length, duplicates: incoming.length - added.length };
  }

  return { parseNumber, parseDate, parseCSV, autoMap, normalizeRows, mergeTransactions, classify, FIELD_ALIASES, FIELD_LABELS };
});
