"""rt-worktool prepare·make_bundle: 작업 저장소가 캐시 객체를 빌려 쓰고(alternates) 결과 bundle은 새 커밋만 담는다."""
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(__file__)
BUNDLE = os.path.join(HERE, "..", "..", "worker", "bundle")


def load():
    spec = importlib.util.spec_from_file_location("rt_worktool", os.path.join(BUNDLE, "rt-worktool.py"))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def sh(*a, cwd=None):
    return subprocess.run(list(a), cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


class TestPrepareAlternates(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        t = self.tmp.name
        self.wt = load()
        self.wt.JOB_DIR_FMT = os.path.join(t, "work", "{job}")
        self.wt.REPO_ROOT = os.path.join(t, "repos")
        self.wt.PER_JOB_CACHE = False
        os.makedirs(self.wt.REPO_ROOT)
        # 원본: 커밋 여러 개(객체가 충분히 있게)
        src = os.path.join(t, "src")
        sh("git", "init", "-q", src)
        for i in range(30):
            with open(os.path.join(src, f"f{i}.txt"), "w") as f:
                f.write(f"{i}\n" * 2000)
            sh("git", "-c", "user.name=t", "-c", "user.email=t@t", "add", ".", cwd=src)
            sh("git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", f"c{i}", cwd=src)
        self.base = sh("git", "rev-parse", "HEAD", cwd=src)
        self.repo_id = "a" * 16
        cache = os.path.join(self.wt.REPO_ROOT, f"{self.repo_id}.git")
        sh("git", "init", "-q", "--bare", cache)
        sh("git", "fetch", "-q", src, f"+HEAD:refs/rt-held/{self.base}", cwd=cache)
        self.cache = cache
        self.src = src
        self.job = "rt-01aaaaaaaaaaaaaaaaaaaaaaaa"
        os.makedirs(self.wt.job_dir(self.job))

    def tearDown(self):
        self.tmp.cleanup()

    def prepare(self):
        manifest = {"repo_id": self.repo_id, "base_sha": self.base, "task_md": "x", "checks": [], "verify": "runner",
                    "job": self.job, "gen": 1, "model": "m", "est_min": 5, "gjc_version": "0"}
        old_in, old_out = sys.stdin, sys.stdout
        sys.stdin = io.TextIOWrapper(io.BytesIO(json.dumps(manifest).encode()))
        sys.stdout = io.StringIO()
        try:
            self.wt.op_prepare(self.job)
        finally:
            sys.stdin, sys.stdout = old_in, old_out

    def test_repo_borrows_cache_objects_and_bundle_has_only_new_commit(self):
        self.prepare()
        repo = os.path.join(self.wt.job_dir(self.job), "repo")
        with open(os.path.join(repo, ".git", "objects", "info", "alternates")) as f:
            alt = f.read().strip()
        self.assertEqual(alt, os.path.join(os.path.abspath(self.cache), "objects"))
        # 작업 저장소 자체에는 객체를 복사하지 않았다.
        counts = dict(l.split(": ") for l in sh("git", "count-objects", "-v", cwd=repo).splitlines())
        self.assertEqual(int(counts["count"]) + int(counts["in-pack"]), 0)
        self.assertEqual(sh("git", "rev-parse", "HEAD", cwd=repo), self.base)
        with open(os.path.join(self.wt.job_dir(self.job), "job.json")) as f:
            self.assertEqual(json.load(f)["repo_id"], self.repo_id)
        # 새 커밋 하나 → bundle은 그 커밋만, 원본(기준 커밋 보유)에서 검증·적용된다.
        with open(os.path.join(repo, "new.txt"), "w") as f:
            f.write("new\n")
        sh("git", "-c", "user.name=t", "-c", "user.email=t@t", "add", "new.txt", cwd=repo)
        sh("git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "new", cwd=repo)
        os.makedirs(os.path.join(self.wt.job_dir(self.job), "tmp"), exist_ok=True)
        dest = os.path.join(self.tmp.name, "out.bundle")
        res = self.wt.make_bundle(self.job, self.base, dest, [])
        self.assertEqual(res["status"], "ok", res)
        self.assertLess(os.path.getsize(dest), 4096)
        sh("git", "bundle", "verify", dest, cwd=self.src)
        sh("git", "fetch", "-q", dest, f"refs/heads/rt/{self.job}:refs/heads/got", cwd=self.src)
        self.assertEqual(sh("git", "log", "--format=%s", "-1", "got", cwd=self.src), "new")


if __name__ == "__main__":
    unittest.main()
