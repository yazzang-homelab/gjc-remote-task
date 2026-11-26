"""박스 드라이버(worker/box/drivers) 시험. rt-box-ssh는 가짜 ssh·sudo·systemctl·systemd-run으로 로컬 임시 폴더에 돌린다."""
import importlib.machinery
import importlib.util
import io
import json
import os
import shutil
import subprocess
import tarfile
import tempfile
import time
import unittest
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
DRIVERS = os.path.join(HERE, "..", "..", "worker", "box", "drivers")
SSH_DRIVER = os.path.join(DRIVERS, "rt-box-ssh")


def read(path):
    with open(path) as f:
        return f.read()


def load(name):
    loader = importlib.machinery.SourceFileLoader(name.replace("-", "_"), os.path.join(DRIVERS, name))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    m = importlib.util.module_from_spec(spec)
    loader.exec_module(m)
    return m


class InstaboxTimes(unittest.TestCase):
    now = datetime(2026, 11, 26, tzinfo=timezone.utc).timestamp()

    def test_running_box_subtracts_elapsed_sleeping_box_gets_full_cap(self):
        ib = load("rt-box-instabox")
        m = {"state": "running", "runStartedAt": "2026-11-25T23:00:30Z", "maxRunMinutes": 120, "cooldownUntil": None}
        self.assertEqual(ib.box_times(m, self.now), {"state": "running", "cooldown_s": 0, "run_left_min": 60})
        self.assertEqual(ib.box_times({**m, "state": "suspended"}, self.now)["run_left_min"], 120)
        self.assertEqual(ib.box_times({**m, "runStartedAt": "2026-11-25T21:00:00Z"}, self.now)["run_left_min"], 0)

    def test_cooldown_seconds_and_no_cap(self):
        ib = load("rt-box-instabox")
        self.assertEqual(ib.box_times({"state": "stopped", "cooldownUntil": "2026-11-26T00:01:30Z", "maxRunMinutes": 0}, self.now),
                         {"state": "stopped", "cooldown_s": 90, "run_left_min": None})
        self.assertEqual(ib.box_times({"state": "stopped", "cooldownUntil": "2026-11-25T23:59:00Z"}, self.now)["cooldown_s"], 0)


FAKE_SSH = r"""#!/bin/bash
# 가짜 ssh: 옵션을 건너뛰고 원격 명령을 로컬 bash로 돌린다(/data/workspace → $FAKE_WS).
while [ $# -gt 0 ] && [ "$1" != "--" ]; do shift; done
shift; echo "$1" >> "$FAKE_LOG"; shift
[ -n "$FAKE_TAR" ] && case "$*" in "tar -C "*) cat "$FAKE_TAR"; exit 0;; esac
exec bash -c "${*//\/data\/workspace/$FAKE_WS}"
"""
FAKE_SUDO = "#!/bin/bash\n[ \"$1\" = -n ] && shift\nexec \"$@\"\n"
FAKE_SYSTEMCTL = "#!/bin/bash\n[ \"$1\" = is-active ] && { echo \"${FAKE_ACTIVE:-inactive}\"; exit 3; }\necho \"$@\" >> \"$FAKE_WS/systemctl.log\"\n"
# 가짜 systemd-run: 옵션을 버리고 마지막 /bin/bash -c ... 부분을 그 자리에서 실행한다.
FAKE_SYSTEMD_RUN = "#!/bin/bash\nwhile [ $# -gt 0 ] && [ \"$1\" != /bin/bash ]; do shift; done\nexec \"$@\"\n"


class SshDriver(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.bin = os.path.join(self.d, "bin")
        self.ws = os.path.join(self.d, "ws")
        os.makedirs(self.bin)
        os.makedirs(self.ws)
        for name, body in (("ssh", FAKE_SSH), ("sudo", FAKE_SUDO), ("systemctl", FAKE_SYSTEMCTL), ("systemd-run", FAKE_SYSTEMD_RUN)):
            p = os.path.join(self.bin, name)
            with open(p, "w") as f:
                f.write(body)
            os.chmod(p, 0o755)
        self.env = {**os.environ, "PATH": f"{self.bin}:{os.environ['PATH']}", "FAKE_WS": self.ws,
                    "FAKE_LOG": os.path.join(self.d, "ssh.log"),
                    "RT_BOX_TARGET": json.dumps({"kind": "box", "driver": "ssh", "host": "203.0.113.10", "user": "debian"})}

    def tearDown(self):
        shutil.rmtree(self.d, ignore_errors=True)

    def drv(self, *args, **env):
        return subprocess.run(["python3", SSH_DRIVER, *args], env={**self.env, **env}, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, timeout=60)

    def test_info_and_bad_target(self):
        r = self.drv("info")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(json.loads(r.stdout), {"state": "running", "cooldown_s": 0, "run_left_min": None})
        self.assertEqual(self.drv("info", RT_BOX_TARGET='{"host": "a b"}').returncode, 2)
        self.assertEqual(self.drv("info", RT_BOX_TARGET='{"host": "h", "user": "x;y"}').returncode, 2)

    def test_put_exec_fetch_roundtrip(self):
        src = os.path.join(self.d, "up")
        os.makedirs(os.path.join(src, "sub"))
        with open(os.path.join(src, "sub", "a.txt"), "w") as f:
            f.write("hello")
        self.assertEqual(self.drv("put", src, "/data/workspace/rt-in/rt-x").returncode, 0)
        self.assertEqual(read(os.path.join(self.ws, "rt-in", "rt-x", "sub", "a.txt")), "hello")
        r = self.drv("exec", "--", "sh", "-c", "echo out; exit 7")
        self.assertEqual((r.returncode, r.stdout), (7, b"out\n"))
        dest = os.path.join(self.d, "fetch")
        self.assertEqual(self.drv("fetch", "/data/workspace/rt-in/rt-x", dest, "1000").returncode, 0)
        self.assertEqual(read(os.path.join(dest, "sub", "a.txt")), "hello")
        # 상한을 넘으면 실패한다.
        self.assertNotEqual(self.drv("fetch", "/data/workspace/rt-in/rt-x", os.path.join(self.d, "f2"), "3").returncode, 0)

    def test_remote_paths_outside_workspace_are_refused(self):
        for p in ("/etc", "/data/workspace/../etc", "/data/workspace/a b"):
            self.assertEqual(self.drv("put", self.d, p).returncode, 2, p)
            self.assertEqual(self.drv("fetch", p, os.path.join(self.d, "x"), "10").returncode, 2, p)

    def test_fetch_refuses_links_and_escapes(self):
        for member in ("link", "../escape", "/abs"):
            buf = io.BytesIO()
            with tarfile.open(fileobj=buf, mode="w") as tf:
                ti = tarfile.TarInfo(member if member != "link" else "out/link")
                if member == "link":
                    ti.type, ti.linkname = tarfile.SYMTYPE, "/etc/passwd"
                else:
                    ti.size = 1
                tf.addfile(ti, io.BytesIO(b"x") if member != "link" else None)
            tar = os.path.join(self.d, "evil.tar")
            with open(tar, "wb") as f:
                f.write(buf.getvalue())
            dest = os.path.join(self.d, "f-" + member.strip("./"))
            r = self.drv("fetch", "/data/workspace/rt/x/out", dest, "100", FAKE_TAR=tar)
            self.assertNotEqual(r.returncode, 0, member)
            self.assertFalse(os.path.lexists(os.path.join(dest, "out", "link")))
            self.assertFalse(os.path.exists(os.path.join(self.d, "escape")))

    def test_submit_status_cancel(self):
        script = os.path.join(self.d, "job.sh")
        with open(script, "w") as f:
            f.write("echo running; exit 5\n")
        # 끝난 지 7일 넘은 잡 폴더는 다음 투입 때 지우고, 종료값이 없는(아직 도는) 폴더는 둔다.
        old = time.time() - 8 * 86400
        for name, rc in (("rt-old", True), ("rt-old-live", False)):
            p = os.path.join(self.ws, "rt-q", name)
            os.makedirs(p)
            if rc:
                with open(os.path.join(p, "rc"), "w") as f:
                    f.write("0\n")
            os.utime(p, (old, old))
        r = self.drv("submit", "rt-abc", "60", script)
        self.assertFalse(os.path.exists(os.path.join(self.ws, "rt-q", "rt-old")))
        self.assertTrue(os.path.exists(os.path.join(self.ws, "rt-q", "rt-old-live")))
        self.assertEqual((r.returncode, r.stdout.decode().strip()), (0, "rt-abc"), r.stderr)
        self.assertEqual(json.loads(self.drv("status", "rt-abc").stdout), {"state": "failed", "exit": "5"})
        self.assertEqual(read(os.path.join(self.ws, "rt-q", "rt-abc", "log")), "running\n")
        # 같은 이름은 다시 넣지 않는다.
        self.assertNotEqual(self.drv("submit", "rt-abc", "60", script).returncode, 0)
        # 종료값이 없는 잡: 유닛이 살아 있으면 running, 끝났으면 failed, 취소 표식이 있으면 cancelled.
        os.makedirs(os.path.join(self.ws, "rt-q", "rt-run"))
        self.assertEqual(json.loads(self.drv("status", "rt-run", FAKE_ACTIVE="active").stdout)["state"], "running")
        self.assertEqual(json.loads(self.drv("status", "rt-run").stdout)["state"], "failed")
        c = self.drv("cancel", "rt-run")
        self.assertEqual(json.loads(c.stdout)["pending_cancelled"], False)
        self.assertIn("stop rtq-rt-run", read(os.path.join(self.ws, "systemctl.log")))
        self.assertEqual(json.loads(self.drv("status", "rt-run").stdout)["state"], "cancelled")
        # 이미 끝난 잡의 취소는 종료 판정을 바꾸지 않는다.
        self.drv("cancel", "rt-abc")
        self.assertEqual(json.loads(self.drv("status", "rt-abc").stdout)["state"], "failed")
        self.assertEqual(json.loads(self.drv("status", "rt-none").stdout)["state"], "unknown")
        self.assertEqual(self.drv("status", "../x").returncode, 2)


if __name__ == "__main__":
    unittest.main()
