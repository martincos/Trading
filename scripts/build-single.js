/* Genera dist/brujula-cartera.html: toda la aplicación en un único fichero que se abre con doble clic. */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

let html = read('index.html');
html = html.replace('<link rel="stylesheet" href="styles.css">', () => `<style>\n${read('styles.css')}</style>`);
html = html.replace(/<script src="(js\/[^"]+)"><\/script>/g, (_, f) => `<script>\n${read(f)}</script>`);

const out = process.argv[2] || path.join(root, 'dist', 'brujula-cartera.html');
fs.mkdirSync(path.dirname(out), { recursive: true });
if (process.argv.includes('--fragment')) {
  // Variante sin <html>/<head>/<body>, para alojamientos que añaden su propio esqueleto.
  html = html.replace(/<!doctype html>\s*|<\/?(html|head|body)[^>]*>\s*|<meta charset[^>]*>\s*|<meta name="viewport"[^>]*>\s*/gi, '');
}
fs.writeFileSync(out, html);
console.log(`${out} (${(html.length / 1024).toFixed(0)} kB)`);
