#!/usr/bin/python3
"""gjc-rt 작업 도구. 항상 실행 계정(gjcrt) 권한으로만 돈다.

rt-helper(root)는 잡 작업 디렉터리를 직접 열지 않고, setpriv로 권한을 내린 뒤
이 도구를 부른다(계획 §17.1). 바이트는 stdin/stdout으로만 오간다.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rtlib  # noqa: E402

BUNDLE_DIR = os.path.dirname(os.path.abspath(__file__))
GITCONFIG = os.path.join(BUNDLE_DIR, "gitconfig")
AGENT_TEMPLATE = os.path.join(BUNDLE_DIR, "agent-template")
WORK_ROOT = "/srv/gjc-rt/work"
REPO_ROOT = "/srv/gjc-rt/repos"
# 박스 묶음: 잡 디렉터리 형식과 저장소 캐시를 잡마다 따로 둔다(잡끼리 캐시를 공유하면 앞 잡이 오염시킬 수 있다).
JOB_DIR_FMT = rtlib.PATHS.get("job_dir", os.path.join(WORK_ROOT, "{job}"))
PER_JOB_CACHE = rtlib.PATHS.get("repo_cache") == "per_job"
SPARSE_HIDE = ["/*", "!/.gjc/", "!/.claude/", "!/.mcp.json", "!.env*", "!/.gitmodules"]
FORBIDDEN_PREFIXES = (".gjc/", ".claude/", ".git/", ".mcp.json", ".gitmodules")
BAD_LOCAL_CONFIG = ("filter.", "core.hookspath", "core.fsmonitor", "core.pager", "gpg.", "commit.gpgsign",
                    "core.sshcommand", "include.", "includeif.", "core.editor", "diff.", "merge.")


class ToolError(Exception):
    def __init__(self, code: str, detail: str = ""):
        super().__init__(code)
        self.code = code
        self.detail = detail


def git_env(extra: dict | None = None) -> dict:
    env = {
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "HOME": os.environ.get("HOME", "/nonexistent"),
        "LANG": "C.UTF-8",
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": GITCONFIG,
        "GIT_TERMINAL_PROMPT": "0",
    }
    if extra:
        env.update(extra)
    return env


def git(args: list[str], cwd: str | None = None, allow_file: bool = False, check: bool = True,
        input_bytes: bytes | None = None, capture: bool = True) -> subprocess.CompletedProcess:
    base = ["git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
            "-c", f"protocol.file.allow={'always' if allow_file else 'never'}", "-c", "protocol.ext.allow=never"]
    proc = subprocess.run(base + args, cwd=cwd, env=git_env(), input=input_bytes,
                          stdout=subprocess.PIPE if capture else None, stderr=subprocess.PIPE)
    if check and proc.returncode != 0:
        raise ToolError("git_failed", f"git {args[0]}: {proc.stderr.decode('utf-8', 'replace')[-400:]}")
    return proc


def job_dir(job: str) -> str:
    return JOB_DIR_FMT.format(job=job)


def repo_cache(job: str, repo_id: str) -> str:
    if PER_JOB_CACHE:
        return os.path.join(job_dir(job), "cache.git")
    return os.path.join(REPO_ROOT, f"{repo_id}.git")


def out(obj) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def read_stdin_limited(limit: int) -> bytes:
    data = sys.stdin.buffer.read(limit + 1)
    if len(data) > limit:
        raise ToolError("payload_too_large")
    return data


# ---------------------------------------------------------------- 준비

def op_write_base(job: str) -> None:
    """stdin의 base bundle을 잡 디렉터리에 저장한다(≤2 GiB)."""
    d = job_dir(job)
    path = os.path.join(d, "base.bundle")
    limit = 2 << 30
    total = 0
    fd = os.open(path, os.O_CREAT | os.O_WRONLY | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as f:
        while True:
            chunk = sys.stdin.buffer.read(1 << 20)
            if not chunk:
                break
            total += len(chunk)
            if total > limit:
                raise ToolError("payload_too_large")
            f.write(chunk)
    out({"ok": True, "bytes": total, "sha256": rtlib.sha256_file(path)})


def op_prepare(job: str) -> None:
    """manifest(stdin JSON)로 저장소·agent dir·작업 파일을 만든다."""
    manifest = json.loads(read_stdin_limited(256 * 1024))
    d = job_dir(job)
    repo_id = manifest["repo_id"]
    base_sha = manifest["base_sha"]
    cache = repo_cache(job, repo_id)
    if not os.path.isdir(cache):
        git(["init", "-q", "--bare", cache])
    bundle = os.path.join(d, "base.bundle")
    if os.path.exists(bundle):
        verify = git(["bundle", "verify", bundle], cwd=cache, check=False)
        if verify.returncode != 0:
            raise ToolError("bundle_invalid", verify.stderr.decode("utf-8", "replace")[-300:])
        heads = git(["bundle", "list-heads", bundle], cwd=cache).stdout.decode().split("\n")
        ref = next((line.split(" ", 1)[1] for line in heads if line.startswith(base_sha + " ")), None)
        if not ref:
            raise ToolError("bundle_missing_base")
        git(["fetch", "-q", "--no-tags", bundle, f"+{ref}:refs/rt-held/{base_sha}"], cwd=cache, allow_file=True)
        os.unlink(bundle)
    if git(["cat-file", "-e", f"{base_sha}^{{commit}}"], cwd=cache, check=False).returncode != 0:
        raise ToolError("base_missing")
    git(["update-ref", f"refs/rt-held/{base_sha}", base_sha], cwd=cache)
    tree = git(["ls-tree", "-r", "--full-tree", base_sha], cwd=cache).stdout.decode("utf-8", "replace")
    for line in tree.splitlines():
        meta, _, path = line.partition("\t")
        if meta.startswith("160000 ") or path == ".gitmodules":
            raise ToolError("submodules_present")
    repo = os.path.join(d, "repo")
    git(["init", "-q", repo])
    # 저장소 캐시의 객체를 복사하지 않고 빌려 쓴다(alternates). 큰 저장소에서 fetch가 객체 전체를 옮기던 시간을 없앤다.
    # 캐시는 잡 유닛에서 읽기 전용으로 보이고(ProtectSystem=strict), 새 객체는 이 저장소에만 쌓인다.
    with open(os.path.join(repo, ".git", "objects", "info", "alternates"), "w", encoding="utf-8") as f:
        f.write(os.path.join(os.path.abspath(cache), "objects") + "\n")
    branch = f"rt/{job}"
    git(["fetch", "-q", "--no-tags", cache, f"refs/rt-held/{base_sha}:refs/heads/{branch}"], cwd=repo, allow_file=True)
    git(["sparse-checkout", "set", "--no-cone", *SPARSE_HIDE], cwd=repo)
    # 원격 gjc가 작업 디렉터리에 만드는 실행 파일은 변경으로 보지 않는다.
    with open(os.path.join(repo, ".git", "info", "exclude"), "a", encoding="utf-8") as f:
        f.write("/.gjc/\n/.claude/\n")
    git(["checkout", "-q", branch], cwd=repo)
    for sub in ("sessions", "home", "cache", "tmp", "out", "out/logs"):
        os.makedirs(os.path.join(d, sub), mode=0o700, exist_ok=True)
    agent = os.path.join(d, "agent")
    if os.path.exists(agent):
        shutil.rmtree(agent)
    shutil.copytree(AGENT_TEMPLATE, agent, symlinks=False)
    with open(os.path.join(d, "task.md"), "w", encoding="utf-8") as f:
        f.write(manifest["task_md"])
    job_meta = {k: manifest[k] for k in ("job", "gen", "model", "checks", "base_sha", "est_min", "verify", "gjc_version")}
    job_meta["branch"] = branch
    job_meta["repo_id"] = repo_id
    rtlib.write_json_atomic(os.path.join(d, "job.json"), job_meta)
    out({"ok": True, "branch": branch})


# ---------------------------------------------------------------- 읽기

def events_after(job: str, after: int, wait: float, max_n: int) -> dict:
    path = os.path.join(job_dir(job), "events.jsonl")
    deadline = time.monotonic() + max(0, min(wait, 50))
    seen = None
    while True:
        # 파일이 바뀔 때만 다시 읽는다. 잦은 확인(0.2초)으로 새 이벤트를 늦지 않게 넘긴다.
        try:
            st = os.stat(path)
            sig = (st.st_size, st.st_mtime_ns)
        except FileNotFoundError:
            sig = None
        if sig != seen:
            seen = sig
            events = [e for e in rtlib.read_jsonl(path) if isinstance(e.get("seq"), int) and e["seq"] > after]
            if events:
                break
        if time.monotonic() >= deadline:
            events = []
            break
        time.sleep(0.2)
    picked, size = [], 0
    for e in events[:max_n]:
        n = len(json.dumps(e, ensure_ascii=False).encode())
        if picked and size + n > (1 << 20):
            break
        picked.append(e)
        size += n
    last = 0
    for e in rtlib.read_jsonl(path):
        if isinstance(e.get("seq"), int):
            last = max(last, e["seq"])
    return {"events": picked, "last_seq": last}


def op_events(job: str, after: int, wait: int, max_n: int) -> None:
    out(events_after(job, after, wait, max_n))


def op_held(repo_id: str) -> None:
    cache = os.path.join(REPO_ROOT, f"{repo_id}.git")
    proc = git(["for-each-ref", "--sort=-committerdate", "--count=50", "--format=%(objectname)", "refs/rt-held/"],
               cwd=cache, check=False)
    out({"held": [s for s in proc.stdout.decode().split() if s]})


def op_status(job: str) -> None:
    d = job_dir(job)
    info: dict = {"exists": os.path.isdir(os.path.join(d, "repo"))}
    if not info["exists"]:
        out(info)
        return
    head = git(["rev-parse", "--verify", "-q", f"refs/heads/rt/{job}"], cwd=os.path.join(d, "repo"), check=False)
    info["head"] = head.stdout.decode().strip() or None
    last = 0
    for e in rtlib.read_jsonl(os.path.join(d, "events.jsonl")):
        if isinstance(e.get("seq"), int):
            last = max(last, e["seq"])
    info["last_seq"] = last
    info["closing"] = os.path.exists(os.path.join(d, "closing"))
    try:
        with open(os.path.join(d, "out", "done.json"), encoding="utf-8") as f:
            info["done"] = json.load(f)
    except (OSError, ValueError):
        info["done"] = None
    out(info)


# ---------------------------------------------------------------- 대화

def inbox_append(job: str, msg_id: str, reply_to: str, text: str) -> dict:
    d = job_dir(job)
    if os.path.exists(os.path.join(d, "closing")):
        raise ToolError("job_closing")
    path = os.path.join(d, "inbox.jsonl")
    if any(m.get("id") == msg_id for m in rtlib.read_jsonl(path)):
        return {"ok": True, "duplicate": True}
    rec = {"id": msg_id, "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
           "reply_to": None if reply_to == "-" else reply_to, "text": rtlib.clean_text(text, rtlib.INBOX_MAX)}
    fd = os.open(path, os.O_CREAT | os.O_WRONLY | os.O_APPEND | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "a", encoding="utf-8") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    return {"ok": True, "duplicate": False}


def op_inbox_append(job: str, msg_id: str, reply_to: str) -> None:
    text = read_stdin_limited(rtlib.INBOX_MAX).decode("utf-8", "replace")
    out(inbox_append(job, msg_id, reply_to, text))


# ---------------------------------------------------------------- 결과물

def make_bundle(job: str, base_sha: str, dest: str, fps: list[dict]) -> dict:
    """작업 저장소 설정을 거치지 않도록 빈 임시 bare 저장소에서 bundle을 만든다(§19.3·§21.3)."""
    repo = os.path.join(job_dir(job), "repo")
    branch = f"refs/heads/rt/{job}"
    head = git(["rev-parse", "--verify", branch], cwd=repo).stdout.decode().strip()
    with tempfile.TemporaryDirectory(dir=os.path.join(job_dir(job), "tmp")) as tmp:
        bare = os.path.join(tmp, "b.git")
        git(["init", "-q", "--bare", bare])
        # 기준 커밋까지의 객체는 저장소 캐시에서 빌려 본다(alternates). fetch는 캐시 ref를 have로 알려 새 객체만 옮긴다.
        with open(os.path.join(job_dir(job), "job.json"), encoding="utf-8") as jf:
            rid = json.load(jf).get("repo_id")
        cache = repo_cache(job, rid) if rid else ""
        if cache and os.path.isdir(os.path.join(cache, "objects")):
            with open(os.path.join(bare, "objects", "info", "alternates"), "w", encoding="utf-8") as f:
                f.write(os.path.join(os.path.abspath(cache), "objects") + "\n")
        git(["fetch", "-q", "--no-tags", repo, f"+{branch}:{branch}"], cwd=bare, allow_file=True)
        diff = git(["diff", "--no-ext-diff", "--no-textconv", f"{base_sha}..{head}"], cwd=bare, check=False)
        if diff.returncode != 0:
            # base가 이 임시 저장소에 없으면 전체를 본다.
            diff = git(["log", "-p", "--no-ext-diff", "--no-textconv", head], cwd=bare)
        hits = rtlib.scan_secrets(diff.stdout.decode("utf-8", "replace"), fps)
        if hits:
            return {"status": "blocked_secret", "rules": sorted(set(hits)), "head": head}
        changed = git(["diff", "--name-only", f"{base_sha}..{head}"], cwd=bare, check=False).stdout.decode().splitlines()
        if any(p.startswith(FORBIDDEN_PREFIXES) or "/.git/" in p for p in changed):
            return {"status": "forbidden_path", "head": head}
        if head == base_sha:
            return {"status": "no_commits", "head": head}
        git(["bundle", "create", dest, branch, f"^{base_sha}"], cwd=bare)
    return {"status": "ok", "head": head, "sha256": rtlib.sha256_file(dest), "bytes": os.path.getsize(dest)}


def op_bundle(job: str) -> None:
    d = job_dir(job)
    meta = json.load(open(os.path.join(d, "job.json"), encoding="utf-8"))
    final = os.path.join(d, "out", "out.bundle")
    done = os.path.exists(os.path.join(d, "out", "done.json"))
    if done and os.path.exists(final):
        path = final
    else:
        path = os.path.join(d, "tmp", "snapshot.bundle")
        res = make_bundle(job, meta["base_sha"], path, rtlib.load_fingerprints())
        if res["status"] != "ok":
            raise ToolError(res["status"])
    with open(path, "rb") as f:
        shutil.copyfileobj(f, sys.stdout.buffer)
    sys.stdout.flush()


def op_logs(job: str) -> None:
    d = job_dir(job)
    tar = tarfile.open(fileobj=sys.stdout.buffer, mode="w|")
    total = 0
    for root, _dirs, files in os.walk(os.path.join(d, "out")):
        for name in sorted(files):
            path = os.path.join(root, name)
            rel = os.path.relpath(path, os.path.join(d, "out"))
            if rel == "out.bundle":
                continue
            st = os.lstat(path)
            if not os.path.isfile(path) or os.path.islink(path):
                continue
            total += st.st_size
            if total > (64 << 20):
                raise ToolError("logs_too_large")
            tar.add(path, arcname=rel, recursive=False)
    tar.close()
    sys.stdout.flush()


def op_cleanup(job: str) -> None:
    d = job_dir(job)
    for name in os.listdir(d):
        p = os.path.join(d, name)
        if os.path.isdir(p) and not os.path.islink(p):
            shutil.rmtree(p)
        else:
            os.unlink(p)
    out({"ok": True})


# ---------------------------------------------------------------- 마무리

def local_config_bad(repo: str) -> list[str]:
    proc = git(["config", "--local", "--list"], cwd=repo, check=False)
    keys = [line.split("=", 1)[0].lower() for line in proc.stdout.decode("utf-8", "replace").splitlines()]
    return [k for k in keys if k.startswith(BAD_LOCAL_CONFIG)]


def wip_paths(repo: str) -> list[str]:
    """WIP로 남길 경로. 에이전트 설정·git 내부 경로는 빼고(§16.7), 바뀐 파일만 고른다."""
    raw = git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], cwd=repo, check=False).stdout
    cargo = os.path.exists(os.path.join(repo, "Cargo.toml"))
    entries = raw.split(b"\0")
    paths: list[str] = []
    i = 0
    while i < len(entries):
        ent = entries[i]
        i += 1
        if len(ent) < 4:
            continue
        code, path = ent[:2], ent[3:].decode("utf-8", "surrogateescape")
        if code[:1] in (b"R", b"C"):
            i += 1  # 원래 경로 항목을 건너뛴다(삭제 쪽은 add -A가 새 경로와 함께 처리)
        if path.startswith(FORBIDDEN_PREFIXES) or "/.git/" in path or (code == b"??" and is_build_junk(path, cargo)):
            continue
        paths.append(path)
    return paths


# 시험·빌드가 남기는 산출물. 추적되지 않은 것만 해당한다(이미 추적 중인 파일은 status에서 수정으로 잡혀도 그대로 남긴다).
JUNK_DIRS = {"__pycache__", "node_modules", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".venv", ".tox"}
JUNK_SUFFIXES = (".pyc", ".pyo")


def is_build_junk(path: str, cargo: bool) -> bool:
    parts = path.rstrip("/").split("/")
    if any(p in JUNK_DIRS for p in parts) or path.endswith(JUNK_SUFFIXES):
        return True
    return cargo and parts[0] == "target"


def run_checks(d: str, repo: str, checks: list[dict], fps: list[dict], emit) -> list[dict]:
    results = []
    env = dict(os.environ)
    for chk in checks:
        cid, cmd, limit = chk["id"], chk["cmd"], int(chk.get("timeout_s", 1800))
        log_path = os.path.join(d, "out", "logs", f"{cid}.log")
        started = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        t_run = time.monotonic()
        try:
            proc = subprocess.run(["/bin/bash", "-c", cmd], cwd=repo, env=env, stdout=subprocess.PIPE,
                                  stderr=subprocess.STDOUT, timeout=limit)
            code, raw = proc.returncode, proc.stdout
        except subprocess.TimeoutExpired as exc:
            code, raw = 124, exc.output or b""
        lines = []
        for line in raw.decode("utf-8", "replace").splitlines():
            clean, _ = rtlib.redact_line(line, fps)
            lines.append(clean)
        text = "\n".join(lines) + "\n"
        duration_ms = int((time.monotonic() - t_run) * 1000)
        fd = os.open(log_path, os.O_CREAT | os.O_WRONLY | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        res = {"id": cid, "cmd": cmd, "exit": code, "started": started,
               "ended": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "duration_ms": duration_ms,
               "log": f"logs/{cid}.log", "log_bytes": os.path.getsize(log_path),
               "log_sha256": rtlib.sha256_file(log_path), "tail": text[-4096:]}
        results.append(res)
        emit("verify", {"id": cid, "exit": code})
    return results


def finish(job: str, gjc_exit: int | None, reason: str) -> dict:
    """WIP 커밋 → 검사 → 증거 → bundle. 러너 정상 종료와 finalize가 같이 쓴다(멱등)."""
    d = job_dir(job)
    done_path = os.path.join(d, "out", "done.json")
    if os.path.exists(done_path):
        return json.load(open(done_path, encoding="utf-8"))
    fps = rtlib.load_fingerprints()
    log = rtlib.EventLog(d, fps)
    open(os.path.join(d, "closing"), "a").close()
    meta = json.load(open(os.path.join(d, "job.json"), encoding="utf-8"))
    repo = os.path.join(d, "repo")
    base = meta["base_sha"]
    wip = "none"
    paths = wip_paths(repo)
    if paths:
        bad = local_config_bad(repo)
        if bad:
            wip = "blocked_config"
        else:
            spec = b"\0".join(p.encode() for p in paths) + b"\0"
            git(["add", "-A", "--sparse", "--pathspec-from-file=-", "--pathspec-file-nul"], cwd=repo, check=False,
                input_bytes=spec)
            diff = git(["diff", "--cached", "--no-ext-diff", "--no-textconv"], cwd=repo, check=False).stdout.decode(
                "utf-8", "replace")
            if not diff.strip():
                wip = "none"
            elif rtlib.scan_secrets(diff, fps):
                git(["reset", "-q"], cwd=repo, check=False)
                wip = "blocked_secret"
            else:
                c = git(["-c", "commit.gpgsign=false", "commit", "-q", "--no-verify", "-m", f"rt: WIP ({reason})"],
                        cwd=repo, check=False)
                wip = "committed" if c.returncode == 0 else "incomplete"
    run_verify = meta.get("verify", "runner") == "runner" and reason in ("completed", "gjc_failed")
    checks = run_checks(d, repo, meta.get("checks") or [], fps, log.emit) if run_verify else []
    head = git(["rev-parse", f"refs/heads/rt/{job}"], cwd=repo).stdout.decode().strip()
    commits = []
    rl = git(["log", "--format=%H%x00%s", f"{base}..{head}"], cwd=repo, check=False).stdout.decode("utf-8", "replace")
    for line in rl.splitlines():
        sha, _, subject = line.partition("\x00")
        files = git(["diff-tree", "--no-commit-id", "--name-only", "-r", sha], cwd=repo, check=False).stdout.decode().splitlines()
        commits.append({"sha": sha, "subject": rtlib.redact_line(subject, fps)[0], "files": len(files),
                        "wip": subject.startswith("rt: WIP")})
    report = {}
    for e in rtlib.read_jsonl(os.path.join(d, "events.jsonl")):
        if e.get("kind") == "final":
            report = e.get("data") or {}
    bundle_res = make_bundle(job, base, os.path.join(d, "out", "out.bundle"), fps)
    evidence = {
        "schema": "gjc-rt-evidence/1", "job": job, "generation": meta["gen"], "target": os.uname().nodename,
        "base": base, "head": head, "branch": meta["branch"], "commits": commits,
        "gjc": {"version": meta.get("gjc_version"), "model": meta.get("model"), "exit": gjc_exit},
        "checks": checks, "report": report, "wip": wip, "bundle": bundle_res, "reason": reason,
    }
    rtlib.write_json_atomic(os.path.join(d, "out", "evidence.json"), evidence)
    done = {"reason": reason, "gjc_exit": gjc_exit, "wip": wip, "bundle": bundle_res["status"], "head": head,
            "evidence_sha256": rtlib.sha256_file(os.path.join(d, "out", "evidence.json"))}
    log.emit("ended", done)
    rtlib.write_json_atomic(done_path, done)
    return done


def op_finish(job: str, reason: str) -> None:
    out(finish(job, None, reason))


def main(argv: list[str]) -> int:
    try:
        op, job = argv[1], argv[2]
        if op == "write-base":
            op_write_base(job)
        elif op == "prepare":
            op_prepare(job)
        elif op == "events":
            op_events(job, int(argv[3]), int(argv[4]), int(argv[5]))
        elif op == "status":
            op_status(job)
        elif op == "held":
            op_held(job)
        elif op == "inbox-append":
            op_inbox_append(job, argv[3], argv[4])
        elif op == "bundle":
            op_bundle(job)
        elif op == "logs":
            op_logs(job)
        elif op == "cleanup":
            op_cleanup(job)
        elif op == "finish":
            op_finish(job, argv[3])
        else:
            raise ToolError("bad_op")
        return 0
    except ToolError as exc:
        sys.stderr.write(json.dumps({"error": exc.code, "detail": exc.detail}, ensure_ascii=False) + "\n")
        return 3
    except (OSError, ValueError, KeyError, IndexError) as exc:
        sys.stderr.write(json.dumps({"error": "worktool_failed", "detail": type(exc).__name__}) + "\n")
        return 4


if __name__ == "__main__":
    sys.exit(main(sys.argv))
