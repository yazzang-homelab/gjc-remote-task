"""원격 작업 도구·공용 함수 단위 시험(표준 라이브러리 unittest)."""
import hashlib
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
BUNDLE = os.path.join(HERE, "..", "..", "worker", "bundle")
sys.path.insert(0, BUNDLE)
import rtlib  # noqa: E402

spec = importlib.util.spec_from_file_location("wt", os.path.join(BUNDLE, "rt-worktool.py"))
wt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wt)


def put(path, text):
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


def sh(cwd, *args, input_bytes=None):
    return subprocess.run(list(args), cwd=cwd, check=True, input=input_bytes, capture_output=True)


class SecretsTest(unittest.TestCase):
    def test_token_rules(self):
        self.assertIn("openai_like", rtlib.scan_secrets("x sk-" + "a" * 30, []))
        self.assertIn("github_token", rtlib.scan_secrets("ghp_" + "A" * 36, []))
        self.assertEqual(rtlib.scan_secrets("평범한 문장", []), [])

    def test_fingerprint_with_and_without_prefix(self):
        secret = "zq9-UNIQUE-secret-value-123456"
        fp = {"name": "k", "len": len(secret), "sha256": hashlib.sha256(secret.encode()).hexdigest()}
        text = f"앞 {secret} 뒤"
        self.assertEqual(rtlib.fingerprint_hits(text, [fp]), ["k"])
        self.assertEqual(rtlib.fingerprint_hits(text, [{**fp, "prefix": secret[:6]}]), ["k"])
        self.assertEqual(rtlib.fingerprint_hits("다른 글", [{**fp, "prefix": secret[:6]}]), [])

    def test_redact_line_hides_whole_line(self):
        out, hits = rtlib.redact_line("token=sk-" + "b" * 40, [])
        self.assertTrue(out.startswith("[redacted:"))
        self.assertNotIn("bbbb", out)
        self.assertTrue(hits)


class EventLogTest(unittest.TestCase):
    def test_two_writers_never_reuse_seq(self):
        with tempfile.TemporaryDirectory() as d:
            a = rtlib.EventLog(d, [])
            b = rtlib.EventLog(d, [])
            seqs = [a.emit("x", {}), b.emit("y", {}), a.emit("z", {})]
            self.assertEqual(seqs, [1, 2, 3])

    def test_secret_event_is_replaced(self):
        with tempfile.TemporaryDirectory() as d:
            log = rtlib.EventLog(d, [])
            log.emit("progress", {"note": "sk-" + "c" * 40})
            rec = rtlib.read_jsonl(os.path.join(d, "events.jsonl"))[0]
            self.assertTrue(rec["data"]["redacted"])
            self.assertNotIn("cccc", json.dumps(rec))


class WipPathsTest(unittest.TestCase):
    def test_skips_agent_config_paths(self):
        with tempfile.TemporaryDirectory() as d:
            sh(d, "git", "init", "-q")
            sh(d, "git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "b")
            os.makedirs(os.path.join(d, ".gjc"))
            put(os.path.join(d, ".gjc", "state.json"), "{}")
            put(os.path.join(d, ".mcp.json"), "{}")
            os.makedirs(os.path.join(d, "src"))
            put(os.path.join(d, "src", "a.rs"), "fn main(){}")
            self.assertEqual(wt.wip_paths(d), ["src/a.rs"])

    def test_skips_untracked_build_junk_keeps_tracked(self):
        with tempfile.TemporaryDirectory() as d:
            sh(d, "git", "init", "-q")
            os.makedirs(os.path.join(d, "vendor", "node_modules"))
            put(os.path.join(d, "vendor", "node_modules", "kept.js"), "1")
            sh(d, "git", "add", ".")
            sh(d, "git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "b")
            put(os.path.join(d, "vendor", "node_modules", "kept.js"), "2")
            os.makedirs(os.path.join(d, "pkg", "__pycache__"))
            put(os.path.join(d, "pkg", "__pycache__", "m.cpython-313.pyc"), "x")
            put(os.path.join(d, "loose.pyc"), "x")
            os.makedirs(os.path.join(d, "target", "debug"))
            put(os.path.join(d, "target", "debug", "app"), "x")
            put(os.path.join(d, "m.py"), "x=1")
            # Cargo.toml이 없으면 target/은 일반 디렉터리다.
            self.assertEqual(sorted(wt.wip_paths(d)), ["m.py", "target/debug/app", "vendor/node_modules/kept.js"])
            put(os.path.join(d, "Cargo.toml"), "[package]")
            self.assertEqual(sorted(wt.wip_paths(d)), ["Cargo.toml", "m.py", "vendor/node_modules/kept.js"])


if __name__ == "__main__":
    unittest.main()
