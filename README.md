# gjc-remote-task

**English** · [한국어](README.ko.md) · [中文](README.zh-CN.md) · [Español](README.es.md)

A [Gajae Code](https://github.com/Yeachan-Heo/gajae-code) (`gjc`) extension that runs **executor work on other machines**. It adds one tool, `remote_task`. The main session sends a committed repository snapshot and a task to a remote host. A sandboxed `gjc` executor does the work there, and the main session reviews the resulting commits and imports them as a local branch.

Use it for heavy build and test work that would otherwise load the machine you are working on. Light, conversation-only work is cheaper as a local subagent, because coordinating a remote job also costs some local CPU.

## What it does

- **Two kinds of targets**
  - *Trusted SSH worker hosts* that you provision.
  - Optional *public-work boxes*: disposable cloud VMs, treated as untrusted. They run only public repositories and never receive credentials. A small driver talks to the VM: `ssh` works with any VM you can reach over SSH (EC2, GCE, Hetzner, DigitalOcean, ...), and `instabox` works with [instabox.sh](https://instabox.sh) microVMs.
- **A full job lifecycle in one tool**
  - `plan` shows local load, the candidate targets, and why any were rejected. You pick the target.
  - `start` sends a git bundle of a committed `HEAD` (or `base_ref`). The remote executor works on branch `rt/<job>`.
  - `await`, `inbox` and `send` let you wait for a question or the end of the job, read remote events, and answer the executor's questions in the middle of a run.
  - `collect` verifies the returned commits and imports them as `refs/heads/remote/<target>/<job>`. `final` also deletes the remote job.
  - `cancel` and `status` stop or inspect jobs.
- **Automatic wake-up.** While the main session is idle, a watcher wakes it when a remote job asks a question or finishes.
- **Runner-side checks.** You pass `checks` (`{id, cmd, timeout_s}`). The remote runner re-runs them itself after the executor reports done, and the results are part of the evidence `collect` verifies.
- **No hidden automation.** It never fails over to another target, never falls back to local execution, and never merges. Merging is up to you.

## How it works

```
 main host (origin)                               worker host (trusted, SSH)
 ┌──────────────────────────┐   ssh, forced cmd   ┌──────────────────────────────────┐
 │ gjc main session         │ ──────────────────▶ │ gjcrt-ctl → rt-dispatch → sudo   │
 │  └ remote_task extension │   git bundle up     │   rt-helper (root, fixed verbs)  │
 │     ├ state.db (jobs)    │ ◀────────────────── │   └ systemd unit per job (gjcrt) │
 │     └ watcher (wake-up)  │   events / bundle   │       rt-runner → gjc executor   │
 └──────────────────────────┘                     └──────────────────────────────────┘
          │  box driver: upload, submit, port-forward (pull only)
          ▼
 public box (untrusted): relay ⇄ pump on origin ⇄ model hub (key stays on origin)
```

- **Worker host**
  - The origin reaches the worker as the account `gjcrt-ctl`. Its key is pinned to a forced command (`rt-dispatch --origin <name>`), and its login shell refuses everything else.
  - `sudo` lets that account run exactly one root helper, `rt-helper`, with a fixed set of verbs.
  - Each job runs as the unprivileged account `gjcrt` inside a transient systemd unit. The unit has memory and task limits, `ProtectSystem=strict`, and a runtime cap. All jobs share a CPU/IO-weighted slice.
- **Admission.** The worker refuses new jobs on high load, memory pressure (PSI), low disk, or when all slots are taken. Reserved slots are leases that expire.
- **Authentication.** Each origin has its own registration token. Each job gets an HMAC capability token, and later calls must present it.
- **Secret fingerprints**
  - Fingerprints of real secrets are installed on the worker: a name, a length and a SHA-256 hash, never the value or any part of it.
  - Results, logs and events that contain a matching string are blocked.
  - The dedicated model-hub key on the worker is fingerprinted the same way.
- **Box mode**
  - Before dispatch, the origin checks that the repository's GitHub origin is public (anonymous API) and that the base commit is public. It then scans the unpushed commits and the task text for token patterns and fingerprints.
  - The box cannot connect back. A pump on the origin pulls model requests from the box's relay through the driver's port forward and forwards them to the hub with the key, which never leaves the origin.
  - Boxes refuse `needs: [docker|sudo]` and jobs that would outlive the box's remaining runtime.

## Requirements

- **Origin:** `gjc` ≥ 0.22 with Bun, `git`, `ssh`, and Python 3.10+.
- **Worker:** Linux with systemd (cgroup v2), OpenSSH, `sudo` ≥ 1.9.10 (for the regex rule), `git`, and Python 3.10+. The same CPU architecture as the origin, because the origin uploads its own `gjc` binary and the worker checks it against a pinned SHA-256. Developed on Debian 13.
- **Model hub:** an OpenAI-compatible model endpoint, and a dedicated API key for the workers that allows only the models you list.
- **Box (optional):** an x86_64 Linux VM with systemd, passwordless `sudo` for the login account, `python3`, `git`, `curl` and `tar`. The `ssh` driver needs only `ssh` on the origin and the VM's host key in `~/.ssh/known_hosts`. The `instabox` driver needs the `instabox` CLI and an `instabox-q` queue helper, which is not part of this repository. See [worker/box/drivers/README.md](worker/box/drivers/README.md).

## Setup

### 1. Origin

```bash
git clone https://github.com/yazzang-homelab/gjc-remote-task
cd gjc-remote-task && bun install
mkdir -p ~/.gjc/agent/remote-task
cp config.example.yml ~/.gjc/agent/remote-task/config.yml   # edit targets, models, gjcBinary
bash deploy/sync.sh             # installs extension/ to ~/.gjc/agent/extensions/remote-task
```

### 2. Each worker host

1. Copy and edit a profile:

   ```bash
   cp deploy/profiles/example.config.json deploy/profiles/build1.config.json
   cp deploy/profiles/example.slice.conf  deploy/profiles/build1.slice.conf
   ```

   Edit `build1.config.json` (provider, allowed_models, hub_models_url, slots, limits) and `build1.slice.conf` (CPU and memory limits).
2. Optionally register secret fingerprints. Each line holds a name, a length and a SHA-256, never the secret:

   ```bash
   python3 scripts/fingerprint.py --name gh <(gh auth token) >> ~/.gjc/agent/remote-task/fingerprints.jsonl
   ```

3. Provision over root SSH (`<target> <root ssh alias> <profile>`):

   ```bash
   RT_FROM=203.0.113.10 bash deploy/stage-worker.sh build1 root@build1 build1
   ```

   `RT_FROM` is the address this origin connects from. It is written into `authorized_keys from=`. You can omit it if the target is a link-local address or the origin has Tailscale. Set `RT_EXTRA_SETUP=deploy/extras/debian-rust.sh` to also install build toolchains.
4. Install the dedicated hub key. It is read from stdin only:

   ```bash
   cat hub-worker.key | bash deploy/install-key.sh root@build1
   ```

Roll back a worker with `deploy/rollback-worker.sh`, run as root on the worker. Let another main host use the same worker with `deploy/add-origin.sh`.

### 3. Boxes (optional)

Add a `kind: box` target with a `driver` (`ssh` by default) and the `box:` section to `config.yml`, then run `bash deploy/stage-box.sh`. To support another provider, write a driver that implements the verbs in [worker/box/drivers/README.md](worker/box/drivers/README.md). Configure boxes on one origin only, because the box pool ledger lives in that origin's local state.

## Usage

The tool is available in the **main** session only. Typical calls:

```jsonc
{ "action": "plan", "estimated_minutes": 15 }
{ "action": "start", "target": "build1", "estimated_minutes": 15,
  "task": "Fix the failing parser tests in crates/parse",
  "checks": [{ "id": "test", "cmd": "cargo test -p parse", "timeout_s": 900 }],
  "wait": "collect" }                       // wait for the end and collect in one call
{ "action": "await", "job_id": "rt-…", "until": "ended", "collect": "final" }
{ "action": "send",  "job_id": "rt-…", "reply_to": "<qid>", "text": "Use the v2 API" }
```

`start` refuses repositories with uncommitted changes. After `collect`, review and merge `remote/<target>/<job>` yourself.

## Measured results

These come from one homelab setup: an Intel Xeon E-2124G origin, two worker hosts, and one 4 vCPU instabox.sh box (`instabox` driver). Every job used a real model through a real hub. Each configuration ran at least 5 paired rounds, comparing a local run (L) with the remote run (R). The table shows medians.

| Target | Local CPU used by a remote job (R ÷ L) | Wall time (R ÷ L) |
|---|---|---|
| SSH workers (Rust/cargo task and a synthetic heavy task, warm and cold) | 0.001 – 0.027 | 0.63 – 1.17 |
| Public box (bun test on a public repository) | 0.10 – 0.15 | 2.1 – 2.3 |

The SSH wall ratio leaves out the time the remote runner spends re-running `checks`, because the local baseline runs the same checks outside its measured interval. With that time included, the worst configuration was 1.24. Boxes are much slower, so use them to shed load from the origin, not to finish sooner. Your numbers will depend on your hosts, network and model latency.

## Limitations

- Code comments, the tool description and the remote role prompt (`worker/bundle/role.md`) are in Korean, and the remote executor is told to report in Korean. Edit `role.md` to change this.
- Only `executor`-style work is supported. The remote side does not delegate to other agents.
- SSH workers need root provisioning, systemd and sudo. Containers without systemd are not supported.
- The measured box numbers above use the `instabox` driver. The `ssh` driver was checked end to end on a real cloud VM (a question and answer job, and a cancelled job, both collected) with a mock model hub, but it has no performance measurements.

## Development

```bash
bun install
bun test test/unit                 # extension unit tests
bunx tsc --noEmit -p .
for t in test/py/test_*.py; do python3 "$t"; done   # worker-side tests
```

`test/fixtures/mock-hub.py` is a fake model hub for staging without a real key (`RT_TEST_HUB=host:port`).

## License

MIT. See [LICENSE](LICENSE), [NOTICE](NOTICE). `worker/bundle/role.md` is adapted from the executor prompt of Gajae Code (MIT, © Yeachan-Heo and Gajae Code Contributors).
