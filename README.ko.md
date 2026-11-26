# gjc-remote-task

[English](README.md) · **한국어** · [中文](README.zh-CN.md) · [Español](README.es.md)

[Gajae Code](https://github.com/Yeachan-Heo/gajae-code)(`gjc`)의 **executor 작업을 다른 컴퓨터에서 돌리는** 확장입니다. 도구 `remote_task` 하나를 추가합니다. 메인 세션이 커밋된 저장소와 작업 지시를 원격 호스트로 보냅니다. 그곳에서 격리된 `gjc` executor가 작업하고, 메인 세션은 결과 커밋을 검증한 뒤 로컬 브랜치로 가져옵니다.

지금 쓰는 컴퓨터에 부담을 주는 무거운 빌드·시험에 씁니다. 원격 작업을 조율하는 데에도 로컬 CPU가 조금 들기 때문에, 모델과 대화만 하는 가벼운 일은 로컬 서브에이전트가 더 쌉니다.

## 기능

- **대상 두 가지**
  - *신뢰 작업 호스트(SSH)*: 직접 설치해서 씁니다.
  - *공개 작업용 박스(선택)*: 일회용 [instabox.sh](https://instabox.sh) microVM입니다. 신뢰하지 않는 곳으로 보고 공개 저장소만 돌리며, 자격 증명은 절대 보내지 않습니다.
- **도구 하나로 작업 전 과정을 다룹니다**
  - `plan`: 로컬 부하, 후보 대상, 탈락 사유를 보여 줍니다. 대상은 호출하는 쪽이 고릅니다.
  - `start`: 커밋된 `HEAD`(또는 `base_ref`)를 git bundle로 보냅니다. 원격 executor는 `rt/<job>` 브랜치에서 일합니다.
  - `await`·`inbox`·`send`: 질문이나 종료를 기다리고, 원격 이벤트를 읽고, 실행 중인 executor의 질문에 답합니다.
  - `collect`: 돌아온 커밋을 검증해 `refs/heads/remote/<target>/<job>`로 가져옵니다. `final`이면 원격 작업도 지웁니다.
  - `cancel`·`status`: 작업을 멈추거나 상태를 봅니다.
- **자동 깨움**: 메인 세션이 쉬고 있을 때 원격 작업이 질문하거나 끝나면 감시자가 세션을 깨웁니다.
- **러너 검사**: `checks`(`{id, cmd, timeout_s}`)를 주면 executor가 끝났다고 보고한 뒤 원격 러너가 직접 다시 돌립니다. 그 결과는 `collect`가 검증하는 증거에 들어갑니다.
- **숨은 자동화 없음**: 다른 대상으로 자동 재시도하지 않고, 로컬 실행으로 넘어가지 않고, merge하지 않습니다. merge는 사용자가 직접 합니다.

## 동작 방식

```
 메인 호스트(원점)                                 작업 호스트(신뢰, SSH)
 ┌──────────────────────────┐   ssh, 강제 명령    ┌──────────────────────────────────┐
 │ gjc 메인 세션            │ ──────────────────▶ │ gjcrt-ctl → rt-dispatch → sudo   │
 │  └ remote_task 확장      │   git bundle 올림   │   rt-helper(root, 정해진 동사만) │
 │     ├ state.db(작업)     │ ◀────────────────── │   └ 작업별 systemd 유닛(gjcrt)   │
 │     └ 감시자(깨움)       │   이벤트·bundle     │       rt-runner → gjc executor   │
 └──────────────────────────┘                     └──────────────────────────────────┘
          │  instabox-q 대기줄 + port-forward(당겨 오기만)
          ▼
 공개 박스(비신뢰): relay ⇄ 원점의 pump ⇄ 모델 허브(키는 원점에만)
```

- **작업 호스트**
  - 원점은 `gjcrt-ctl` 계정으로 접속합니다. 그 키는 강제 명령(`rt-dispatch --origin <이름>`)에 묶여 있고, 로그인 셸은 그 밖의 명령을 모두 거부합니다.
  - 이 계정이 `sudo`로 실행할 수 있는 것은 root 도우미 `rt-helper` 하나뿐이고, 동사도 정해져 있습니다.
  - 작업은 비특권 계정 `gjcrt`로 작업마다 만드는 임시 systemd 유닛에서 돕니다. 유닛에는 메모리·태스크 한도, `ProtectSystem=strict`, 실행 시간 상한이 걸립니다. 모든 작업은 CPU·IO 가중치가 걸린 slice 하나를 함께 씁니다.
- **입장 판단**: 부하가 높거나, 메모리 압박(PSI)이 크거나, 디스크가 모자라거나, 슬롯이 다 찼으면 새 작업을 거절합니다. 예약한 슬롯은 만료되는 임대입니다.
- **인증**: 원점마다 등록 토큰이 따로 있습니다. 작업마다 HMAC 권한 토큰을 발급하고, 이후 호출은 이 토큰을 내야 합니다.
- **비밀 지문**
  - 실제 비밀의 지문(이름·길이·SHA-256)을 작업 호스트에 둡니다. 값이나 값의 일부는 보내지 않습니다.
  - 결과·로그·이벤트에 같은 문자열이 섞이면 막습니다.
  - 작업 호스트에 넣는 전용 허브 키도 같은 방식으로 지문을 둡니다.
- **박스 모드**
  - 보내기 전에 원점이 확인합니다. 저장소의 GitHub 원본이 공개(익명 API)인지, 기준 커밋이 공개 저장소에 있는지 봅니다. 그다음 아직 push하지 않은 커밋과 작업 지시문에서 토큰 모양과 지문을 검사합니다.
  - 박스는 원점에 접속할 수 없습니다. 원점의 pump가 `instabox port-forward`로 박스 relay의 모델 요청을 당겨 와 허브로 보냅니다. 키는 원점 밖으로 나가지 않습니다.
  - 박스는 `needs: [docker|sudo]` 작업과 박스의 남은 실행 시간을 넘길 작업을 거절합니다.

## 요구 사항

- **원점**: `gjc` 0.22 이상과 Bun, `git`, `ssh`, Python 3.10 이상.
- **작업 호스트**: systemd(cgroup v2)가 있는 Linux, OpenSSH, `sudo` 1.9.10 이상(정규식 규칙), `git`, Python 3.10 이상. 원점과 CPU 아키텍처가 같아야 합니다. 원점이 자기 `gjc` 실행 파일을 올리고, 작업 호스트가 고정된 SHA-256으로 확인하기 때문입니다. Debian 13에서 개발했습니다.
- **모델 허브**: OpenAI 호환 모델 엔드포인트와, 정한 모델만 허용하는 작업 호스트 전용 API 키.
- **박스 전송(선택)**: `instabox` CLI와 `instabox-q` 대기줄 도구. `instabox-q`는 이 저장소에 없습니다. 없으면 SSH 대상만 설정하세요.

## 설치

### 1. 원점

```bash
git clone https://github.com/yazzang-homelab/gjc-remote-task
cd gjc-remote-task && bun install
mkdir -p ~/.gjc/agent/remote-task
cp config.example.yml ~/.gjc/agent/remote-task/config.yml   # 대상·모델·gjcBinary 수정
bash deploy/sync.sh             # extension/을 ~/.gjc/agent/extensions/remote-task에 설치
```

### 2. 작업 호스트마다

1. profile을 복사해 고칩니다:

   ```bash
   cp deploy/profiles/example.config.json deploy/profiles/build1.config.json
   cp deploy/profiles/example.slice.conf  deploy/profiles/build1.slice.conf
   ```

   `build1.config.json`(provider·allowed_models·hub_models_url·슬롯·한도)과 `build1.slice.conf`(CPU·메모리 한도)를 수정합니다.
2. 선택: 비밀 지문을 등록합니다. 한 줄에 이름·길이·SHA-256만 담기고 비밀 값은 담기지 않습니다:

   ```bash
   python3 scripts/fingerprint.py --name gh <(gh auth token) >> ~/.gjc/agent/remote-task/fingerprints.jsonl
   ```

3. root SSH로 설치합니다(`<대상> <root ssh 별칭> <profile>`):

   ```bash
   RT_FROM=203.0.113.10 bash deploy/stage-worker.sh build1 root@build1 build1
   ```

   `RT_FROM`은 이 원점이 접속하는 주소이고, `authorized_keys from=`에 들어갑니다. 대상이 링크로컬 주소이거나 원점에 Tailscale이 있으면 생략해도 됩니다. 빌드 도구까지 넣으려면 `RT_EXTRA_SETUP=deploy/extras/debian-rust.sh`를 줍니다.
4. 전용 허브 키를 넣습니다. 키는 stdin으로만 받습니다:

   ```bash
   cat hub-worker.key | bash deploy/install-key.sh root@build1
   ```

작업 호스트를 되돌리려면 그 호스트에서 root로 `deploy/rollback-worker.sh`를 실행합니다. 다른 메인 호스트도 같은 작업 호스트를 쓰게 하려면 `deploy/add-origin.sh`를 씁니다.

### 3. 박스(선택)

`config.yml`에 `kind: box` 대상과 `box:` 항목을 넣고 `bash deploy/stage-box.sh`를 실행합니다. 박스 풀 원장이 그 원점의 로컬 상태에 있으므로, 박스는 원점 한 곳에만 설정합니다.

## 사용

도구는 **메인** 세션에서만 동작합니다. 흔한 호출:

```jsonc
{ "action": "plan", "estimated_minutes": 15 }
{ "action": "start", "target": "build1", "estimated_minutes": 15,
  "task": "crates/parse의 실패하는 파서 시험을 고쳐라",
  "checks": [{ "id": "test", "cmd": "cargo test -p parse", "timeout_s": 900 }],
  "wait": "collect" }                       // 한 번의 호출로 종료까지 기다렸다가 회수
{ "action": "await", "job_id": "rt-…", "until": "ended", "collect": "final" }
{ "action": "send",  "job_id": "rt-…", "reply_to": "<qid>", "text": "v2 API를 써라" }
```

`start`는 커밋하지 않은 변경이 있는 저장소를 거절합니다. `collect` 뒤에는 `remote/<target>/<job>`을 직접 검토하고 merge합니다.

## 측정 결과

홈랩 한 곳에서 잰 값입니다. 원점은 Intel Xeon E-2124G이고, 작업 호스트 두 대와 4 vCPU 박스 하나를 썼습니다. 모든 작업은 실제 허브를 거쳐 실제 모델로 돌렸습니다. 조합마다 로컬 실행(L)과 원격 실행(R)을 짝지어 5회 이상 돌렸고, 표의 값은 중앙값입니다.

| 대상 | 원격 작업이 쓰는 로컬 CPU(R ÷ L) | 실행 시간(R ÷ L) |
|---|---|---|
| SSH 작업 호스트(Rust/cargo 작업과 합성 무거운 작업, 웜·콜드) | 0.001 – 0.027 | 0.63 – 1.17 |
| 공개 박스(공개 저장소 bun test) | 0.10 – 0.15 | 2.1 – 2.3 |

SSH 실행 시간 비율에서는 원격 러너가 `checks`를 다시 돌린 시간을 뺐습니다. 로컬 기준 실행은 같은 검사를 측정 구간 밖에서 돌리기 때문입니다. 그 시간을 넣으면 가장 나쁜 조합이 1.24였습니다. 박스는 훨씬 느리므로 빨리 끝내려고 쓰기보다 원점 부하를 덜려고 씁니다. 실제 수치는 호스트·네트워크·모델 지연에 따라 달라집니다.

## 한계

- 코드 주석, 도구 설명, 원격 역할 문서(`worker/bundle/role.md`)가 한국어이고, 원격 executor는 한국어로 보고하라는 지시를 받습니다. 바꾸려면 `role.md`를 고치세요.
- `executor` 성격의 작업만 지원합니다. 원격 쪽은 다른 에이전트에게 위임하지 않습니다.
- SSH 작업 호스트는 root 설치, systemd, sudo가 필요합니다. systemd 없는 컨테이너는 지원하지 않습니다.
- 박스 전송은 instabox.sh와 공개되지 않은 `instabox-q` 도구에 의존합니다.

## 개발

```bash
bun install
bun test test/unit                 # 확장 단위 시험
bunx tsc --noEmit -p .
for t in test/py/test_*.py; do python3 "$t"; done   # 작업 호스트 쪽 시험
```

`test/fixtures/mock-hub.py`는 실제 키 없이 설치를 시험하는 가짜 모델 허브입니다(`RT_TEST_HUB=host:port`).

## 라이선스

MIT. [LICENSE](LICENSE), [NOTICE](NOTICE)를 보세요. `worker/bundle/role.md`는 Gajae Code의 executor 프롬프트(MIT, © Yeachan-Heo and Gajae Code Contributors)를 고쳐 쓴 것입니다.
