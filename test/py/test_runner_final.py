"""rt-runner: final_report가 받아들여지면 gjc의 마무리 턴을 기다리지 않고 끝내고 정상 완료로 본다."""
import importlib.util
import json
import os
import stat
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(__file__)
BUNDLE = os.path.join(HERE, "..", "..", "worker", "bundle")
sys.path.insert(0, BUNDLE)


def load():
    spec = importlib.util.spec_from_file_location("rt_runner", os.path.join(BUNDLE, "rt-runner.py"))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


FAKE_GJC = """#!/bin/sh
cat > /dev/null
echo '{"type":"tool_execution_start","toolCallId":"c1","toolName":"bash"}'
echo '{"type":"tool_execution_end","toolCallId":"c1","toolName":"bash"}'
%s
sleep 30
"""
# final_report 도구 실행 안에서 final 기록이 쓰이고, 도구 종료 이벤트가 뒤따른다(gjc json 모드 순서).
FINAL = """echo '{"type":"tool_execution_start","toolCallId":"f1","toolName":"final_report"}'
echo '{"kind":"final","data":{"summary":"ok"}}' >> WOUT
echo '{"type":"tool_execution_end","toolCallId":"f1","toolName":"final_report"}'"""


class TestRunnerFinal(unittest.TestCase):
    def run_with(self, body: str, tool_wait: float | None = None):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        t = tmp.name
        d = os.path.join(t, "job")
        os.makedirs(os.path.join(d, "repo"))
        with open(os.path.join(d, "job.json"), "w") as f:
            json.dump({"model": "m", "gjc_version": "0", "base_sha": "0" * 40}, f)
        with open(os.path.join(d, "task.md"), "w") as f:
            f.write("x")
        gdir = os.path.join(t, "gjc", "0")
        os.makedirs(gdir)
        g = os.path.join(gdir, "gjc")
        with open(g, "w") as f:
            f.write(FAKE_GJC % body.replace("WOUT", os.path.join(d, "worker-out.jsonl")))
        os.chmod(g, stat.S_IRWXU)
        cred = os.path.join(t, "cred")
        os.makedirs(cred)
        with open(os.path.join(cred, "gjc-rt-key"), "w") as f:
            f.write("k")
        r = load()
        if tool_wait is not None:
            r.FINAL_TOOL_WAIT_S = tool_wait
        r.rtlib.PATHS = {"gjc_dir": os.path.join(t, "gjc")}
        r.rtlib.load_fingerprints = lambda: []
        calls = []

        class WT:
            @staticmethod
            def finish(job, code, reason):
                calls.append((code, reason))

        r.load_worktool = lambda: WT
        old = (sys.argv, dict(os.environ))
        sys.argv = ["rt-runner", "rt-01x", "1"]
        os.environ["GJC_RT_JOB_DIR"] = d
        os.environ["CREDENTIALS_DIRECTORY"] = cred
        t0 = time.monotonic()
        try:
            rc = r.main()
        finally:
            sys.argv = old[0]
            os.environ.clear()
            os.environ.update(old[1])
        with open(os.path.join(d, "events.jsonl")) as f:
            kinds = [json.loads(line)["kind"] for line in f if line.strip()]
        return rc, calls, time.monotonic() - t0, kinds

    def test_final_stops_gjc_and_counts_as_completed(self):
        rc, calls, took, kinds = self.run_with(FINAL)
        self.assertEqual(rc, 0)
        self.assertEqual(calls[0][1], "completed")
        self.assertLess(took, 10)
        self.assertIn("final", kinds)
        self.assertNotIn("error", kinds)

    def test_final_waits_for_tool_in_flight(self):
        # 같은 묶음에서 final 뒤에 시작된 도구(예: git commit)는 끝날 때까지 기다린 뒤 끊는다.
        body = FINAL + """
echo '{"type":"tool_execution_start","toolCallId":"b2","toolName":"bash"}'
sleep 2
echo '{"type":"tool_execution_end","toolCallId":"b2","toolName":"bash"}'"""
        rc, calls, took, kinds = self.run_with(body)
        self.assertEqual(rc, 0)
        self.assertEqual(calls[0][1], "completed")
        self.assertGreaterEqual(took, 2)
        self.assertLess(took, 10)

    def test_final_tool_wait_is_bounded(self):
        # 끝나지 않는 도구는 FINAL_TOOL_WAIT_S 뒤 끊고 정상 완료로 본다.
        body = FINAL + """
echo '{"type":"tool_execution_start","toolCallId":"b3","toolName":"bash"}'"""
        rc, calls, took, kinds = self.run_with(body, tool_wait=1.0)
        self.assertEqual(rc, 0)
        self.assertEqual(calls[0][1], "completed")
        self.assertGreaterEqual(took, 1)
        self.assertLess(took, 10)

    def test_without_final_waits_for_exit(self):
        # final 없이 끝나지 않는 gjc는 끊지 않는다(여기서는 3초 뒤 스스로 실패로 끝난다).
        rc, calls, took, kinds = self.run_with("sleep 3; exit 7")
        self.assertEqual(rc, 1)
        self.assertEqual(calls, [(7, "gjc_failed")])
        self.assertGreaterEqual(took, 3)
        self.assertIn("error", kinds)


    def test_model_error_is_reported(self):
        r = load()
        ev = {"type": "message_end", "message": {"role": "assistant", "content": [], "stopReason": "error",
                                                 "errorMessage": "rate_limit_exceeded: Please try again in 960s."}}
        self.assertEqual(r.summarize(ev), ("progress", {"model_error": "rate_limit_exceeded: Please try again in 960s."}))
        ok = {"type": "message_end", "message": {"role": "assistant", "content": [], "stopReason": "toolUse"}}
        self.assertIsNone(r.summarize(ok))


if __name__ == "__main__":
    unittest.main()
