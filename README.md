# Brújula de Cartera

Panel local para analizar una cuenta de bróker (pensado para Trade Republic) a partir de su exportación de
movimientos en CSV. No se conecta a la cuenta ni ejecuta órdenes: lee el fichero en el navegador y guarda los
datos solo en ese navegador (`localStorage`).

Herramienta independiente, sin relación con Trade Republic. Los cálculos son orientativos y no son
asesoramiento financiero ni fiscal.

## Qué hace

| Sección | Para qué sirve |
|---|---|
| Resumen | Valor total, plusvalía latente, rentabilidad anualizada (TIR ponderada por aportaciones), comisiones y una lista priorizada de acciones |
| Posiciones | Coste medio FIFO por valor, precio actual editable y peso objetivo |
| Rebalanceo | Reparte la próxima aportación solo con compras para acercarse a los objetivos, sin vender, y la escribe como órdenes para copiar al bróker |
| Operación | Reglas de riesgo propias, cálculo de cuántos títulos comprar según entrada, stop y objetivo, y niveles de precio vigilados |
| Fiscalidad | Estimación del IRPF del ahorro (España), pérdidas latentes que compensan ganancias y avisos de la regla de los dos meses |
| Proyección | 5.000 simulaciones repetibles (semilla fija) con aportaciones mensuales, volatilidad, costes e inflación: resultado central, escenarios malo y bueno y probabilidad de acabar por debajo de lo aportado |
| Datos | Importación de CSV, alta manual, copia de seguridad y borrado |

## Cómo usarla

- **Sin instalar nada:** abre `dist/brujula-cartera.html` con doble clic. Es toda la aplicación en un fichero.
- **Desde el código:** abre `index.html`.

La primera vez se muestra una cartera de ejemplo con valores inventados. Al importar tus movimientos se sustituye.

### Importar movimientos

1. Exporta el historial de transacciones en CSV desde tu bróker.
2. En **Datos**, carga el fichero o pega su contenido.
3. Revisa la asignación de columnas que propone la aplicación y corrígela si hace falta.
4. En **Posiciones**, escribe el precio actual de cada valor. La exportación no trae cotizaciones, así que
   mientras no lo hagas se usa el precio del último movimiento.

El importador reconoce cabeceras en inglés, alemán y español (por ejemplo `datetime, type, name, symbol, shares,
price, amount, fee, tax` o el formato de Portfolio Performance `Fecha;Tipo;Valor;Nota;ISIN;Acciones;Comisiones;Impuestos`),
separadores `,` `;` o tabulador y decimales con coma o punto. Las columnas se pueden reasignar a mano.

## Limitaciones conocidas

- Los precios actuales se introducen a mano; no hay cotizaciones en tiempo real. Los niveles vigilados se comprueban contra esos precios, así que no sustituyen a una orden stop en el bróker.
- La simulación supone rentabilidades mensuales lognormales independientes con la rentabilidad y volatilidad que indiques; no modela crisis, cambios de régimen ni tu comportamiento.
- Todos los importes se tratan como euros.
- Si una compra o venta no trae precio por título, se calcula como importe ÷ títulos; si ese importe ya incluye la
  comisión, el coste queda desviado en esa comisión.
- La estimación fiscal usa FIFO y la escala del ahorro vigente desde 2025. No contempla otras rentas del ahorro,
  pérdidas de ejercicios anteriores, retenciones extranjeras recuperables ni operaciones corporativas (splits, canjes).
- El efectivo se deduce de los movimientos importados; si no cuadra, se puede fijar el saldo real en Posiciones.

## Desarrollo

```
npm test        # pruebas del motor (node --test, sin dependencias)
npm run build   # regenera dist/brujula-cartera.html
```

- `js/parse.js`: lectura de CSV y normalización de movimientos
- `js/portfolio.js`: lotes FIFO, plusvalías, efectivo y TIR
- `js/advice.js`: fiscalidad, rebalanceo, proyección y recomendaciones
- `js/app.js`: interfaz

## Ideas tomadas de day-trader-skill

Las skills de `.claude/skills/` (Jakeschincariol/day-trader-skill, MIT) inspiran varias piezas de la aplicación, adaptadas
a una cartera a largo plazo: el tamaño de la operación limitado por la pérdida máxima (trader-budget, trader-exit),
las comprobaciones «pasa / falla» contra reglas propias (trader-risk), los niveles vigilados (trader-alerts), la
simulación repetible con semilla (trader-timemachine) y las órdenes escritas en claro que solo el usuario ejecuta
(trader-broker). El escáner, las noticias y los datos de la SEC necesitan conexión a servicios externos y siguen
disponibles solo como skills.
