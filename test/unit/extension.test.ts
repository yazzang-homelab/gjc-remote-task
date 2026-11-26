import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as zod from "zod/v4";

let home: string;
beforeAll(() => {
	home = mkdtempSync(join(tmpdir(), "rt-ext-"));
	process.env.GJC_RT_HOME = home;
});
afterAll(() => {
	delete process.env.GJC_RT_HOME;
	rmSync(home, { recursive: true, force: true });
});

async function loadTool() {
	const tools: any[] = [];
	const fake = { zod, registerTool: (t: any) => tools.push(t), on: () => {} };
	const mod = await import("../../extension/index");
	mod.default(fake);
	return tools[0];
}

const ctx = (meta: unknown) => ({ sessionMetadata: meta, sessionManager: { getSessionId: () => "sess-unit-0001" }, cwd: home });

test("P-1: 하위 세션·깊이>0·메타 없음은 main_only", async () => {
	const tool = await loadTool();
	for (const meta of [{ kind: "sub", taskDepth: 1 }, { kind: "main", taskDepth: 1 }, undefined]) {
		const r = await tool.execute("id", { action: "status" }, undefined, undefined, ctx(meta));
		expect(r.isError).toBe(true);
		expect(JSON.parse(r.content[0].text).error).toBe("main_only");
	}
});

test("메인 세션 status는 빈 목록을 돌려준다(원격 호출 없음)", async () => {
	const tool = await loadTool();
	const r = await tool.execute("id", { action: "status" }, undefined, undefined, ctx({ kind: "main", taskDepth: 0 }));
	expect(r.isError).toBe(false);
	expect(JSON.parse(r.content[0].text)).toEqual({ jobs: [] });
});

test("start 필수 인자 누락은 missing_argument", async () => {
	const tool = await loadTool();
	const r = await tool.execute("id", { action: "start", target: "lab" }, undefined, undefined, ctx({ kind: "main", taskDepth: 0 }));
	expect(JSON.parse(r.content[0].text)).toMatchObject({ error: "missing_argument", missing: ["task", "estimated_minutes"] });
});

test("다른 세션의 잡은 보이지 않는다", async () => {
	const tool = await loadTool();
	const r = await tool.execute("id", { action: "inbox", job_id: "rt-0000000000000000000000000a", cursor: "x" }, undefined, undefined, ctx({ kind: "main", taskDepth: 0 }));
	expect(JSON.parse(r.content[0].text).error).toBe("job_unknown");
});
