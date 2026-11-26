# Box drivers

A box is an untrusted, disposable cloud VM. The origin never gives it a key; it only receives a public repository, the unpushed commits, and the job instructions. Everything the origin does with a box goes through a **driver**: an executable `rt-box-<driver>` that `deploy/stage-box.sh` installs into `~/.gjc/agent/remote-task/box/drivers/`.

Pick the driver per target in `config.yml`:

```yaml
targets:
  pub1: { kind: box, driver: ssh, host: 203.0.113.10, user: debian, identityFile: ~/.ssh/rt-box, maxSlots: 1 }
  pub2: { kind: box, driver: instabox, alias: my-box, machine: my-box-machine, maxSlots: 1 }
```

| Driver | VM | Needs on the origin |
|---|---|---|
| `ssh` | Any VM reachable over SSH (EC2, GCE, Hetzner, DigitalOcean, your own hypervisor, ...) | `ssh`, the VM's host key in `~/.ssh/known_hosts` |
| `instabox` | instabox.sh microVM | the `instabox` CLI and an `instabox-q` queue helper (not part of this repository) |

## VM requirements (all drivers)

- x86_64 Linux with systemd (the box downloads the `gjc-linux-x64` release).
- The login account has passwordless `sudo`. `rt-boxctl` uses it to create the root-owned control area `/data/rt-ctl`, the unprivileged runner account `rtrun`, and the per-job systemd scope.
- `python3`, `git`, `curl`, `tar`, `setpriv` (util-linux).
- Outbound HTTPS to github.com. The box never connects to the origin; the origin reaches the box's relay through the driver's `forward`.

## Contract

The target object from `config.yml` is passed as JSON in the environment variable `RT_BOX_TARGET`. Remote paths are always under `/data/workspace/`. Exit code 0 means success unless stated otherwise.

| Verb | Arguments | Behaviour |
|---|---|---|
| `info` | | Print one JSON line `{"state", "cooldown_s", "run_left_min"}`. Must not wake a sleeping VM. `state` is one of `running`, `suspended`, `paused`, `resuming`, `starting` when the box can take work. `run_left_min` is `null` when there is no runtime cap. Non-zero exit means unreachable. |
| `put` | `LOCAL_DIR REMOTE_DIR` | Copy the contents of `LOCAL_DIR` into `REMOTE_DIR` (created if missing), keeping file modes. |
| `exec` | `-- CMD...` | Run a command as the login account. Pass stdout and the exit code through. |
| `submit` | `NAME TIMEOUT_S SCRIPT` | Run the local file `SCRIPT` on the box with bash, as the login account, detached from the connection, and stop it with SIGTERM after `TIMEOUT_S`. Print the job id on the last line. Exit 3 means the submission was refused. |
| `status` | `QID` | Print one JSON line `{"state", "exit"}`; `state` is `pending`, `running`, `done`, `failed`, `cancelled` or `unknown`. |
| `wait` | `QID` | Block until the job is finished. Returning early is allowed (the pump checks `status` and waits again). Keep the VM awake while waiting if it can idle-suspend. |
| `cancel` | `QID` | Stop the job with SIGTERM so `job.sh` can run its trap. Print one JSON line `{"pending_cancelled", "detail"}`; `pending_cancelled` is `true` only when the job was removed from a queue before it ever started. |
| `fetch` | `REMOTE_DIR LOCAL_DIR MAX_BYTES` | Copy `REMOTE_DIR` to `LOCAL_DIR` (or `LOCAL_DIR/out`). The data is untrusted: accept only regular files and directories with relative paths, never follow links, and stop at `MAX_BYTES`. |
| `forward` | `LPORT RPORT` | Run in the foreground, forwarding origin `127.0.0.1:LPORT` to box `127.0.0.1:RPORT`. |
| `pump-rw` | | Print, one per line, paths the driver must be able to write while running inside the pump's sandboxed unit (`ProtectHome=read-only`). |

To support another provider, copy `rt-box-ssh` or `rt-box-instabox`, implement the verbs, and put the file next to them before running `deploy/stage-box.sh`.
