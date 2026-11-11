#!/usr/bin/env python3
"""Mesa de Operaciones: una interfaz local para los 11 skills de day-trader-skill.

    python3 mesa/server.py            # abre http://127.0.0.1:8765
    python3 mesa/server.py --demo     # arranca en modo demostración (datos inventados)

El servidor no reimplementa nada: cada botón ejecuta el script del skill
correspondiente (.claude/skills/trader-*/) como lo haría Claude, con los mismos
ficheros trader/*.json, y enseña su salida. Solo biblioteca estándar.

No se conecta a ningún bróker y no envía órdenes. Escucha solo en 127.0.0.1.
"""

import argparse
import datetime as dt
import importlib.util
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import demo  # noqa: E402

SKILLS = {
    "scanner": ("trader-scanner", "scan.py"), "news": ("trader-news", "news.py"),
    "analyst": ("trader-analyst", "facts.py"), "pelosi": ("trader-pelosi", "ptr.py"),
    "entry": ("trader-entry", "entry.py"), "exit": ("trader-exit", "exit.py"),
    "tm": ("trader-timemachine", "timemachine.py"), "budget": ("trader-budget", "size.py"),
    "risk": ("trader-risk", "check.py"), "broker": ("trader-broker", "ticket.py"),
    "alerts": ("trader-alerts", "alerts.py"),
}
TICKER = re.compile(r"^[A-Z]{1,5}(\.[A-Z])?$")
HHMM = re.compile(r"^([01]?\d|2[0-3]):[0-5]\d$")
DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
STATE_FILES = ("config", "watchlist", "entry", "plan", "timemachine", "orders", "portfolio", "prices",
               "alerts", "metrics")
STATE_SUB = ("risk", "broker", "alerts", "news", "pelosi")
DAY_FILES = ("entry.json", "plan.json", "timemachine.json", "orders.json")
MAX_OUTPUT = 400000


class BadRequest(Exception):
    pass


# ---------------------------------------------------------------- validación

def _ticker(v):
    s = str(v or "").strip().upper()
    if not TICKER.match(s):
        raise BadRequest("«%s» no es un ticker válido (1 a 5 letras)" % v)
    return s


def _tickers(v, required=False, most=60):
    if isinstance(v, str):
        v = [x for x in re.split(r"[\s,;]+", v) if x]
    out = []
    for x in v or []:
        t = _ticker(x)
        if t not in out:
            out.append(t)
    if required and not out:
        raise BadRequest("indica al menos un ticker")
    if len(out) > most:
        raise BadRequest("demasiados tickers (máximo %d)" % most)
    return out


def _num(v, name, lo=None, hi=None, integer=False):
    try:
        x = float(str(v).replace(",", "."))
    except (TypeError, ValueError):
        raise BadRequest("%s: se esperaba un número" % name)
    if x != x or x in (float("inf"), float("-inf")):
        raise BadRequest("%s: número no válido" % name)
    if lo is not None and x < lo or hi is not None and x > hi:
        raise BadRequest("%s: fuera de rango" % name)
    if integer:
        if x != int(x):
            raise BadRequest("%s: se esperaba un número entero" % name)
        return str(int(x))
    return repr(x) if x != int(x) else str(int(x))


def _hhmm(v, name):
    s = str(v or "").strip()
    if not HHMM.match(s):
        raise BadRequest("%s: se esperaba una hora HH:MM" % name)
    h, m = s.split(":")
    return "%02d:%s" % (int(h), m)


def _date(v, name):
    s = str(v or "").strip()
    if not DATE.match(s):
        raise BadRequest("%s: se esperaba una fecha AAAA-MM-DD" % name)
    return s


def _choice(v, name, options):
    if v not in options:
        raise BadRequest("%s: valor no admitido" % name)
    return v


def _text(v, name, most=200):
    s = str(v or "").strip()
    if not s or len(s) > most or re.search(r"[\x00-\x1f]", s):
        raise BadRequest("%s: texto vacío o no válido" % name)
    return s


def _has(p, key):
    return p.get(key) not in (None, "", [])


# ---------------------------------------------------------------- contexto

class Context(object):
    """Dónde se ejecuta un skill: carpeta de trabajo, modo y reloj."""

    def __init__(self, workspace, mode="real", clock="10:15", skills_dir=None):
        self.real_ws = os.path.abspath(workspace)
        self.demo_ws = os.path.join(self.real_ws, ".mesa", "demo")
        self.mode = mode
        self.clock = clock
        self.skills_dir = skills_dir or find_skills(self.real_ws)
        self._market = None
        self._materialized = None
        self._lock = threading.RLock()

    @property
    def demo(self):
        return self.mode == "demo"

    @property
    def workspace(self):
        return self.demo_ws if self.demo else self.real_ws

    @property
    def data(self):
        return os.path.join(self.demo_ws, "data")

    def script(self, key):
        folder, name = SKILLS[key]
        return os.path.join(self.skills_dir, folder, name)

    def now_ny(self):
        """El reloj fijado en demostración ("2026-10-19 10:15"); None en real."""
        return "%s %s" % (demo.DEMO_DAY.isoformat(), self.clock) if self.demo else None

    def now_utc_iso(self):
        h, m = [int(x) for x in self.clock.split(":")]
        ts = demo.et_to_ts(demo.DEMO_DAY, h, m)
        return dt.datetime.fromtimestamp(ts, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    def prepare(self):
        """Crea la carpeta de trabajo y, en demostración, los datos a la hora del reloj."""
        with self._lock:  # dos peticiones a la vez no deben escribir los mismos ficheros
            return self._prepare()

    def _prepare(self):
        tdir = os.path.join(self.workspace, "trader")
        os.makedirs(os.path.join(tdir, "state"), exist_ok=True)
        cfg = os.path.join(tdir, "config.json")
        created = False
        if not os.path.exists(cfg):
            example = os.path.join(self.skills_dir, "trader-budget", "config.example.json")
            if os.path.exists(example):
                shutil.copyfile(example, cfg)
                created = True
        if self.demo:
            if self._market is None:
                self._market = demo.build(self.data)
            if self._materialized != self.clock:
                h, m = [int(x) for x in self.clock.split(":")]
                demo.materialize(self.data, self._market, dt.datetime.combine(demo.DEMO_DAY, dt.time(h, m)))
                self._materialized = self.clock
        return created


def find_skills(workspace):
    for base in (os.path.join(workspace, ".claude", "skills"), os.path.join(REPO, ".claude", "skills"),
                 os.path.join(os.path.expanduser("~"), ".claude", "skills")):
        if os.path.isfile(os.path.join(base, "trader-risk", "check.py")):
            return base
    return os.path.join(REPO, ".claude", "skills")


# ---------------------------------------------------------------- órdenes de cada skill

def build_command(action, p, ctx):
    """(acción, parámetros) -> lista de argumentos para un script del skill.

    Es la única puerta entre el navegador y el sistema: cada acción está en
    esta lista, cada valor se valida y nada pasa por un intérprete de órdenes."""
    p = p or {}
    key, _, verb = action.partition(".")
    if key not in SKILLS:
        raise BadRequest("acción desconocida: %s" % action)
    a = [sys.executable, ctx.script(key)]
    now = ctx.now_ny()
    off = lambda sub: ["--offline", os.path.join(ctx.data, sub)]  # noqa: E731

    def clock(flag="--now", value=None):
        return [flag, value or now] if ctx.demo else []

    if action == "scanner.universe":
        if ctx.demo:
            raise BadRequest("en demostración el universo son las 12 empresas inventadas")
        return a + ["universe"]
    if action in ("scanner.daily", "scanner.orb"):
        a += [verb, "--json", "--quiet"]
        syms = _tickers(p.get("symbols"), most=400)
        if syms:
            a += ["--symbols", ",".join(syms)]
        elif p.get("use_watchlist"):
            a += ["--watchlist", "trader/watchlist.json"]
        if _has(p, "limit"):
            a += ["--limit", _num(p["limit"], "límite", 1, 20000, True)]
        if _has(p, "min_price"):
            a += ["--min-price", _num(p["min_price"], "precio mínimo", 0, 1e6)]
        if _has(p, "min_volume"):
            a += ["--min-volume", _num(p["min_volume"], "volumen mínimo", 0, 1e12, True)]
        if verb == "orb":
            if _has(p, "or_minutes"):
                a += ["--or-minutes", _num(p["or_minutes"], "minutos del rango", 5, 60, True)]
            if _has(p, "max_confirm"):
                a += ["--max-confirm", _num(p["max_confirm"], "máximo a confirmar", 0, 20000, True)]
            if _has(p, "at") and not ctx.demo:
                a += ["--at", _hhmm(p["at"], "hora de corte")]
        if ctx.demo:
            a += off("daily" if verb == "daily" else "intraday") + clock()
        return a

    if action == "news.check":
        a += ["--json"]
        syms = _tickers(p.get("tickers"))
        if syms:
            a += ["--tickers"] + syms
        if _has(p, "hours"):
            a += ["--hours", _num(p["hours"], "horas", 1, 720)]
        if p.get("all"):
            a += ["--all"]
        if p.get("no_sec"):
            a += ["--no-sec"]
        if _has(p, "forms"):
            forms = [f for f in re.split(r"[\s,]+", str(p["forms"]).upper()) if f]
            if not forms or any(not re.match(r"^[0-9A-Z\-/]{1,10}$", f) for f in forms):
                raise BadRequest("formularios: usa algo como 8-K,10-Q")
            a += ["--forms", ",".join(forms)]
        if _has(p, "move_pct"):
            a += ["--move-pct", _num(p["move_pct"], "movimiento", 0.1, 100)]
        if ctx.demo:
            a += off("news") + ["--now", ctx.now_utc_iso()]
        return a

    if action == "analyst.facts":
        a += _tickers(p.get("tickers"), required=True, most=12) + ["--json", "--metrics", "trader/metrics.json"]
        if _has(p, "quarters"):
            a += ["--quarters", _num(p["quarters"], "trimestres", 2, 16, True)]
        if ctx.demo:
            a += off("sec")
        return a

    if key == "pelosi":
        if verb in ("index", "new"):
            a += [verb, "--json"]
            for m in [x.strip() for x in str(p.get("member") or "").split(",") if x.strip()][:8]:
                a += ["--member", _text(m, "miembro", 60)]
            if _has(p, "since"):
                a += ["--since", _date(p["since"], "desde")]
            if _has(p, "year") and not ctx.demo:
                a += ["--year", _num(p["year"], "año", 2012, 2100, True)]
            if verb == "index":
                a += ["--limit", _num(p.get("limit") or 40, "límite", 1, 500, True)]
            else:
                a += ["--portfolio", "trader/portfolio.json"]
                if p.get("read") and not ctx.demo:
                    a += ["--read", "--pdf-dir", "trader/state/ptr-pdfs"]
            if ctx.demo:
                a += ["--offline", os.path.join(ctx.data, "house", "2026FD.xml")]
                if verb == "new":
                    a += ["--today", demo.DEMO_DAY.isoformat()]
            return a
        if verb == "fetch":
            doc = str(p.get("doc_id") or "").strip()
            if not re.match(r"^\d{6,10}$", doc):
                raise BadRequest("el identificador del documento son solo cifras")
            watch = _tickers(p.get("tickers"))
            tail = (["--tickers"] + watch) if watch else []
            tail += ["--portfolio", "trader/portfolio.json", "--json"]
            filed = ["--filed", _date(p["filed"], "fecha")] if _has(p, "filed") else []
            if ctx.demo:
                text = os.path.join(ctx.data, "house", doc + ".txt")
                if not os.path.exists(text):
                    raise BadRequest("la demostración solo incluye el texto de los documentos 29990001 y 29990003")
                return a + ["parse", text] + filed + tail
            a += ["fetch", doc, "--pdf-dir", "trader/state/ptr-pdfs"] + filed + tail
            if _has(p, "year"):
                a += ["--year", _num(p["year"], "año", 2012, 2100, True)]
            return a

    if key == "entry":
        if verb == "watchlist":
            return a + ["watchlist"] + (off("intraday") + clock() if ctx.demo else [])
        if verb in ("check", "watch"):
            a += [verb, _ticker(p.get("symbol"))]
            setup = _choice(p.get("setup") or "orb", "setup", ("orb", "level"))
            a += ["--setup", setup]
            if setup == "level":
                a += ["--level", _num(p.get("level"), "nivel", 0.01, 1e6)]
            if _has(p, "interval"):
                a += ["--interval", _choice(p["interval"], "intervalo", ("5m", "1m"))]
            if _has(p, "or_minutes"):
                a += ["--or-minutes", _num(p["or_minutes"], "minutos del rango", 5, 60, True)]
            if _has(p, "min_volume_x"):
                a += ["--min-volume-x", _num(p["min_volume_x"], "volumen", 0, 100)]
            if verb == "check":
                a += ["--json"] + (["--write"] if p.get("write") else [])
                if ctx.demo:
                    a += off("intraday") + clock()
            else:
                if _has(p, "until"):
                    a += ["--until", _hhmm(p["until"], "hasta")]
                if ctx.demo:  # reproduce el día desde las 9:30, vela a vela y sin esperar
                    a += off("full") + ["--now", "%s 09:30" % demo.DEMO_DAY.isoformat()]
            return a

    if action == "exit.plan":
        a += ["plan", "--json"]
        if p.get("manual"):
            a += ["--symbol", _ticker(p.get("symbol")), "--entry", _num(p.get("entry"), "entrada", 0.01, 1e6)]
            setup = _choice(p.get("setup") or "orb", "setup", ("orb", "level"))
            a += ["--setup", setup]
            if _has(p, "or_high") and _has(p, "or_low"):
                a += ["--or-high", _num(p["or_high"], "máximo del rango", 0.01, 1e6),
                      "--or-low", _num(p["or_low"], "mínimo del rango", 0.01, 1e6)]
            if _has(p, "time"):
                a += ["--time", _hhmm(p["time"], "hora de entrada")]
        elif _has(p, "entry"):
            a += ["--entry", _num(p["entry"], "entrada", 0.01, 1e6)]
        if _has(p, "stop"):
            a += ["--stop", _rule(p["stop"], ("or-mid", "or-low"), ("price", "pct", "atr"), "stop")]
        if _has(p, "target"):
            a += ["--target", _rule(p["target"], (), ("price",), "objetivo", allow_r=True)]
        if _has(p, "flat_by"):
            a += ["--flat-by", _hhmm(p["flat_by"], "salir antes de")]
        if p.get("write", True):
            a += ["--write"]
        if ctx.demo:
            a += off("intraday") + clock()
        return a
    if action == "exit.show":
        return a + ["show"]

    if action == "tm.run":
        a += ["run", "--json", "--write"]
        for k, flag, lo, hi in (("replays", "--replays", 100, 100000), ("seed", "--seed", 0, 2 ** 31),
                                ("window", "--window", 0, 20)):
            if _has(p, k):
                a += [flag, _num(p[k], k, lo, hi, True)]
        if _has(p, "until"):
            a += ["--until", _hhmm(p["until"], "hasta")]
        if ctx.demo:
            a += off("tm") + clock()
        return a
    if action == "tm.chart":
        return a + ["chart", "--from"]

    if action == "budget.size":
        a += ["--json"]
        if p.get("limit"):
            a += ["--limit"] + ([_num(p["limit_price"], "precio límite", 0.01, 1e6)] if _has(p, "limit_price") else [])
        if _has(p, "budget"):
            a += ["--budget", _num(p["budget"], "presupuesto", 1, 1e9)]
        if p.get("write", True):
            a += ["--write"]
        return a + clock()
    if action == "budget.weights":
        pairs = []
        for part in [x for x in re.split(r"[\s,;]+", str(p.get("weights") or "")) if x]:
            if "=" not in part:
                raise BadRequest("pesos: usa el formato AAPL=40,KO=60")
            t, w = part.split("=", 1)
            pairs.append("%s=%s" % (_ticker(t), _num(w, "peso", 0.01, 100)))
        if not pairs:
            raise BadRequest("pesos: usa el formato AAPL=40,KO=60")
        a += ["--weights", ",".join(pairs)]
        if _has(p, "budget"):
            a += ["--budget", _num(p["budget"], "presupuesto", 1, 1e9)]
        if p.get("whole_shares"):
            a += ["--whole-shares"]
        return a + clock()

    if action == "risk.check":
        return a + ["--json"] + (["--no-write"] if p.get("no_write") else []) + clock()

    if key == "broker":
        idx = lambda: ["--index", _num(p.get("index"), "número de orden", 1, 50, True)]  # noqa: E731
        if verb == "show":
            return a + ["show", "--json"] + clock()
        if verb == "approve":
            reply = str(p.get("reply") or "")
            if not reply.strip() or len(reply) > 200:
                raise BadRequest("escribe tu respuesta para esta orden")
            return a + ["approve"] + idx() + ["--reply", reply] + clock()
        if verb == "decline":
            return a + ["decline"] + idx() + clock()
        if verb == "result":
            a += ["result"] + idx() + ["--status", _choice(p.get("status"), "estado", ("placed", "denied", "failed"))]
            if _has(p, "broker_id"):
                a += ["--broker-id", _text(p["broker_id"], "identificador", 80)]
            if _has(p, "note"):
                a += ["--note", _text(p["note"], "nota", 200)]
            if _has(p, "filled_qty"):
                a += ["--filled-qty", _num(p["filled_qty"], "títulos ejecutados", 0.0001, 1e7),
                      "--filled-price", _num(p.get("filled_price"), "precio de ejecución", 0.01, 1e6)]
            return a + clock()
        if verb == "fill":
            return a + ["fill", "--symbol", _ticker(p.get("symbol")),
                        "--side", _choice(p.get("side"), "lado", ("buy", "sell")),
                        "--qty", _num(p.get("qty"), "títulos", 0.0001, 1e7),
                        "--price", _num(p.get("price"), "precio", 0.01, 1e6)] + clock()
        if verb == "flatten":
            a += ["flatten", "--symbol", _ticker(p.get("symbol"))]
            if _has(p, "qty"):
                a += ["--qty", _num(p["qty"], "títulos", 0.0001, 1e7)]
            return a + clock()
        if verb == "log":
            return a + ["log"] + clock()

    if key == "alerts":
        quotes = off("quotes") if ctx.demo else []
        if verb == "clock":
            return a + ["clock", "--json"] + clock()
        if verb == "check":
            return a + ["check", "--json"] + quotes + clock()
        if verb == "quote":
            syms = _tickers(p.get("symbols"))
            if not syms and not p.get("holdings"):
                raise BadRequest("indica algún ticker o marca «mis posiciones»")
            return a + ["quote"] + syms + (["--holdings"] if p.get("holdings") else []) + \
                ["--write", "--json"] + quotes + clock()
        if verb == "list":
            return a + ["list"]
        if verb == "reset":
            rid = str(p.get("id") or "")
            if not re.match(r"^[A-Za-z0-9._\-]{1,60}$", rid):
                raise BadRequest("identificador de alerta no válido")
            return a + ["reset", rid]
        if verb == "add":
            kind = _choice(p.get("kind"), "tipo", ("from_plan", "opening_bell", "time", "above", "below", "stop",
                                                   "target", "pct"))
            a += ["add"]
            if kind == "from_plan":
                return a + ["--from-plan"]
            if kind == "opening_bell":
                return a + ["--opening-bell"]
            if kind == "time":
                a += ["--at", _hhmm(p.get("at"), "hora"), "--label", _text(p.get("label") or "aviso", "texto", 60)]
                if _has(p, "symbol"):
                    a += ["--symbol", _ticker(p["symbol"])]
                if p.get("before_close"):
                    a += ["--before-close"]
            else:
                a += ["--symbol", _ticker(p.get("symbol"))]
                if kind == "pct":
                    a += ["--pct", _num(p.get("value"), "porcentaje", 0.1, 100)]
                    if _has(p, "direction"):
                        a += ["--direction", _choice(p["direction"], "dirección", ("up", "down"))]
                else:
                    a += ["--" + kind, _num(p.get("value"), "precio", 0.01, 1e6)]
                    if p.get("rearm"):
                        a += ["--rearm"]
            if _has(p, "date"):
                a += ["--date", _date(p["date"], "fecha")]
            return a
    raise BadRequest("acción desconocida: %s" % action)


def _rule(v, words, prefixes, name, allow_r=False):
    s = str(v).strip()
    if s in words:
        return s
    if allow_r and re.match(r"^\d+(\.\d+)?R$", s):
        return s
    m = re.match(r"^(%s):(\d+(\.\d+)?)$" % "|".join(prefixes), s) if prefixes else None
    if m:
        return s
    raise BadRequest("%s: regla no admitida (%s)" % (name, s))


# ---------------------------------------------------------------- trabajos

class Jobs(object):
    """Ejecuta los scripts de uno en uno (comparten ficheros); las vigilancias van aparte."""

    def __init__(self):
        self.jobs = {}
        self.lock = threading.Lock()
        self.serial = threading.Lock()
        self.n = 0

    def start(self, action, steps, cwd, background=False):
        with self.lock:
            self.n += 1
            jid = "j%d" % self.n
            job = {"id": jid, "action": action, "status": "running", "stdout": "", "stderr": "", "code": None,
                   "cmd": "", "started": time.time(), "ended": None, "background": background, "proc": None}
            self.jobs[jid] = job
            for old in sorted(self.jobs, key=lambda k: self.jobs[k]["started"])[:-40]:
                if self.jobs[old]["status"] != "running":
                    del self.jobs[old]
        threading.Thread(target=self._run, args=(job, steps, cwd, background), daemon=True).start()
        return jid

    def _run(self, job, steps, cwd, background):
        lock = None if background else self.serial
        if lock:
            lock.acquire()
        try:
            for step in steps:
                argv = step(job) if callable(step) else step
                if argv is None:
                    break
                job["cmd"] = (job["cmd"] + "\n" if job["cmd"] else "") + pretty(argv)
                code = self._exec(job, argv, cwd, 6 * 3600 if background else 1500)
                job["code"] = code
                if code != 0 and len(steps) > 1:
                    break
        except BadRequest as e:
            job["stderr"] += "%s\n" % e
            job["code"] = 2
        except Exception as e:  # un fallo del servidor no debe dejar el trabajo colgado
            job["stderr"] += "error interno: %s\n" % e
            job["code"] = 2
        finally:
            if lock:
                lock.release()
            job["status"] = "cancelled" if job.get("cancelled") else "done"
            job["ended"] = time.time()
            job["proc"] = None

    def _exec(self, job, argv, cwd, timeout):
        env = dict(os.environ, PYTHONUNBUFFERED="1", PYTHONIOENCODING="utf-8")
        proc = subprocess.Popen(argv, cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                stdin=subprocess.DEVNULL, text=True, encoding="utf-8", errors="replace")
        job["proc"] = proc
        job["last_stdout_from"] = len(job["stdout"])

        def pump(stream, key):
            for line in stream:
                if len(job[key]) < MAX_OUTPUT:
                    job[key] += line
        threads = [threading.Thread(target=pump, args=(proc.stdout, "stdout"), daemon=True),
                   threading.Thread(target=pump, args=(proc.stderr, "stderr"), daemon=True)]
        for t in threads:
            t.start()
        try:
            proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            proc.kill()
            job["stderr"] += "detenido: superó el tiempo máximo\n"
        for t in threads:
            t.join(timeout=5)
        proc.stdout.close()
        proc.stderr.close()
        return proc.returncode

    def cancel(self, jid):
        job = self.jobs.get(jid)
        if job and job["status"] == "running":
            job["cancelled"] = True
            if job.get("proc"):
                job["proc"].terminate()
            return True
        return False

    def public(self, job):
        out = {k: job[k] for k in ("id", "action", "status", "stdout", "stderr", "code", "cmd", "started", "ended",
                                   "background")}
        if job["status"] != "running":
            text = job["stdout"][job.get("last_stdout_from", 0):].strip()
            if text[:1] in "[{":
                try:
                    out["json"] = json.loads(text)
                except ValueError:
                    pass
        return out


def pretty(argv):
    """La orden tal como se escribiría a mano, con rutas cortas."""
    parts = []
    for i, x in enumerate(argv):
        if i == 0:
            x = "python3"
        elif i == 1:
            x = os.path.join(os.path.basename(os.path.dirname(x)), os.path.basename(x))
        elif os.path.isabs(x):
            x = os.path.join("…", os.path.basename(os.path.dirname(x)), os.path.basename(x))
        parts.append('"%s"' % x if re.search(r"\s", x) else x)
    return " ".join(parts)


# ---------------------------------------------------------------- aplicación

def read_json(path):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def write_json(path, doc):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, indent=2, ensure_ascii=False)
        fh.write("\n")
    os.replace(tmp, path)


_modules = {}


def skill_module(ctx, key):
    """Carga el script de un skill como módulo, para reutilizar su reloj y su lector de gráficos."""
    path = ctx.script(key)
    if path not in _modules:
        spec = importlib.util.spec_from_file_location("mesa_skill_" + key, path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        _modules[path] = mod
    return _modules[path]


CONFIG_NUMBERS = {  # clave: (mínimo, máximo, entero)
    "budget": (1, 1e9, False), "cash_buffer_pct": (0, 100, False), "max_position_pct": (1, 100, False),
    "max_order_usd": (1, 1e9, False), "min_order_usd": (0, 1e9, False),
    "max_loss_per_trade_usd": (0.01, 1e9, False), "max_daily_loss_usd": (0.01, 1e9, False),
    "max_trades_per_day": (1, 100, True), "max_orders_per_day": (1, 500, True), "min_reward_risk": (0, 20, False),
}
CONFIG_TIMES = ("no_entries_before", "no_entries_after", "flat_by")
CONFIG_BOOLS = ("require_stop", "fractional", "pdt_guard")
# paper, allow_options, allow_margin y allow_short no se tocan desde aquí: pasar a real o abrir
# opciones, margen o cortos es una decisión que el usuario toma a mano en su config.json.


def merge_config(old, new):
    cfg = dict(old or {})
    for k, (lo, hi, integer) in CONFIG_NUMBERS.items():
        if k in new:
            v = float(_num(new[k], k, lo, hi, integer))
            cfg[k] = int(v) if integer or v == int(v) else v
    for k in CONFIG_TIMES:
        if k in new:
            if new[k] in (None, "") and k != "flat_by":
                cfg[k] = None
            else:
                cfg[k] = _hhmm(new[k], k)
    for k in CONFIG_BOOLS:
        if k in new:
            cfg[k] = bool(new[k])
    if "blocked" in new:
        cfg["blocked"] = _tickers(new["blocked"], most=200)
    if "broker" in new:
        cfg["broker"] = _choice(new["broker"], "bróker", ("alpaca", "ibkr"))
    if "sec_user_agent" in new:
        ua = str(new["sec_user_agent"] or "").strip()
        if len(ua) > 200 or re.search(r"[\x00-\x1f]", ua):
            raise BadRequest("identificación para la SEC no válida")
        cfg["sec_user_agent"] = ua
    if cfg.get("max_loss_per_trade_usd", 0) > cfg.get("max_daily_loss_usd", 1e18):
        raise BadRequest("la pérdida máxima por operación no puede superar la pérdida máxima diaria")
    return cfg


class App(object):
    def __init__(self, workspace, mode="real", clock="10:15"):
        self.ctx = Context(workspace, mode, clock)
        self.jobs = Jobs()
        self.token = secrets.token_urlsafe(24)
        self.created_config = self.ctx.prepare()

    # ---- lectura
    def state(self):
        ctx = self.ctx
        tdir = os.path.join(ctx.workspace, "trader")
        files = {k: read_json(os.path.join(tdir, k + ".json")) for k in STATE_FILES}
        files["state"] = {k: read_json(os.path.join(tdir, "state", k + ".json")) for k in STATE_SUB}
        try:
            alerts = skill_module(ctx, "alerts")
            market = alerts.market_status(alerts.parse_now(ctx.now_ny()))
        except Exception as e:
            market = {"error": str(e)}
        missing = [SKILLS[k][0] for k in SKILLS if not os.path.isfile(ctx.script(k))]
        ua = str((files["config"] or {}).get("sec_user_agent") or os.environ.get("SEC_USER_AGENT") or "")
        running = [self.jobs.public(j) for j in list(self.jobs.jobs.values())
                   if j["status"] == "running" and j["background"]]
        return {"mode": ctx.mode, "clock": ctx.clock, "demo_day": demo.DEMO_DAY.isoformat(),
                "workspace": os.path.join(ctx.workspace, "trader"), "files": files, "market": market,
                "missing_skills": missing, "sec_ua_ok": bool(ua) and "you@example.com" not in ua,
                "pdftotext": bool(shutil.which("pdftotext")), "config_from_example": self.created_config,
                "universe": os.path.isfile(os.path.join(tdir, "universe.txt")),
                "demo_symbols": {s: v[0] for s, v in demo.COMPANIES.items()} if ctx.demo else {},
                "watches": running}

    def chart(self, symbol):
        ctx = self.ctx
        sym = _ticker(symbol)
        entry = skill_module(ctx, "entry")
        try:
            if ctx.demo:
                ctx.prepare()
                ch = entry.get_chart(sym, "5m", offline=os.path.join(ctx.data, "intraday"))
            else:
                ch = entry.get_chart(sym, "5m")
        except entry.EntryError as e:
            raise BadRequest(str(e))
        bars = []
        for b in ch["bars"]:
            if b["t"] % 300:
                continue  # el tick en vivo no es una vela
            local = entry.to_eastern(entry.utc_of(b["t"]))
            if not (dt.time(9, 30) <= local.time() < dt.time(16, 0)):
                continue
            bars.append({"time": local.strftime("%H:%M"), "date": local.date().isoformat(),
                         "o": b["o"], "h": b["h"], "l": b["l"], "c": b["c"], "v": b["v"]})
        if bars:
            last = bars[-1]["date"]
            bars = [b for b in bars if b["date"] == last]
        return {"symbol": sym, "bars": bars, "prev_close": ch.get("prev_close"),
                "source": "datos inventados" if ctx.demo else "Yahoo (gratis, no oficial, puede ir con retraso)"}

    # ---- escritura
    def run(self, action, params):
        ctx = self.ctx
        ctx.prepare()
        if action == "broker.simulate":
            steps = self._simulate_steps(params or {})
            return self.jobs.start(action, steps, ctx.workspace)
        if action == "entry.watch" and ctx.demo:
            self._full_day_folder()
        argv = build_command(action, params, ctx)
        return self.jobs.start(action, [argv], ctx.workspace, background=(action == "entry.watch"))

    def _full_day_folder(self):
        """La vigilancia en demostración reproduce el día entero: necesita todas las velas."""
        full = os.path.join(self.ctx.data, "full")
        for sym, m in self.ctx._market.items():
            bars = m["today"]
            demo._dump(os.path.join(full, sym + ".json"),
                       demo.yahoo_chart(sym, bars, "5m", m["prev_close"], bars[-1]["c"], bars[-1]["t"] + 300))

    def _simulate_steps(self, p):
        """Ejecución simulada en papel: lee una cotización y la registra como resultado de la orden.
        No sale nada de este ordenador; ticket.py exige igualmente el PASS de hoy y el sí escrito."""
        ctx = self.ctx
        index = int(_num(p.get("index"), "número de orden", 1, 50, True))
        orders = (read_json(os.path.join(ctx.workspace, "trader", "orders.json")) or {}).get("orders") or []
        if index > len(orders):
            raise BadRequest("no existe la orden %d" % index)
        order = orders[index - 1]
        sym = _ticker(order.get("symbol"))
        if not order.get("qty"):
            raise BadRequest("la simulación solo admite órdenes en títulos")
        quote = build_command("alerts.quote", {"symbols": [sym]}, ctx)

        def result(job):
            price = ((read_json(os.path.join(ctx.workspace, "trader", "prices.json")) or {}).get("prices") or {}).get(sym)
            if not price:
                raise BadRequest("no hay cotización de %s para simular la ejecución" % sym)
            if order.get("type") == "limit" and order.get("limit_price"):
                price = float(order["limit_price"])
            return build_command("broker.result", {
                "index": index, "status": "placed", "broker_id": "simulacion-%d" % int(time.time()),
                "filled_qty": order["qty"], "filled_price": price,
                "note": "ejecución simulada en la Mesa, no enviada a ningún bróker"}, ctx)
        return [quote, result]

    def set_mode(self, mode, clock=None):
        ctx = self.ctx
        ctx.mode = _choice(mode, "modo", ("real", "demo"))
        if clock:
            c = _hhmm(clock, "reloj")
            if not ("04:00" <= c <= "20:00"):
                raise BadRequest("el reloj de la demostración va de 04:00 a 20:00")
            ctx.clock = c
        ctx.prepare()

    def save_config(self, new):
        path = os.path.join(self.ctx.workspace, "trader", "config.json")
        cfg = merge_config(read_json(path), new or {})
        write_json(path, cfg)
        self.created_config = False
        return cfg

    def reset(self, scope):
        ctx = self.ctx
        tdir = os.path.join(ctx.workspace, "trader")
        if scope == "day":
            for name in DAY_FILES:
                p = os.path.join(tdir, name)
                if os.path.exists(p):
                    os.remove(p)
        elif scope == "demo":
            if not ctx.demo:
                raise BadRequest("solo se puede borrar la carpeta de la demostración")
            shutil.rmtree(tdir, ignore_errors=True)
            ctx.clock = "09:00"
            ctx._materialized = None
            ctx.prepare()
        else:
            raise BadRequest("ámbito desconocido")


STATIC = {"/": ("index.html", "text/html; charset=utf-8"), "/app.js": ("app.js", "text/javascript; charset=utf-8"),
          "/charts.js": ("charts.js", "text/javascript; charset=utf-8"),
          "/styles.css": ("styles.css", "text/css; charset=utf-8")}


def make_handler(app):
    class Handler(BaseHTTPRequestHandler):
        server_version = "Mesa/1.0"

        def log_message(self, *args):
            pass

        def _send(self, code, body, ctype="application/json; charset=utf-8"):
            data = body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'")
            self.end_headers()
            self.wfile.write(data)

        def _local(self):
            """Solo se atiende a este ordenador: rechaza otros nombres de host (DNS rebinding)."""
            host = (self.headers.get("Host") or "").rsplit(":", 1)[0].strip("[]")
            return host in ("127.0.0.1", "localhost", "::1")

        def do_GET(self):
            if not self._local():
                return self._send(403, {"error": "solo local"})
            path = self.path.split("?", 1)[0]
            if path in STATIC:
                name, ctype = STATIC[path]
                with open(os.path.join(HERE, "web", name), "rb") as fh:
                    data = fh.read()
                if name == "index.html":
                    data = data.replace(b"__MESA_TOKEN__", app.token.encode())
                return self._send(200, data, ctype)
            try:
                if path == "/api/state":
                    return self._send(200, app.state())
                if path.startswith("/api/job/"):
                    job = app.jobs.jobs.get(path.rsplit("/", 1)[1])
                    return self._send(200, app.jobs.public(job)) if job else self._send(404, {"error": "no existe"})
                if path.startswith("/api/chart/"):
                    return self._send(200, app.chart(path.rsplit("/", 1)[1]))
            except BadRequest as e:
                return self._send(400, {"error": str(e)})
            except Exception as e:
                return self._send(500, {"error": "error interno: %s" % e})
            self._send(404, {"error": "no existe"})

        def do_POST(self):
            if not self._local() or self.headers.get("X-Mesa-Token") != app.token:
                return self._send(403, {"error": "petición no autorizada: recarga la página"})
            try:
                n = int(self.headers.get("Content-Length") or 0)
                if n > 200000:
                    raise BadRequest("petición demasiado grande")
                body = json.loads(self.rfile.read(n).decode("utf-8") or "{}")
                if not isinstance(body, dict):
                    raise BadRequest("cuerpo no válido")
                path = self.path.split("?", 1)[0]
                if path == "/api/run":
                    return self._send(200, {"job": app.run(str(body.get("action") or ""), body.get("params"))})
                if path == "/api/cancel":
                    return self._send(200, {"ok": app.jobs.cancel(str(body.get("job") or ""))})
                if path == "/api/mode":
                    app.set_mode(body.get("mode"), body.get("clock"))
                    return self._send(200, app.state())
                if path == "/api/config":
                    return self._send(200, {"config": app.save_config(body.get("config"))})
                if path == "/api/reset":
                    app.reset(body.get("scope"))
                    return self._send(200, app.state())
            except BadRequest as e:
                return self._send(400, {"error": str(e)})
            except ValueError:
                return self._send(400, {"error": "JSON no válido"})
            except Exception as e:
                return self._send(500, {"error": "error interno: %s" % e})
            self._send(404, {"error": "no existe"})
    return Handler


def main(argv=None):
    ap = argparse.ArgumentParser(description="Mesa de Operaciones: interfaz local para day-trader-skill.")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--workspace", default=REPO, help="carpeta donde vive trader/ (por defecto, este repositorio)")
    ap.add_argument("--demo", action="store_true", help="arranca en modo demostración, con datos inventados")
    ap.add_argument("--no-browser", action="store_true")
    a = ap.parse_args(argv)
    app = App(a.workspace, "demo" if a.demo else "real", "09:00" if a.demo else "10:15")
    httpd = ThreadingHTTPServer(("127.0.0.1", a.port), make_handler(app))
    url = "http://127.0.0.1:%d/" % a.port
    print("Mesa de Operaciones en %s (Ctrl+C para salir)" % url)
    print("Skills: %s" % app.ctx.skills_dir)
    print("Datos:  %s" % os.path.join(app.ctx.workspace, "trader"))
    if not a.no_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nHasta luego.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
