import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RtConfig } from "../../extension/core/config";
import { Store } from "../../extension/core/store";
import { BoxTransport, boxTimes, type InstaboxRunner } from "../../extension/transport/box";

let dir: string;
let store: Store;
const config: RtConfig = {
	origin: "pve3",
	targets: { box2: { kind: "box", alias: "gjc-box-2", machine: "m2", maxSlots: 1 } },
	gjcVersion: "0.22.0",
	gjcBinary: "/x",
	defaultModel: "oci-opencodex/devin/swe-2:high",
	rtKey: { allowedModels: ["oci-opencodex/devin/swe-2"] },
	thresholds: { recommendLoad: 0.8, recommendMemFree: 0.2 },
	retentionDays: 7,
	sshConnectTimeoutS: 10,
	box: { hubBase: "http://h/v1", keyFile: "" },
};
const target = config.targets.box2 as Extract<RtConfig["targets"][string], { kind: "box" }>;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "rt-box-unit-"));
	store = new Store(join(dir, "state.db"));
	mkdirSync(join(dir, "box"), { recursive: true });
	mkdirSync(join(dir, "keys"), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function boxes(state: string, cooldown = 0, left = 300): InstaboxRunner {
	const calls: string[][] = [];
	const run: InstaboxRunner = async args => {
		calls.push(args);
		if (args.join(" ") === `-b ${target.alias} cli get ${target.machine} --json`) {
			const cooldownUntil = cooldown ? new Date(Date.now() + cooldown * 1000 + 500).toISOString() : null;
			return { code: 0, stdout: JSON.stringify({ id: "x", state, cooldownUntil, runStartedAt: null, maxRunMinutes: left }, null, 2), stderr: "" };
		}
		return { code: 1, stdout: "", stderr: "unexpected" };
	};
	return run;
}

describe("BoxTransport.probe (박스를 깨우지 않는다)", () => {
	test("상태·쿨다운·잔여 시간·묶음·키", async () => {
		const t = new BoxTransport("box2", target, dir, config, store, boxes("stopped", 30, 20));
		const p = await t.call("probe", ["--model", "oci-opencodex/devin/swe-2", "--est", "15"]);
		expect(p.admission).toEqual(["box_unavailable", "box_cooldown", "box_runtime_short", "box_bundle_missing"]);
		expect(p.credential).toBe(false);
		writeFileSync(join(dir, "box", "box.json"), "{}");
		writeFileSync(join(dir, "keys", "gjc-rt.key"), "k");
		const ok = await new BoxTransport("box2", target, dir, config, store, boxes("suspended", 0, 300)).call("probe", ["--est", "15"]);
		expect(ok.admission).toEqual([]);
		expect(ok.credential).toBe(true);
	});
});

describe("boxTimes (instabox get → 쿨다운·남은 실행 시간)", () => {
	const now = Date.parse("2026-11-26T00:00:00Z");
	test("실행 중이면 한도에서 지난 시간을 빼고, 잠든 박스는 깨우면 새 실행이라 한도 전체다", () => {
		const m = { state: "running", runStartedAt: "2026-11-25T23:00:30Z", maxRunMinutes: 120, cooldownUntil: null };
		expect(boxTimes(m, now)).toEqual({ state: "running", cooldownSeconds: 0, runLeftMinutes: 60 });
		expect(boxTimes({ ...m, state: "suspended" }, now).runLeftMinutes).toBe(120);
		expect(boxTimes({ ...m, runStartedAt: "2026-11-25T21:00:00Z" }, now).runLeftMinutes).toBe(0);
	});
	test("쿨다운은 남은 초(지났으면 0), 한도가 없으면 null", () => {
		expect(boxTimes({ state: "stopped", cooldownUntil: "2026-11-26T00:01:30Z", maxRunMinutes: 0 }, now)).toEqual({ state: "stopped", cooldownSeconds: 90, runLeftMinutes: null });
		expect(boxTimes({ state: "stopped", cooldownUntil: "2026-11-25T23:59:00Z" }, now).cooldownSeconds).toBe(0);
	});
});

describe("BoxTransport.events", () => {
	test("pump가 결과를 가져오기 전에는 ended를 내보내지 않는다", async () => {
		const t = new BoxTransport("box2", target, dir, config, store, boxes("running"));
		const sp = join(dir, "jobs", "rt-a", "box");
		mkdirSync(sp, { recursive: true });
		const ev = (seq: number, kind: string) => JSON.stringify({ seq, ts: "t", kind, data: {} });
		writeFileSync(join(sp, "events.jsonl"), `${[ev(1, "started"), ev(2, "final"), ev(3, "ended")].join("\n")}\n`);
		writeFileSync(join(sp, "pump-state.json"), JSON.stringify({ phase: "fetching" }));
		const before = await t.call("events", ["rt-a", 0]);
		expect(before.events.map((e: { kind: string }) => e.kind)).toEqual(["started", "final"]);
		expect(before.last_seq).toBe(2);
		writeFileSync(join(sp, "pump-state.json"), JSON.stringify({ phase: "done", release: { release: true, proof: "ended" } }));
		store.boxReserve("box2", "rt-a", 1, 1);
		const after = await t.call("events", ["rt-a", 2]);
		expect(after.events.map((e: { kind: string }) => e.kind)).toEqual(["ended"]);
		// pump의 반납 증명은 한 번만 원장에 반영된다.
		expect(store.boxSlot("rt-a")?.proof).toBe("ended");
		expect(store.boxUsed("box2")).toBe(0);
	});

	test("기다리는 동안 파일이 바뀌면 새 이벤트를 돌려준다(바뀌지 않으면 다시 읽지 않는다)", async () => {
		const t = new BoxTransport("box2", target, dir, config, store, boxes("running"));
		const sp = join(dir, "jobs", "rt-w", "box");
		mkdirSync(sp, { recursive: true });
		const ev = (seq: number, kind: string) => `${JSON.stringify({ seq, ts: "t", kind, data: {} })}\n`;
		writeFileSync(join(sp, "events.jsonl"), ev(1, "started"));
		writeFileSync(join(sp, "pump-state.json"), JSON.stringify({ phase: "running" }));
		setTimeout(() => writeFileSync(join(sp, "events.jsonl"), ev(1, "started") + ev(2, "progress")), 1200);
		const t0 = Date.now();
		const r = await t.call("events", ["rt-w", 1, "--wait", "5"]);
		expect(r.events.map((e: { kind: string }) => e.kind)).toEqual(["progress"]);
		expect(Date.now() - t0).toBeLessThan(3000);
		const none = await t.call("events", ["rt-w", 2, "--wait", "1"]);
		expect(none.events).toEqual([]);
		expect(none.last_seq).toBe(2);
	});

	test("주인 세션이 묻지 않아도 probe·reserve가 pump의 반납 증명으로 슬롯을 돌려준다", async () => {
		const t = new BoxTransport("box2", target, dir, config, store, boxes("running"));
		store.boxReserve("box2", "rt-o", 1, 1);
		const sp = join(dir, "jobs", "rt-o", "box");
		mkdirSync(sp, { recursive: true });
		writeFileSync(join(sp, "pump-state.json"), JSON.stringify({ phase: "fetching" }));
		expect((await t.call("probe", ["--est", "15"])).slots_used).toBe(1);
		// 반납 증명이 없으면 슬롯은 그대로다(다른 잡을 받지 않는다).
		await expect(t.call("reserve", ["rt-p", 1])).rejects.toThrow("slots_full");
		writeFileSync(join(sp, "pump-state.json"), JSON.stringify({ phase: "done", release: { release: true, proof: "ended" } }));
		expect((await t.call("probe", ["--est", "15"])).slots_used).toBe(0);
		await t.call("reserve", ["rt-p", 1]);
		expect(store.boxSlot("rt-o")?.proof).toBe("ended");
		expect(store.boxUsed("box2")).toBe(1);
	});

	test("반납 증명이 있는 박스 잡은 잡 행이 살아 있어도 로컬 선예약 상한에 세지 않는다", () => {
		const row = (id: string, state: string) =>
			({ job_id: id, gen: 1, target: "box2", owner_session: "s", repo_path: "/r", repo_id: "x", base_sha: "b", branch: `rt/${id}`,
				model: "m", est_min: 10, state, failure: null, cap: null, last_seq: 0, head: null, local_ref: null, evidence_sha256: null,
				checks_json: "[]", created_at: "t", updated_at: "t" }) as never;
		expect(store.reserveLocal(row("rt-x", "running"), 1)).toBe(true);
		store.boxReserve("box2", "rt-x", 1, 1);
		expect(store.reserveLocal(row("rt-y", "reserving"), 1)).toBe(false);
		store.boxRelease("rt-x", "queue_ended_unprepared");
		expect(store.reserveLocal(row("rt-y", "reserving"), 1)).toBe(true);
	});

	test("대기줄에 넣기 전 취소는 never_submitted로 반납", async () => {
		const t = new BoxTransport("box2", target, dir, config, store, boxes("running"));
		store.boxReserve("box2", "rt-b", 1, 1);
		const r = await t.call("cancel", ["rt-b", 1]);
		expect(r.release).toEqual({ release: true, proof: "never_submitted" });
		expect(store.boxUsed("box2")).toBe(0);
	});
});
