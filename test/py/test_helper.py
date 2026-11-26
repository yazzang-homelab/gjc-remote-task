"""rt-helper 순수 판정(인자 문법·admission·슬롯 회수) 단위 시험. root 경로는 건드리지 않는다."""
import importlib.machinery
import importlib.util
import os
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
loader = importlib.machinery.SourceFileLoader("rt_helper", os.path.join(HERE, "..", "..", "worker", "rt-helper"))
spec = importlib.util.spec_from_loader("rt_helper", loader)
h = importlib.util.module_from_spec(spec)
loader.exec_module(h)

CFG = {"load_max": 0.7, "psi_mem_max": 10.0, "disk_min_gb": 5, "contention_slice": "ptj.slice", "contention_psi_max": 10.0}


def snap(**kw):
    base = {"load_ratio": 0.1, "psi_mem": 0.0, "disk_free_gb": 50.0, "contention_psi": 0.0}
    base.update(kw)
    return base


class AdmissionTest(unittest.TestCase):
    def run_adm(self, s):
        orig = h.load_snapshot
        h.load_snapshot = lambda: s
        try:
            return h.admission(CFG)
        finally:
            h.load_snapshot = orig

    def test_thresholds(self):
        self.assertEqual(self.run_adm(snap()), [])
        self.assertEqual(self.run_adm(snap(load_ratio=0.7)), ["remote_overloaded"])
        self.assertEqual(self.run_adm(snap(load_ratio=0.69)), [])
        self.assertEqual(self.run_adm(snap(psi_mem=10.5)), ["remote_overloaded"])
        self.assertEqual(self.run_adm(snap(disk_free_gb=4.9)), ["disk_low"])
        self.assertEqual(self.run_adm(snap(contention_psi=12)), ["contention:ptj.slice"])


class ArgsTest(unittest.TestCase):
    def test_need(self):
        self.assertEqual(h.need("job", "rt-" + "a" * 26), "rt-" + "a" * 26)
        for bad in ["rt-../../etc", "rt-" + "A" * 26, "", "rt-" + "a" * 25]:
            with self.assertRaises(h.HelperError):
                h.need("job", bad)
        self.assertEqual(h.need("origin", "main-host"), "main-host")
        for bad in ["../x", "Main", "", "1host", "a" * 33]:
            with self.assertRaises(h.HelperError):
                h.need("origin", bad)
        self.assertEqual(h.need("model", "oci-opencodex/devin/swe-2:high"), "oci-opencodex/devin/swe-2:high")

    def test_check_reg_needs_token_file(self):
        # 등록 토큰 파일이 없거나 비어 있는 원점은 빈 토큰을 보내도 통과하지 않는다.
        with tempfile.TemporaryDirectory() as d:
            orig = (h.PRIV, h.read_auth_line)
            try:
                h.PRIV = d
                os.makedirs(os.path.join(d, "hosts"))
                h.read_auth_line = lambda: ["reg", ""]
                with self.assertRaises(h.HelperError) as cm:
                    h.check_reg("nohost")
                self.assertEqual(cm.exception.args[0], "unauthorized")
                if os.geteuid() == 0:
                    open(os.path.join(d, "hosts", "empty.token"), "w").close()
                    with self.assertRaises(h.HelperError):
                        h.check_reg("empty")
                    with open(os.path.join(d, "hosts", "ok.token"), "w") as f:
                        f.write("t" * 64 + "\n")
                    h.read_auth_line = lambda: ["reg", "t" * 64]
                    h.check_reg("ok")
            finally:
                h.PRIV, h.read_auth_line = orig

    def test_unit_name(self):
        self.assertEqual(h.unit_name("rt-" + "b" * 26, 3), "rt-" + "b" * 26 + "-g3.service")


class ReclaimTest(unittest.TestCase):
    def test_expired_lease_and_ended_marker(self):
        with tempfile.TemporaryDirectory() as d:
            orig = (h.STATE, h.unit_show, h.boot_id, h.seal, h.meta_update)
            h.STATE = d
            os.makedirs(os.path.join(d, "jobs"))
            h.unit_show = lambda unit: {"LoadState": "not-found"}
            h.boot_id = lambda: "boot-1"
            sealed = []
            h.seal = lambda job, gen, reason: sealed.append((job, reason))
            h.meta_update = lambda job, **kw: None
            try:
                ja, jb, jc = ("rt-" + c * 26 for c in "abc")
                for j in (ja, jb, jc):
                    os.makedirs(os.path.join(d, "jobs", j))
                with open(os.path.join(d, "jobs", jb, "ended-g1.json"), "w") as f:
                    f.write("{}")
                slots = [
                    {"job": ja, "gen": 1, "state": "reserved", "lease_until": time.time() - 1},
                    {"job": jb, "gen": 1, "state": "launched", "invocation": "x", "boot_id": "boot-1"},
                    {"job": jc, "gen": 1, "state": "reserved", "lease_until": time.time() + 600},
                ]
                kept = h.reclaim(slots)
                self.assertEqual([s["job"] for s in kept], [jc])
                self.assertEqual(sealed, [(ja, "lease_expired")])
            finally:
                h.STATE, h.unit_show, h.boot_id, h.seal, h.meta_update = orig


class GjcTrustTest(unittest.TestCase):
    def test_host_platform_uses_release_asset_names(self):
        from unittest import mock
        for machine, want in (("x86_64", "linux-x64"), ("aarch64", "linux-arm64"), ("arm64", "linux-arm64")):
            with mock.patch.object(h.os, "uname", return_value=os.uname_result(("Linux", "h", "r", "v", machine))):
                self.assertEqual(h.host_platform(), want)

    def test_trusted_table_reads_only_own_platform(self):
        a, b = "a" * 64, "b" * 64
        table = f"0.22.1 linux-x64 {a}\n0.22.1 linux-arm64 {b}\n0.22.0 {a}\n0.21.0 linux-arm64 bad\n"
        orig = h.read_root_file, h.host_platform
        h.read_root_file = lambda p: table
        try:
            h.host_platform = lambda: "linux-arm64"
            self.assertEqual(h.trusted_gjc(), {"0.22.1": b})  # 두 칸 옛 형식·잘못된 해시는 버린다
            h.host_platform = lambda: "linux-x64"
            self.assertEqual(h.trusted_gjc(), {"0.22.1": a})
        finally:
            h.read_root_file, h.host_platform = orig


if __name__ == "__main__":
    unittest.main()
