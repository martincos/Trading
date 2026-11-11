"""Pruebas de la Mesa de Operaciones: python3 -m unittest discover -s tests -p "test_*.py"

Ejecutan los scripts reales de los skills sobre el mercado inventado de mesa/demo.py."""
import json
import os
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "mesa"))
import server  # noqa: E402


def wait(app, jid):
    for _ in range(600):
        job = app.jobs.jobs[jid]
        if job["status"] != "running":
            return app.jobs.public(job)
        time.sleep(0.05)
    raise AssertionError("el trabajo no terminó")


class Commands(unittest.TestCase):
    def setUp(self):
        self.ctx = server.Context(tempfile.mkdtemp(), "real")

    def cmd(self, action, **p):
        return server.build_command(action, p, self.ctx)

    def test_rejects_what_is_not_a_ticker(self):
        for bad in ("TSLA; rm -rf /", "--offline", "../x", "TOOLONG", ""):
            with self.assertRaises(server.BadRequest):
                self.cmd("entry.check", symbol=bad)

    def test_rejects_unknown_actions_and_rules(self):
        with self.assertRaises(server.BadRequest):
            self.cmd("shell.run")
        with self.assertRaises(server.BadRequest):
            self.cmd("exit.plan", stop="price:1 --write /etc/passwd")
        with self.assertRaises(server.BadRequest):
            self.cmd("alerts.reset", id="a b")

    def test_real_mode_has_no_clock_or_offline(self):
        argv = self.cmd("entry.check", symbol="tsla", write=True)
        self.assertEqual(argv[2:4], ["check", "TSLA"])
        self.assertNotIn("--now", argv)
        self.assertNotIn("--offline", argv)

    def test_demo_mode_pins_clock_and_reads_local_files(self):
        self.ctx.mode, self.ctx.clock = "demo", "10:15"
        argv = self.cmd("risk.check")
        self.assertEqual(argv[-2:], ["--now", "2026-10-19 10:15"])
        self.assertIn("--offline", self.cmd("scanner.orb"))

    def test_reply_is_passed_word_for_word(self):
        argv = self.cmd("broker.approve", index=1, reply="yes, place it")
        self.assertEqual(argv[argv.index("--reply") + 1], "yes, place it")

    def test_config_never_switches_to_live(self):
        old = {"paper": True, "allow_options": False, "budget": 5000, "max_daily_loss_usd": 150}
        new = server.merge_config(old, {"paper": False, "allow_options": True, "allow_short": True, "budget": 800})
        self.assertTrue(new["paper"])
        self.assertFalse(new["allow_options"])
        self.assertNotIn("allow_short", new)
        self.assertEqual(new["budget"], 800)
        with self.assertRaises(server.BadRequest):
            server.merge_config(old, {"max_loss_per_trade_usd": 500})


class DemoDay(unittest.TestCase):
    """Un día entero con los 11 skills, en el mercado inventado."""

    @classmethod
    def setUpClass(cls):
        cls.app = server.App(tempfile.mkdtemp(), "demo", "09:00")

    def run_(self, action, **params):
        return wait(self.app, self.app.run(action, params))

    def test_full_day(self):
        app = self.app
        app.set_mode("demo", "09:00")
        daily = self.run_("scanner.daily")
        self.assertEqual(daily["code"], 0, daily["stderr"])
        self.assertIn("BRISA", [x["symbol"] for x in daily["json"]["hits"]])
        self.assertEqual(self.run_("scanner.orb")["code"], 1)      # a las 9:00 aún no hay rango

        app.set_mode("demo", "10:15")
        orb = self.run_("scanner.orb")
        self.assertIn("BRISA", [x["symbol"] for x in orb["json"]["hits"]])
        news = self.run_("news.check", tickers="BRISA OLMO")
        self.assertTrue(any("BRISA" in it["touches"] for it in news["json"]["items"]))
        facts = self.run_("analyst.facts", tickers="BRISA")
        self.assertEqual(len(facts["json"][0]["result"]["rows"]), 6)
        idx = self.run_("pelosi.index", member="Ejemplo")
        self.assertEqual(len(idx["json"]), 2)
        ptr = self.run_("pelosi.fetch", doc_id="29990001", filed="2026-10-14")
        self.assertEqual(len(ptr["json"]["rows"]), 3)

        self.assertEqual(self.run_("entry.check", symbol="TEJO")["json"]["status"], "waiting")
        entry = self.run_("entry.check", symbol="BRISA", write=True)
        self.assertEqual(entry["json"]["status"], "triggered")
        bad = self.run_("exit.plan", stop="price:999")
        self.assertNotEqual(bad["code"], 0)                        # stop por encima de la entrada: negativa
        plan = self.run_("exit.plan", stop="or-mid", target="2R")
        self.assertEqual(plan["json"]["reward_risk"], 2.0)
        tm = self.run_("tm.run", until="15:55")
        self.assertEqual(tm["code"], 0, tm["stderr"])
        saved = app.state()["files"]["timemachine"]
        self.assertEqual(saved["mc"]["seed"], 19)
        self.assertAlmostEqual(saved["mc"]["p_target"] + saved["mc"]["p_stop"] + saved["mc"]["p_neither"], 1, 2)
        size = self.run_("budget.size")
        qty = size["json"]["sizing"]["qty"]
        self.assertGreater(qty, 0)
        self.assertLessEqual(size["json"]["sizing"]["max_loss"], 50)

        early = self.run_("broker.approve", index=1, reply="yes")  # sin control de riesgo no hay sí que valga
        self.assertNotEqual(early["code"], 0)
        risk = self.run_("risk.check")
        self.assertEqual(risk["json"]["results"][0]["verdict"], "PASS")
        self.assertNotEqual(self.run_("broker.approve", index=1, reply="sure")["code"], 0)
        self.assertEqual(self.run_("broker.approve", index=1, reply="yes")["code"], 0)
        sim = self.run_("broker.simulate", index=1)
        self.assertEqual(sim["code"], 0, sim["stderr"])
        pos = app.state()["files"]["portfolio"]["positions"]
        self.assertEqual((pos[0]["ticker"], pos[0]["shares"]), ("BRISA", qty))

        self.assertEqual(self.run_("alerts.add", kind="from_plan")["code"], 0)
        self.assertEqual(self.run_("alerts.check")["json"]["rings"], [])
        app.set_mode("demo", "12:30")
        rings = self.run_("alerts.check")["json"]["rings"]
        self.assertEqual([r["id"] for r in rings], ["brisa-plan-target"])

        app.set_mode("demo", "15:55")
        self.assertEqual(self.run_("broker.flatten", symbol="BRISA")["code"], 0)
        late = self.run_("risk.check")                             # salir nunca se bloquea por la ventana
        self.assertEqual(late["json"]["results"][0]["verdict"], "PASS")
        self.assertEqual(self.run_("broker.approve", index=1, reply="yes")["code"], 0)
        self.assertEqual(self.run_("broker.simulate", index=1)["code"], 0)
        self.assertEqual([p for p in app.state()["files"]["portfolio"]["positions"] if p["shares"] > 0], [])

    def test_chart_shows_only_closed_bars(self):
        self.app.set_mode("demo", "10:17")
        bars = self.app.chart("BRISA")["bars"]
        self.assertEqual(bars[-1]["time"], "10:10")


class Http(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = server.App(tempfile.mkdtemp(), "demo", "09:00")
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.make_handler(cls.app))
        cls.base = "http://127.0.0.1:%d" % cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def post(self, path, body, headers):
        req = urllib.request.Request(self.base + path, json.dumps(body).encode(), headers)
        try:
            with urllib.request.urlopen(req) as r:
                return r.status
        except urllib.error.HTTPError as e:
            return e.code

    def test_writes_need_the_page_token(self):
        self.assertEqual(self.post("/api/run", {"action": "alerts.clock"}, {}), 403)
        self.assertEqual(self.post("/api/run", {"action": "alerts.clock"}, {"X-Mesa-Token": self.app.token}), 200)

    def test_other_hosts_are_refused(self):
        self.assertEqual(self.post("/api/run", {"action": "alerts.clock"},
                                   {"X-Mesa-Token": self.app.token, "Host": "evil.example"}), 403)

    def test_page_carries_the_token(self):
        with urllib.request.urlopen(self.base + "/") as r:
            self.assertIn(self.app.token, r.read().decode())


if __name__ == "__main__":
    unittest.main()
