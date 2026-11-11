# Trading

Dos aplicaciones locales en este repositorio:

- **Mesa de Operaciones** (`mesa/`): una interfaz para los 11 skills de day-trader-skill. Recorre una operación
  intradía de principio a fin ejecutando los scripts reales de cada skill.
- **Brújula de Cartera** (raíz): panel para analizar una cartera a largo plazo a partir del CSV de movimientos.

Ninguna de las dos se conecta a un bróker ni envía órdenes. Son herramientas educativas, no asesoramiento
financiero. La mayoría de quienes hacen day trading pierden dinero.

# Mesa de Operaciones

```
python3 mesa/server.py --demo    # para probarla: mercado inventado, sin conexión
python3 mesa/server.py           # con datos de verdad
```

Se abre en `http://127.0.0.1:8765`. Solo necesita Python 3.9 o posterior, sin instalar nada más.

## Qué hace

Cada pantalla es un skill de `.claude/skills/`. La aplicación no reimplementa su lógica: cada botón lanza el
script del skill con los mismos argumentos que usaría Claude, lee su salida y la enseña. Los skills se pasan el
trabajo unos a otros por los ficheros de `trader/`, igual que cuando se usan desde Claude, así que se puede
empezar un paso aquí y seguirlo en Claude, o al revés.

| Paso | Skill | Qué se ve |
|---|---|---|
| Hoy | (todos) | Reloj de la bolsa, operaciones y riesgo consumidos del día, posiciones y qué paso toca |
| 1. Escáner | trader-scanner | Escaneo diario (máximo de 20 días, bandera, media de 20, sobreventa) y rupturas del rango de apertura |
| 2. Noticias | trader-news | Titulares y 8-K nuevos por valor, y cuánto se mueve cada uno frente al cierre anterior |
| Analista | trader-analyst | Ingresos, márgenes, beneficio y BPA por trimestre, tal como se presentaron a la SEC |
| Congreso | trader-pelosi | Declaraciones de operaciones de la Cámara de Representantes, leídas fila a fila |
| 3. Entrada | trader-entry | Si una vela ha cerrado por encima del nivel, con el gráfico de velas; vigilancia vela a vela |
| 4. Salida | trader-exit | Stop, objetivo, riesgo por título y hora de salida, dibujados sobre el gráfico |
| 5. Máquina del tiempo | trader-timemachine | 10.000 repeticiones: reparto objetivo / stop / ninguno, abanico de precios, histograma e historial real |
| 6. Presupuesto | trader-budget | Cuántos títulos caben en cada límite y cuál decide; reparto por pesos |
| 7. Riesgo | trader-risk | PASA o BLOQUEADA, con el motivo, para cada orden propuesta |
| 8. Bróker | trader-broker | El ticket, tu respuesta escrita, el JSON exacto para Alpaca, la venta de cierre y el registro |
| 9. Alertas | trader-alerts | Stop, objetivo, hora de salida, movimientos y campana de apertura; cotizaciones |
| Mis reglas | `trader/config.json` | Presupuesto, límites de pérdida, horario y lista de valores vetados |

## Modo demostración

Genera un mercado inventado (12 empresas que no existen, una sesión completa y 60 días de historial) con el mismo
formato que devuelven Yahoo, la SEC y la Cámara, y se lo da a los skills con su opción `--offline`. Con el reloj
de la cabecera se avanza la sesión: a las 9:00 funciona el escaneo diario, a las 10:15 saltan las primeras
rupturas, a las 12:30 un valor toca su objetivo y a las 15:55 suena la alerta de salida. Sus datos van aparte,
en `.mesa/demo/`, y no tocan los tuyos.

## Lo que no hace

- **No envía órdenes.** El skill exige tres puertas para que una orden llegue al mercado: que el control de riesgo
  la haya pasado hoy, tu sí escrito para esa orden y tu «Permitir una vez» en la tarjeta de Claude. La aplicación
  cubre las dos primeras. Después puedes simular la ejecución en local (cuenta de papel, no sale nada del
  ordenador) o colocar la orden desde Claude con `/trader-broker` y apuntar aquí el resultado.
- **No cambia a cuenta real** ni activa opciones, margen o ventas en corto: eso se edita a mano en
  `trader/config.json`.
- **No da precios en tiempo real.** Usa las fuentes gratuitas de los skills (Yahoo, no oficial y con retraso).
  El stop que protege una posición es la orden que está en el bróker, no una alerta de esta página.
- Los mensajes de los skills (motivos de un bloqueo, veredicto de la simulación) se muestran tal cual, en inglés.

## Datos y privacidad

El servidor escucha solo en `127.0.0.1` y rechaza peticiones que no vengan de la propia página. Tus datos están en
`trader/` (fuera del control de versiones). En modo real los skills hacen peticiones a Yahoo Finance,
nasdaqtrader.com, sec.gov y disclosures-clerk.house.gov. La SEC exige identificarse con nombre y correo: se
escribe en «Mis reglas» y solo se envía a sec.gov.

## Estado de las pruebas

`npm test` ejecuta un día completo con los 11 skills sobre el mercado inventado. Las conexiones reales a Yahoo,
la SEC y la Cámara no se han podido probar en el entorno donde se escribió la aplicación (sin salida a esos
servidores); si alguna falla, el mensaje del skill aparece en «Salida del skill».

- `mesa/server.py`: servidor, lista cerrada de acciones y validación de cada argumento
- `mesa/demo.py`: generador del mercado inventado
- `mesa/web/`: interfaz (`app.js`) y gráficos (`charts.js`)
- `tests/test_mesa.py`: pruebas

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
npm test        # pruebas de las dos aplicaciones (node --test y unittest, sin dependencias)
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
(trader-broker). El escáner, las noticias y los datos de la SEC necesitan conexión a servicios externos: están en la Mesa de
Operaciones, que ejecuta los skills completos.
