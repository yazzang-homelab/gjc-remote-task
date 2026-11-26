# gjc-remote-task

[English](README.md) · [한국어](README.ko.md) · **中文** · [Español](README.es.md)

一个 [Gajae Code](https://github.com/Yeachan-Heo/gajae-code)（`gjc`）扩展，用于**在其他机器上运行 executor 任务**。它只新增一个工具 `remote_task`。主会话把已提交的仓库快照和任务说明发送到远程主机；远程主机上一个隔离运行的 `gjc` executor 完成工作，主会话验证返回的提交后，把它们导入为本地分支。

适合那些会拖慢你当前工作机器的重型构建和测试。只与模型对话的轻量任务，用本地子代理更划算，因为协调远程任务本身也会消耗一些本地 CPU。

## 功能

- **两类目标**
  - *受信任的 SSH 工作主机*：由你自行部署。
  - *公开任务用的 box（可选）*：一次性的 [instabox.sh](https://instabox.sh) microVM，视为不受信任。只运行公开仓库，绝不接收任何凭据。
- **一个工具覆盖任务的完整生命周期**
  - `plan`：显示本地负载、候选目标以及被排除的原因。目标由调用方选择。
  - `start`：把已提交的 `HEAD`（或 `base_ref`）打包成 git bundle 发送出去。远程 executor 在 `rt/<job>` 分支上工作。
  - `await`、`inbox`、`send`：等待提问或任务结束，读取远程事件，并在运行过程中回答 executor 的提问。
  - `collect`：验证返回的提交，并导入为 `refs/heads/remote/<target>/<job>`。使用 `final` 时还会删除远程任务。
  - `cancel`、`status`：停止任务或查看状态。
- **自动唤醒**：主会话空闲时，如果远程任务提出问题或结束，监视器会唤醒主会话。
- **由远程运行器执行检查**：传入 `checks`（`{id, cmd, timeout_s}`）后，executor 报告完成时，远程运行器会亲自重新运行这些检查，结果会写入 `collect` 要验证的证据中。
- **没有隐藏的自动化**：不会自动切换到其他目标，不会退回本地执行，也不会自动合并。合并由你自己决定。

## 工作原理

```
 主机（origin）                                    工作主机（受信任，SSH）
 ┌──────────────────────────┐   ssh，强制命令     ┌──────────────────────────────────┐
 │ gjc 主会话               │ ──────────────────▶ │ gjcrt-ctl → rt-dispatch → sudo   │
 │  └ remote_task 扩展      │   上传 git bundle   │   rt-helper（root，固定动词）    │
 │     ├ state.db（任务）   │ ◀────────────────── │   └ 每个任务一个 systemd 单元    │
 │     └ 监视器（唤醒）     │   事件 / bundle     │       rt-runner → gjc executor   │
 └──────────────────────────┘                     └──────────────────────────────────┘
          │  instabox-q 队列 + port-forward（只拉取）
          ▼
 公开 box（不受信任）：relay ⇄ origin 上的 pump ⇄ 模型 hub（密钥只留在 origin）
```

- **工作主机**
  - origin 以 `gjcrt-ctl` 账户连接工作主机。该账户的密钥绑定在强制命令（`rt-dispatch --origin <名称>`）上，登录 shell 拒绝其他一切命令。
  - 该账户通过 `sudo` 只能运行唯一的 root 辅助程序 `rt-helper`，而且只能使用固定的一组动词。
  - 每个任务以无特权账户 `gjcrt` 运行在临时 systemd 单元中。单元带有内存和任务数限制、`ProtectSystem=strict` 以及运行时长上限。所有任务共用一个设置了 CPU/IO 权重的 slice。
- **准入控制**：负载过高、内存压力（PSI）过大、磁盘不足或槽位已满时，拒绝新任务。预留的槽位是会过期的租约。
- **认证**：每个 origin 有独立的注册令牌。每个任务会获得一个 HMAC 能力令牌，后续调用必须出示它。
- **密钥指纹**
  - 工作主机上安装的是真实密钥的指纹（名称、长度、SHA-256），从不传送密钥值或其中任何片段。
  - 结果、日志或事件中一旦出现匹配的字符串，就会被拦截。
  - 工作主机上专用的模型 hub 密钥也以同样方式记录指纹。
- **box 模式**
  - 发送前，origin 会检查仓库的 GitHub origin 是否公开（匿名 API），以及基准提交是否存在于公开仓库中；随后扫描尚未推送的提交和任务说明，查找令牌格式和指纹。
  - box 无法反向连接。origin 上的 pump 通过 `instabox port-forward` 从 box 的 relay 拉取模型请求，并带上密钥转发给 hub；密钥从不离开 origin。
  - box 拒绝 `needs: [docker|sudo]` 的任务，也拒绝会超出 box 剩余运行时长的任务。

## 环境要求

- **origin**：`gjc` 0.22 或更高版本以及 Bun、`git`、`ssh`、Python 3.10+。
- **工作主机**：带 systemd（cgroup v2）的 Linux、OpenSSH、`sudo` 1.9.10+（用于正则规则）、`git`、Python 3.10+。CPU 架构需与 origin 相同，因为 origin 会上传自己的 `gjc` 可执行文件，工作主机用固定的 SHA-256 校验它。开发环境为 Debian 13。
- **模型 hub**：一个兼容 OpenAI 的模型端点，以及一个只允许指定模型的工作主机专用 API 密钥。
- **box 传输（可选）**：`instabox` CLI 和 `instabox-q` 队列工具。`instabox-q` 不包含在本仓库中；没有它时，请只配置 SSH 目标。

## 安装

### 1. origin

```bash
git clone https://github.com/yazzang-homelab/gjc-remote-task
cd gjc-remote-task && bun install
mkdir -p ~/.gjc/agent/remote-task
cp config.example.yml ~/.gjc/agent/remote-task/config.yml   # 修改目标、模型、gjcBinary
bash deploy/sync.sh             # 把 extension/ 安装到 ~/.gjc/agent/extensions/remote-task
```

### 2. 每台工作主机

1. 复制并修改 profile：

   ```bash
   cp deploy/profiles/example.config.json deploy/profiles/build1.config.json
   cp deploy/profiles/example.slice.conf  deploy/profiles/build1.slice.conf
   ```

   修改 `build1.config.json`（provider、allowed_models、hub_models_url、槽位、限制）和 `build1.slice.conf`（CPU 与内存限制）。
2. 可选：登记密钥指纹。每行只包含名称、长度和 SHA-256，不包含密钥本身：

   ```bash
   python3 scripts/fingerprint.py --name gh <(gh auth token) >> ~/.gjc/agent/remote-task/fingerprints.jsonl
   ```

3. 通过 root SSH 部署（`<目标> <root ssh 别名> <profile>`）：

   ```bash
   RT_FROM=203.0.113.10 bash deploy/stage-worker.sh build1 root@build1 build1
   ```

   `RT_FROM` 是本 origin 发起连接的地址，会写入 `authorized_keys from=`。如果目标是链路本地地址，或 origin 装有 Tailscale，可以省略。设置 `RT_EXTRA_SETUP=deploy/extras/debian-rust.sh` 可同时安装构建工具链。
4. 安装专用 hub 密钥。密钥只从 stdin 读取：

   ```bash
   cat hub-worker.key | bash deploy/install-key.sh root@build1
   ```

要回滚工作主机，在该主机上以 root 运行 `deploy/rollback-worker.sh`。要让另一台主机也使用同一台工作主机，使用 `deploy/add-origin.sh`。

### 3. box（可选）

在 `config.yml` 中添加 `kind: box` 目标和 `box:` 配置段，然后运行 `bash deploy/stage-box.sh`。box 池的账本保存在该 origin 的本地状态中，因此 box 只应在一个 origin 上配置。

## 使用

该工具只能在**主**会话中使用。常见调用：

```jsonc
{ "action": "plan", "estimated_minutes": 15 }
{ "action": "start", "target": "build1", "estimated_minutes": 15,
  "task": "修复 crates/parse 中失败的解析器测试",
  "checks": [{ "id": "test", "cmd": "cargo test -p parse", "timeout_s": 900 }],
  "wait": "collect" }                       // 在一次调用中等待结束并回收
{ "action": "await", "job_id": "rt-…", "until": "ended", "collect": "final" }
{ "action": "send",  "job_id": "rt-…", "reply_to": "<qid>", "text": "使用 v2 API" }
```

`start` 会拒绝存在未提交改动的仓库。`collect` 之后，请自行审查并合并 `remote/<target>/<job>`。

## 实测结果

以下数据来自一套家庭实验室环境：origin 为 Intel Xeon E-2124G，另有两台工作主机和一台 4 vCPU 的 box。所有任务都经过真实 hub 使用真实模型运行。每种组合把本地运行（L）与远程运行（R）配对，至少运行 5 轮，表中为中位数。

| 目标 | 远程任务占用的本地 CPU（R ÷ L） | 运行时间（R ÷ L） |
|---|---|---|
| SSH 工作主机（Rust/cargo 任务和合成重负载任务，热启动与冷启动） | 0.001 – 0.027 | 0.63 – 1.17 |
| 公开 box（对公开仓库运行 bun test） | 0.10 – 0.15 | 2.1 – 2.3 |

SSH 的运行时间比不含远程运行器重新执行 `checks` 的时间，因为本地基准在测量区间之外运行同样的检查。计入这部分时间后，最差的组合为 1.24。box 明显更慢，适合用来减轻 origin 的负载，而不是为了更快完成。实际数值取决于你的主机、网络和模型延迟。

## 局限

- 代码注释、工具说明和远程角色提示词（`worker/bundle/role.md`）为韩语，远程 executor 也被要求用韩语报告。如需更改，请编辑 `role.md`。
- 只支持 `executor` 类型的工作。远程端不会再委派给其他代理。
- SSH 工作主机需要 root 部署、systemd 和 sudo。不支持没有 systemd 的容器。
- box 传输依赖 instabox.sh 和未公开的 `instabox-q` 工具。

## 开发

```bash
bun install
bun test test/unit                 # 扩展单元测试
bunx tsc --noEmit -p .
for t in test/py/test_*.py; do python3 "$t"; done   # 工作主机端测试
```

`test/fixtures/mock-hub.py` 是一个模拟模型 hub，可在没有真实密钥的情况下测试部署（`RT_TEST_HUB=host:port`）。

## 许可证

MIT，见 [LICENSE](LICENSE), [NOTICE](NOTICE)。`worker/bundle/role.md` 改编自 Gajae Code 的 executor 提示词（MIT，© Yeachan-Heo and Gajae Code Contributors）。
