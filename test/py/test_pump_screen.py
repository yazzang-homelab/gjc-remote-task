"""worker/box/rt-boxpump.py 상류 응답 지문 검사(계획 §16.6): 비밀 조각이 박스로 한 바이트도 넘어가지 않는다."""
import hashlib
import importlib.util
import json
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
PUMP = os.path.join(HERE, "..", "..", "worker", "box", "rt-boxpump.py")
BUNDLE = os.path.join(HERE, "..", "..", "worker", "bundle")
KEY = b"ocxk-TEST0123456789abcdefghijklmnopqrstuvwxyzAB"
OTHER = b"ghp_FAKEtoken0123456789abcdefghijklmnop"


def load_pump():
    d = tempfile.mkdtemp()
    with open(os.path.join(d, "key"), "wb") as f:
        f.write(KEY + b"\n")
    with open(os.path.join(d, "pump.json"), "w") as f:
        json.dump({"job": "j", "gen": 1, "driver": "/nonexistent/rt-box-ssh", "target": {"kind": "box", "driver": "ssh", "host": "h"},
                   "lport": 1, "key_file": os.path.join(d, "key")}, f)
    # 지문 파일은 pump와 같은 폴더에서 읽는다 → 시험용 사본 폴더를 만든다.
    w = tempfile.mkdtemp()
    for src, name in ((PUMP, "rt-boxpump.py"), (os.path.join(BUNDLE, "rtlib.py"), "rtlib.py")):
        with open(src, "rb") as a, open(os.path.join(w, name), "wb") as b:
            b.write(a.read())
    with open(os.path.join(w, "fingerprints.json"), "w") as f:
        json.dump([{"name": "gh", "len": len(OTHER), "sha256": hashlib.sha256(OTHER).hexdigest()}], f)
    argv = sys.argv
    sys.argv = ["rt-boxpump.py", d]
    try:
        spec = importlib.util.spec_from_file_location("rt_boxpump_t", os.path.join(w, "rt-boxpump.py"))
        m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(m)
    finally:
        sys.argv = argv
    return m


class Screen(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.p = load_pump()

    def run_chunks(self, chunks):
        out = []
        try:
            for c in self.p.screened(iter(chunks)):
                out.append(c)
        except self.p.SecretHit as e:
            return b"".join(out), sorted(set(e.args[0]))
        return b"".join(out), None

    def test_clean_passes_unchanged(self):
        body = [b'data: {"type":"response.output_text.delta","delta":"\xea\xb0\x80\xeb\x82\x98 ok"}\n\n'] * 50
        out, hit = self.run_chunks(body)
        self.assertIsNone(hit)
        self.assertEqual(out, b"".join(body))

    def test_hub_key_split_across_chunks_never_forwarded(self):
        stream = b'data: {"delta":"x"}\n\n' * 40 + b'data: {"delta":"' + KEY + b'"}\n\n'
        for cut in (len(stream) - len(KEY) - 3, len(stream) - len(KEY) // 2 - 5, len(stream) - 6):
            out, hit = self.run_chunks([stream[:cut], stream[cut:]])
            self.assertEqual(hit, ["gjc-rt-hub-key"])
            self.assertNotIn(KEY[:4], out)  # 비밀의 앞부분도 넘어가지 않는다

    def test_host_fingerprint_in_error_body(self):
        out, hit = self.run_chunks([b'{"error":{"message":"bad token ' + OTHER + b'"}}'])
        self.assertEqual(hit, ["gh"])
        self.assertEqual(out, b"")

    def test_byte_by_byte(self):
        stream = b"prefix " + KEY + b" suffix"
        out, hit = self.run_chunks([bytes([b]) for b in stream])
        self.assertEqual(hit, ["gjc-rt-hub-key"])
        self.assertNotIn(KEY[:2], out)

    def test_no_prefix_in_loaded_fps(self):
        self.assertTrue(all(set(fp) == {"name", "len", "sha256"} for fp in self.p.FPS))


class ReleaseCheck(unittest.TestCase):
    """제어 표식이 없는(evidence_missing) 잡: 대기줄 작업이 끝났을 때만 미시작으로 반납한다."""

    def run_check(self, qstate, box_res):
        p = load_pump()
        p.q = lambda *a, **k: type("R", (), {"stdout": json.dumps(box_res).encode(), "returncode": 0})()
        p.unit_cpu_s = lambda: 0.0
        p.save_state(queue=None if qstate is None else {"state": qstate, "exit": "92"})
        p.release_check()
        with open(os.path.join(p.SPOOL, "pump-state.json")) as f:
            return json.load(f)["release"]

    def test_queue_failed_before_prepare(self):
        r = self.run_check("failed", {"release": False, "reason": "evidence_missing"})
        self.assertEqual(r, {"release": True, "proof": "queue_ended_unprepared", "queue": "failed"})

    def test_queue_still_running_keeps_slot(self):
        self.assertEqual(self.run_check("running", {"release": False, "reason": "evidence_missing"})["release"], False)
        self.assertEqual(self.run_check(None, {"release": False, "reason": "evidence_missing"})["release"], False)

    def test_other_reasons_untouched(self):
        r = self.run_check("done", {"release": False, "reason": "needs_reconcile"})
        self.assertEqual(r, {"release": False, "reason": "needs_reconcile"})


class ScreenIncremental(unittest.TestCase):
    """증분 검사(새 바이트에서 끝나는 창만 봄)가 전체 검사와 같은 판정을 내는지: 무작위 쪼개기·위치."""
    @classmethod
    def setUpClass(cls):
        cls.p = load_pump()

    def verdict(self, chunks):
        try:
            for _ in self.p.screened(iter(chunks)):
                pass
            return False
        except self.p.SecretHit:
            return True

    def test_matches_full_scan_on_random_splits(self):
        import random
        rnd = random.Random(7)
        rtlib = self.p.rtlib
        for trial in range(300):
            parts = [rnd.choice([b"data: ", b'{"a":"', b"xyz", b" ", b"\n", b"abc_DEF-123", KEY[: rnd.randint(1, len(KEY))]]) for _ in range(rnd.randint(1, 40))]
            if rnd.random() < 0.4:
                parts.insert(rnd.randint(0, len(parts)), rnd.choice([KEY, OTHER]))
            text = b"".join(parts)
            cuts = sorted(rnd.sample(range(1, len(text)), min(len(text) - 1, rnd.randint(0, 30)))) if len(text) > 1 else []
            chunks = [text[a:b] for a, b in zip([0] + cuts, cuts + [len(text)])]
            want = bool(rtlib.fingerprint_hits(text, self.p.FPS))
            self.assertEqual(self.verdict(chunks), want, (trial, text, cuts))

    def test_min_end_skips_only_old_windows(self):
        rtlib = self.p.rtlib
        fp = [{"name": "k", "len": len(KEY), "sha256": hashlib.sha256(KEY).hexdigest()}]
        buf = b"pre " + KEY + b" tail"
        end = 4 + len(KEY)
        self.assertEqual(rtlib.fingerprint_hits(buf, fp, min_end=end - 1), ["k"])  # 창이 새 바이트(마지막 글자)에서 끝난다
        self.assertEqual(rtlib.fingerprint_hits(buf, fp, min_end=end), [])  # 창 전체가 이미 검사한 앞부분


class WaitStart(unittest.TestCase):
    """대기줄 감시(드라이버 wait)는 러너 ended를 받은 뒤에야 시작한다(그 전에는 CPU를 쓰지 않는다)."""
    def test_ended_event_starts_wait(self):
        p = load_pump()
        p.append_events([{"seq": 1, "ts": "t", "kind": "started", "data": {}}, {"seq": 2, "ts": "t", "kind": "final", "data": {}}])
        self.assertFalse(p.wait_go.is_set())
        p.append_events([{"seq": 3, "ts": "t", "kind": "ended", "data": {}}])
        self.assertTrue(p.wait_go.is_set())

    def test_relay_drop_starts_wait(self):
        """정상 경로: 러너가 relay를 닫으면 event_loop가 끊김을 보고 RELAY_DOWN_S 뒤 감시를 시작한다."""
        import threading, time as real_time, types
        p = load_pump()
        p.RELAY_DOWN_S = 0.2
        p.time = types.SimpleNamespace(sleep=lambda s: real_time.sleep(0.01), monotonic=real_time.monotonic, time=real_time.time)
        calls = []

        def control(method, path, body=None, timeout=40):
            calls.append(path)
            if path == "/rt/hello" and len(calls) == 1:
                return 200, {"job": p.JOB, "gen": p.GEN}
            raise OSError("relay gone")
        p.control = control
        t = threading.Thread(target=p.event_loop, daemon=True)
        t.start()
        self.assertTrue(p.wait_go.wait(3))
        p.stop.set()
        t.join(2)

    def test_hello_never_ok_does_not_start_wait(self):
        """relay가 한 번도 안 뜬 동안(대기줄 대기·설치 중)에는 끊김 계기를 쓰지 않는다(엿보기·안전선이 맡는다)."""
        import threading, time as real_time, types
        p = load_pump()
        p.RELAY_DOWN_S = 0.05
        p.time = types.SimpleNamespace(sleep=lambda s: real_time.sleep(0.01), monotonic=real_time.monotonic, time=real_time.time)
        p.control = lambda *a, **k: (_ for _ in ()).throw(OSError("no relay"))
        t = threading.Thread(target=p.event_loop, daemon=True)
        t.start()
        self.assertFalse(p.wait_go.wait(0.5))
        p.stop.set()
        t.join(2)

    def test_wait_now_marker_starts_wait(self):
        import threading
        p = load_pump()
        open(os.path.join(p.SPOOL, "wait-now"), "w").close()
        t = threading.Thread(target=p.outbox_loop, daemon=True)
        t.start()
        self.assertTrue(p.wait_go.wait(2))
        p.stop.set()
        t.join(2)

    def test_queue_peek_ends_wait_without_relay(self):
        """러너 전 실패: relay가 없는 동안 엿본 대기줄이 끝났으면 감시 단계로 넘어가 job_done까지 간다."""
        import threading, types
        p = load_pump()
        p.CFG["qid"] = "20261126T000000-x"
        p.QUEUE_PEEK_S = 0
        p.queue_state = lambda: ("failed", "1")
        p.subprocess = types.SimpleNamespace(Popen=lambda *a, **k: types.SimpleNamespace(wait=lambda: 0), DEVNULL=-3)
        t = threading.Thread(target=p.wait_loop, daemon=True)
        t.start()
        self.assertTrue(p.job_done.wait(5))
        self.assertFalse(p.wait_go.is_set())
        self.assertEqual(p.state["queue"], {"state": "failed", "exit": "1"})
        p.stop.set()

    def test_queue_state_parses_status(self):
        p = load_pump()
        import subprocess
        p.CFG["qid"] = "20261126T000000-x"
        p.q = lambda *a, **k: subprocess.CompletedProcess(a, 0, b'{"state": "failed", "exit": "3"}\n', b"")
        self.assertEqual(p.queue_state(), ("failed", "3"))
        p.q = lambda *a, **k: subprocess.CompletedProcess(a, 0, b'{"state": "unknown", "exit": null}\n', b"")
        self.assertEqual(p.queue_state(), (None, None))
        p.q = lambda *a, **k: subprocess.CompletedProcess(a, 1, b"", b"no such job")
        self.assertEqual(p.queue_state(), (None, None))

    def test_driver_gets_target_env(self):
        p = load_pump()
        self.assertEqual(json.loads(p.DENV["RT_BOX_TARGET"])["host"], "h")
        self.assertTrue(p.DRIVER.endswith("rt-box-ssh"))


if __name__ == "__main__":
    unittest.main()
