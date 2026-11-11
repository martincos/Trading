"""Datos de demostración para la Mesa de Operaciones.

Genera, con una semilla fija, un mercado INVENTADO con el formato exacto que
leen los scripts de day-trader-skill con --offline: gráficos de Yahoo (v8),
titulares RSS, feeds Atom y datos XBRL de la SEC y el índice de la Cámara.
Las empresas, los titulares, las cuentas y las personas no existen.

La sesión de demostración es el lunes 2026-10-19. Los ficheros que dependen
del reloj (el gráfico del día, las cotizaciones, los titulares) se reescriben
con materialize() cada vez que se mueve el reloj, de modo que los scripts ven
el mercado "a esa hora" y nunca una vela que aún no ha cerrado.
"""

import datetime as dt
import json
import math
import os
import random

DEMO_DAY = dt.date(2026, 10, 19)
SEED = 19
HOLIDAYS = {dt.date(2026, 5, 25), dt.date(2026, 6, 19), dt.date(2026, 7, 3), dt.date(2026, 9, 7)}
BARS = 78  # velas de 5 minutos entre 9:30 y 16:00

# ticker -> (nombre, cierre previo, patrón diario, guion intradía, volumen medio diario)
COMPANIES = {
    "BRISA": ("Brisa Motores", 84.20, "breakout_20d", "ruptura_objetivo", 9200000),
    "OLMO": ("Olmo Semiconductores", 142.60, "bull_flag", "ruptura_fallida", 6100000),
    "TEJO": ("Tejo Logística", 36.45, "reclaim_ma20", "lateral", 3400000),
    "NAVIA": ("Navia Energía", 51.30, "oversold", "ruptura_tardia", 4800000),
    "CIERZ": ("Cierzo Renovables", 27.85, "oversold_bounce", "bajista", 2900000),
    "ALBOR": ("Albor Salud", 208.40, "breakout_20d", "ruptura_sin_resolver", 2200000),
    "DUNA": ("Duna Software", 311.75, "ninguno", "lateral", 1800000),
    "MAREA": ("Marea Bank", 64.10, "ninguno", "ruptura_sin_resolver", 5200000),
    "PINAR": ("Pinar Alimentación", 18.90, "ninguno", "bajista", 2600000),
    "SOTO": ("Soto Minerales", 4.35, "bull_flag", "lateral", 7400000),  # bajo el suelo de 5 $
    "VEGA": ("Vega Aeroespacial", 96.55, "reclaim_ma20", "ruptura_objetivo", 1500000),
    "LLANO": ("Llano Retail", 12.40, "ninguno", "lateral", 310000),  # poco volumen
}
CIKS = {sym: 9000001 + i for i, sym in enumerate(COMPANIES)}


# ---------------------------------------------------------------- calendario

def _nth_sunday(year, month, n):
    d = dt.date(year, month, 1)
    d += dt.timedelta(days=(6 - d.weekday()) % 7)
    return d + dt.timedelta(weeks=n - 1)


def et_offset(day):
    """Horas de diferencia entre Nueva York y UTC ese día (-4 en verano, -5 en invierno)."""
    return -4 if _nth_sunday(day.year, 3, 2) <= day < _nth_sunday(day.year, 11, 1) else -5


def et_to_ts(day, hour, minute=0):
    naive = dt.datetime(day.year, day.month, day.day, hour, minute) - dt.timedelta(hours=et_offset(day))
    return int(naive.replace(tzinfo=dt.timezone.utc).timestamp())


def sessions_before(day, n):
    out, d = [], day
    while len(out) < n:
        d -= dt.timedelta(days=1)
        if d.weekday() < 5 and d not in HOLIDAYS:
            out.append(d)
    return out[::-1]


def bar_ts(day, k):
    return et_to_ts(day, 9, 30) + 300 * k


# ---------------------------------------------------------------- series

def _rsi(closes, n=14):
    g = [max(0.0, closes[i] - closes[i - 1]) for i in range(1, len(closes))]
    lo = [max(0.0, closes[i - 1] - closes[i]) for i in range(1, len(closes))]
    ag, al = sum(g[:n]) / n, sum(lo[:n]) / n
    for i in range(n, len(g)):
        ag, al = (ag * (n - 1) + g[i]) / n, (al * (n - 1) + lo[i]) / n
    return 100 - 100 / (1 + ag / al) if al else 100.0


def daily_closes(rng, last, pattern, n=90):
    """n cierres diarios que acaban en `last` y cumplen la regla del patrón."""
    rets = [rng.gauss(0.0003, 0.011) for _ in range(n)]
    if pattern == "breakout_20d":
        rets[-12:] = [rng.gauss(0.004, 0.006) for _ in range(11)] + [0.021]
    elif pattern == "bull_flag":
        rets[-15:] = [abs(rng.gauss(0.014, 0.004)) for _ in range(10)] + [0.003, -0.004, 0.002, -0.003, 0.004]
    elif pattern == "reclaim_ma20":
        rets[-10:] = [-0.006, -0.008, -0.004, -0.007, -0.005, -0.003, -0.006, -0.004, -0.002, 0.048]
    elif pattern == "oversold":
        rets[-12:] = [-abs(rng.gauss(0.013, 0.004)) for _ in range(12)]
    elif pattern == "oversold_bounce":
        rets[-12:] = [-abs(rng.gauss(0.014, 0.004)) for _ in range(11)] + [0.009]
    else:
        # sin patrón: lateral, sin máximo de 20 días, sin racha y con RSI en zona media
        rets[-22:] = [0.004 * math.sin(i * 1.3) for i in range(21)] + [-0.003]
    path = [1.0]
    for r in rets[1:]:
        path.append(path[-1] * (1 + r))
    return [round(last * p / path[-1], 2) for p in path]


def session_bars(rng, day, start, end, vol_day, sigma=0.0016, waypoints=None):
    """78 velas de 5 minutos de `start` a `end`. waypoints: {índice de vela: cierre}."""
    pts = dict(waypoints or {})
    pts[BARS - 1] = end
    keys = sorted(pts)
    closes, prev_k, prev_p = [], -1, start
    for k in keys:
        span = k - prev_k
        for j in range(1, span + 1):
            base = prev_p + (pts[k] - prev_p) * j / span
            wobble = 0.0 if j == span else rng.gauss(0, sigma * base * min(1.0, span / 6.0))
            closes.append(base + wobble)
        prev_k, prev_p = k, pts[k]
    bars, last = [], start
    for k, c in enumerate(closes):
        o = last
        shape = 1.9 if k == 0 else 1.0 + 0.9 * abs(k - 38) / 38.0
        wick = sigma * c * 0.6 * shape
        h = max(o, c) + abs(rng.gauss(0, wick))
        lo = min(o, c) - abs(rng.gauss(0, wick))
        v = int(vol_day / BARS * shape * (4.0 if k == 0 else 1.0) * rng.uniform(0.7, 1.3))
        bars.append({"t": bar_ts(day, k), "o": round(o, 2), "h": round(h, 2), "l": round(lo, 2),
                     "c": round(c, 2), "v": v})
        last = c
    return bars


def demo_day_bars(rng, sym, prev_close, script, vol_day):
    """El día de demostración, con un guion por valor (rango de apertura 9:30-9:45 = velas 0 a 2)."""
    p = prev_close
    if script == "ruptura_objetivo":      # rompe a las 10:15 y llega al objetivo 2R hacia las 12:30
        way = {0: p * 1.006, 1: p * 1.0105, 2: p * 1.004, 5: p * 1.007, 7: p * 1.0095, 8: p * 1.0175,
               14: p * 1.022, 24: p * 1.030, 36: p * 1.044, 50: p * 1.041, 77: p * 1.046}
    elif script == "ruptura_fallida":     # rompe a las 10:40 y cae hasta el stop hacia las 11:45
        way = {0: p * 1.004, 1: p * 1.009, 2: p * 1.003, 9: p * 1.006, 13: p * 1.0135, 16: p * 1.011,
               22: p * 1.002, 27: p * 0.996, 40: p * 0.991, 77: p * 0.988}
    elif script == "ruptura_tardia":      # rompe a las 13:05, poco recorrido
        way = {0: p * 0.997, 1: p * 1.004, 2: p * 0.999, 20: p * 1.000, 40: p * 1.002, 42: p * 1.009,
               60: p * 1.013, 77: p * 1.011}
    elif script == "ruptura_sin_resolver":  # rompe a las 9:55 y se queda entre el stop y el objetivo
        way = {0: p * 1.003, 1: p * 1.007, 2: p * 1.002, 4: p * 1.0115, 20: p * 1.013, 45: p * 1.010,
               77: p * 1.014}
    elif script == "bajista":             # pierde el rango por abajo
        way = {0: p * 0.998, 1: p * 1.003, 2: p * 0.996, 15: p * 0.990, 40: p * 0.981, 77: p * 0.976}
    else:                                 # lateral: nunca cierra por encima del máximo del rango
        way = {0: p * 1.002, 1: p * 1.008, 2: p * 1.001, 20: p * 1.000, 45: p * 0.999, 77: p * 1.001}
    bars = session_bars(rng, DEMO_DAY, p * 1.001, way[77], vol_day * 1.4, sigma=0.0007, waypoints=way)
    # el máximo del rango lo fija la vela de las 9:35; después de él, ninguna mecha sin cierre lo confunde
    return bars


def build_market(seed=SEED):
    """{ticker: {"name", "daily": [(fecha, cierre, volumen)], "history": {fecha: velas}, "today": velas}}."""
    days = sessions_before(DEMO_DAY, 90)
    market = {}
    for i, (sym, (name, last, pattern, script, vol)) in enumerate(COMPANIES.items()):
        rng = random.Random(seed * 1000 + i)
        closes = daily_closes(rng, last, pattern, len(days))
        daily = [(d, c, int(vol * rng.uniform(0.7, 1.3))) for d, c in zip(days, closes)]
        history = {}
        for j in range(len(days) - 60, len(days)):
            d, c, v = daily[j]
            start = closes[j - 1] * (1 + rng.gauss(0, 0.004))
            history[d] = session_bars(rng, d, start, c, v)
        market[sym] = {"name": name, "daily": daily, "history": history, "prev_close": last,
                       "today": demo_day_bars(rng, sym, last, script, vol), "volume": vol}
    return market


# ---------------------------------------------------------------- formato Yahoo

def yahoo_chart(sym, bars, gran, prev_close, price=None, when=None, volume=None):
    closes = [b["c"] for b in bars]
    meta = {"currency": "USD", "symbol": sym, "exchangeName": "DEMO", "instrumentType": "EQUITY",
            "exchangeTimezoneName": "America/New_York", "dataGranularity": gran,
            "regularMarketPrice": price if price is not None else (closes[-1] if closes else prev_close),
            "regularMarketTime": when if when is not None else (bars[-1]["t"] if bars else 0),
            "regularMarketVolume": volume if volume is not None else sum(b["v"] for b in bars),
            "regularMarketDayHigh": max([b["h"] for b in bars], default=prev_close),
            "regularMarketDayLow": min([b["l"] for b in bars], default=prev_close),
            "previousClose": prev_close, "chartPreviousClose": prev_close}
    quote = {k: [b[s] for b in bars] for k, s in
             (("open", "o"), ("high", "h"), ("low", "l"), ("close", "c"), ("volume", "v"))}
    return {"chart": {"result": [{"meta": meta, "timestamp": [b["t"] for b in bars],
                                  "indicators": {"quote": [quote]}}], "error": None}}


def _dump(path, doc):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        if isinstance(doc, str):
            fh.write(doc)
        else:
            json.dump(doc, fh, separators=(",", ":"))
    os.replace(tmp, path)


# ---------------------------------------------------------------- noticias, SEC, Cámara

HEADLINES = [  # (hora ET, ticker, titular, resumen)
    ((7, 40), "BRISA", "Brisa Motores (BRISA) presenta resultados el jueves tras el cierre",
     "La compañía confirma la fecha de sus resultados trimestrales. Earnings call a las 17:30."),
    ((8, 5), "BRISA", "Un analista sube el precio objetivo de Brisa Motores antes de resultados",
     "Analyst upgrade: mejora de recomendación y nuevo precio objetivo."),
    ((8, 20), "OLMO", "Olmo Semiconductores (OLMO) anuncia una ampliación de capital de 400 millones",
     "Offering de acciones ordinarias para financiar una nueva planta."),
    ((9, 50), "OLMO", "Olmo cae tras fijar el precio de su oferta de acciones",
     "El precio de la offering queda por debajo del cierre del viernes."),
    ((8, 45), "ALBOR", "El regulador aprueba el nuevo tratamiento de Albor Salud (ALBOR)",
     "FDA approval para su fármaco principal, según la compañía."),
    ((10, 30), "NAVIA", "Navia Energía (NAVIA) nombra nueva consejera delegada",
     "El consejo anuncia el relevo del CEO con efecto inmediato."),
    ((11, 15), "VEGA", "Vega Aeroespacial (VEGA) firma un contrato de suministro por 1.200 millones",
     "Acuerdo a cinco años con un operador de satélites."),
    ((12, 40), "BRISA", "Las acciones de Brisa Motores marcan máximos de la sesión",
     "El valor sube con fuerza a media sesión sin noticias nuevas."),
    ((6, 30), "MAREA", "Los futuros apuntan a una apertura al alza antes de los datos de inflación",
     "Macro: el mercado espera el dato de IPC del miércoles. Marea Bank (MAREA) entre los bancos atentos."),
]

FILINGS = [  # (fecha, hora ET, ticker, items, descripción)
    (dt.date(2026, 10, 19), (8, 15), "OLMO", "Items 3.02, 8.01 and 9.01", "Current report"),
    (dt.date(2026, 10, 19), (10, 25), "NAVIA", "Items 5.02 and 9.01", "Current report"),
    (dt.date(2026, 10, 15), (16, 10), "ALBOR", "Items 2.02 and 9.01", "Current report"),
]

RSS = """<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Demo: titulares de %s (inventados)</title>
%s</channel></rss>
"""
RSS_ITEM = ("<item><title>%s</title><link>https://example.invalid/demo/%s</link><guid>demo-%s</guid>"
            "<description>%s</description><pubDate>%s</pubDate></item>\n")
ATOM = """<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><company-info><conformed-name>%s</conformed-name></company-info>
%s</feed>
"""
ATOM_ENTRY = ("<entry><content type=\"text/xml\"><accession-number>%s</accession-number>"
              "<filing-type>8-K</filing-type><form-name>%s</form-name><items-desc>%s</items-desc></content>"
              "<link href=\"https://example.invalid/demo/sec/%s\"/><updated>%s</updated></entry>\n")


def _rfc822(ts):
    return dt.datetime.fromtimestamp(ts, dt.timezone.utc).strftime("%a, %d %b %Y %H:%M:%S +0000")


def _esc(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def company_facts(sym, name, seed):
    """Ocho trimestres y dos ejercicios de cifras XBRL inventadas."""
    rng = random.Random(seed)
    base = rng.uniform(0.8e9, 6e9)
    growth = rng.uniform(-0.02, 0.07)
    gm, om = rng.uniform(0.22, 0.55), rng.uniform(0.04, 0.2)
    shares = rng.uniform(2e8, 9e8)
    q_ends = [dt.date(2024, 12, 31), dt.date(2025, 3, 31), dt.date(2025, 6, 30), dt.date(2025, 9, 30),
              dt.date(2025, 12, 31), dt.date(2026, 3, 31), dt.date(2026, 6, 30)]
    facts = {k: [] for k in ("Revenues", "GrossProfit", "OperatingIncomeLoss", "NetIncomeLoss")}
    eps = []
    year = {2024: {}, 2025: {}}
    rev = base
    # tres trimestres de 2024 para que el cuarto se pueda derivar del ejercicio
    plan = [dt.date(2024, 3, 31), dt.date(2024, 6, 30), dt.date(2024, 9, 30)] + q_ends
    for i, end in enumerate(plan):
        rev *= 1 + growth + rng.gauss(0, 0.015)
        vals = {"Revenues": rev, "GrossProfit": rev * (gm + rng.gauss(0, 0.01)),
                "OperatingIncomeLoss": rev * (om + rng.gauss(0, 0.012))}
        vals["NetIncomeLoss"] = vals["OperatingIncomeLoss"] * rng.uniform(0.7, 0.85)
        start = dt.date(end.year, end.month - 2, 1)
        fy, q = end.year, (end.month - 1) // 3 + 1
        filed = (end + dt.timedelta(days=24)).isoformat()
        for k, v in vals.items():
            year.setdefault(fy, {})[k] = year.get(fy, {}).get(k, 0) + v
        if q == 4:   # el cuarto trimestre no se presenta: solo el ejercicio (10-K)
            for k in facts:
                facts[k].append({"start": "%d-01-01" % fy, "end": end.isoformat(), "val": round(year[fy][k]),
                                 "fy": fy, "fp": "FY", "form": "10-K", "filed": filed,
                                 "accn": "0009000000-%02d-%06d" % (fy % 100, 40 + i)})
            eps.append({"start": "%d-01-01" % fy, "end": end.isoformat(),
                        "val": round(year[fy]["NetIncomeLoss"] / shares, 2), "fy": fy, "fp": "FY",
                        "form": "10-K", "filed": filed, "accn": "0009000000-%02d-%06d" % (fy % 100, 40 + i)})
            continue
        for k, v in vals.items():
            facts[k].append({"start": start.isoformat(), "end": end.isoformat(), "val": round(v), "fy": fy,
                             "fp": "Q%d" % q, "form": "10-Q", "filed": filed,
                             "accn": "0009000000-%02d-%06d" % (fy % 100, 10 + i)})
        eps.append({"start": start.isoformat(), "end": end.isoformat(),
                    "val": round(vals["NetIncomeLoss"] / shares, 2), "fy": fy, "fp": "Q%d" % q, "form": "10-Q",
                    "filed": filed, "accn": "0009000000-%02d-%06d" % (fy % 100, 10 + i)})
    gaap = {k: {"label": k, "units": {"USD": v}} for k, v in facts.items()}
    gaap["EarningsPerShareDiluted"] = {"label": "EPS", "units": {"USD/shares": eps}}
    cik = CIKS[sym]
    cf = {"cik": cik, "entityName": name + " (empresa inventada)", "facts": {"us-gaap": gaap}}
    sub = {"cik": str(cik), "name": name, "filings": {"recent": {
        "form": ["8-K", "10-Q", "8-K"],
        "accessionNumber": ["0009000000-26-000201", "0009000000-26-000016", "0009000000-26-000150"],
        "filingDate": ["2026-07-24", "2026-07-24", "2026-04-24"],
        "reportDate": ["2026-07-24", "2026-06-30", "2026-04-24"],
        "primaryDocument": ["demo-8k.htm", "demo-10q.htm", "demo-8k.htm"],
        "items": ["2.02,9.01", "", "2.02,9.01"]}}}
    return cf, sub


HOUSE_INDEX = """<?xml version="1.0" encoding="utf-8"?>
<FinancialDisclosure>
<Member><Prefix>Hon.</Prefix><Last>Ejemplo</Last><First>Ana</First><Suffix/><FilingType>P</FilingType><StateDst>ZZ01</StateDst><Year>2026</Year><FilingDate>10/14/2026</FilingDate><DocID>29990001</DocID></Member>
<Member><Prefix>Hon.</Prefix><Last>Ejemplo</Last><First>Ana</First><Suffix/><FilingType>P</FilingType><StateDst>ZZ01</StateDst><Year>2026</Year><FilingDate>08/21/2026</FilingDate><DocID>29990002</DocID></Member>
<Member><Prefix>Hon.</Prefix><Last>Muestra</Last><First>Luis</First><Suffix/><FilingType>P</FilingType><StateDst>ZZ02</StateDst><Year>2026</Year><FilingDate>10/09/2026</FilingDate><DocID>29990003</DocID></Member>
<Member><Prefix>Hon.</Prefix><Last>Muestra</Last><First>Luis</First><Suffix/><FilingType>O</FilingType><StateDst>ZZ02</StateDst><Year>2026</Year><FilingDate>05/15/2026</FilingDate><DocID>19990004</DocID></Member>
<Member><Prefix>Hon.</Prefix><Last>Prueba</Last><First>Carmen</First><Suffix/><FilingType>P</FilingType><StateDst>ZZ03</StateDst><Year>2026</Year><FilingDate>09/30/2026</FilingDate><DocID>29990005</DocID></Member>
</FinancialDisclosure>
"""

PTR_TEXT = {
    "29990001": """Name:                 Hon. Ana Ejemplo
Status:               Member
State/District: ZZ01

ID      Owner Asset                                         Transaction Date          Notification Amount
                                                            Type                      Date

        SP    Brisa Motores Common Stock (BRISA) [ST]       P           09/22/2026    09/23/2026   $100,001 - $250,000

              F      S     : New
              D           : Purchased 2,000 shares.

        SP    Olmo Semiconductores Common Stock (OLMO) [OP] P           09/18/2026    09/19/2026   $250,001 - $500,000

              F      S     : New
              D           : Purchased 50 call options with a strike price of $150 and an expiration date of 6/17/27.

              Albor Salud Common Stock (ALBOR) [ST]         S (partial) 08/20/2026    08/21/2026   $15,001 - $50,000

              F      S     : New

* For the complete list of asset type abbreviations, please visit the Clerk's site.

Digitally Signed: Hon. Ana Ejemplo , 10/14/2026
Filing ID #29990001
""",
    "29990003": """Name:                 Hon. Luis Muestra
Status:               Member
State/District: ZZ02

        JT    Vega Aeroespacial Common Stock (VEGA) [ST]    P           09/25/2026    09/26/2026   $1,001 - $15,000

              F      S     : New

Digitally Signed: Hon. Luis Muestra , 10/09/2026
Filing ID #29990003
""",
}


# ---------------------------------------------------------------- escritura

def build(root, seed=SEED):
    """Escribe todo lo que no depende del reloj. Devuelve el mercado generado."""
    market = build_market(seed)
    for sym, m in market.items():
        daily = [{"t": et_to_ts(d, 9, 30), "o": c, "h": c, "l": c, "c": c, "v": v} for d, c, v in m["daily"]]
        _dump(os.path.join(root, "daily", sym + ".json"),
              yahoo_chart(sym, daily, "1d", m["daily"][-2][1], volume=m["daily"][-1][2]))
        cf, sub = company_facts(sym, m["name"], seed * 77 + CIKS[sym])
        _dump(os.path.join(root, "sec", "companyfacts-CIK%010d.json" % CIKS[sym]), cf)
        _dump(os.path.join(root, "sec", "submissions-CIK%010d.json" % CIKS[sym]), sub)
    tickers = {str(i): {"cik_str": CIKS[s], "ticker": s, "title": COMPANIES[s][0]}
               for i, s in enumerate(COMPANIES)}
    _dump(os.path.join(root, "sec", "company_tickers.json"), tickers)
    _dump(os.path.join(root, "news", "company_tickers.json"), tickers)
    _dump(os.path.join(root, "house", "2026FD.xml"), HOUSE_INDEX)
    for doc, text in PTR_TEXT.items():
        _dump(os.path.join(root, "house", doc + ".txt"), text)
    _dump(os.path.join(root, "README.txt"),
          "Datos inventados por mesa/demo.py para el modo demostración. Se pueden borrar.\n")
    return market


def materialize(root, market, clock):
    """Reescribe los ficheros que dependen del reloj. clock: datetime de Nueva York (sin zona)."""
    day = clock.date()
    now_ts = et_to_ts(day, clock.hour, clock.minute)
    for sym, m in market.items():
        hist = [b for d in sorted(m["history"]) for b in m["history"][d]]
        prev = m["prev_close"]
        if day == DEMO_DAY:
            done = [b for b in m["today"] if b["t"] + 300 <= now_ts]
        elif day > DEMO_DAY:
            done = list(m["today"])
        else:
            done = []
        price = done[-1]["c"] if done else prev
        when = min(now_ts, done[-1]["t"] + 300) if done else et_to_ts(sessions_before(DEMO_DAY, 1)[0], 16)
        vol = sum(b["v"] for b in done)
        day_doc = yahoo_chart(sym, done, "5m", prev, price, when, vol)
        _dump(os.path.join(root, "intraday", sym + ".json"), day_doc)
        _dump(os.path.join(root, "quotes", "yahoo-%s.json" % sym), day_doc)
        _dump(os.path.join(root, "news", "chart-%s.json" % sym), day_doc)
        _dump(os.path.join(root, "tm", "%s-60d5m.json" % sym),
              yahoo_chart(sym, hist + done, "5m", prev, price, when, vol))
        items = [RSS_ITEM % (_esc(t), i, i, _esc(desc), _rfc822(et_to_ts(DEMO_DAY, *hm)))
                 for i, (hm, s, t, desc) in enumerate(HEADLINES)
                 if s == sym and et_to_ts(DEMO_DAY, *hm) <= now_ts]
        _dump(os.path.join(root, "news", "yahoo-%s.xml" % sym), RSS % (sym, "".join(items)))
        entries = []
        for j, (d, hm, s, its, form) in enumerate(FILINGS):
            ts = et_to_ts(d, *hm)
            if s == sym and ts <= now_ts:
                acc = "0009000000-26-%06d" % (900 + j)
                stamp = dt.datetime.fromtimestamp(ts, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
                entries.append(ATOM_ENTRY % (acc, form, its, acc, stamp))
        _dump(os.path.join(root, "news", "sec-8-K-%010d.xml" % CIKS[sym]),
              ATOM % (_esc(m["name"]), "".join(entries)))


if __name__ == "__main__":
    import sys
    out = sys.argv[1] if len(sys.argv) > 1 else "demo-data"
    hhmm = sys.argv[2] if len(sys.argv) > 2 else "10:15"
    mk = build(out)
    h, mi = [int(x) for x in hhmm.split(":")]
    materialize(out, mk, dt.datetime.combine(DEMO_DAY, dt.time(h, mi)))
    print("Datos de demostración en %s, reloj %s %s (Nueva York)." % (out, DEMO_DAY, hhmm))
