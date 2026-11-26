// 배포 도구: 원격 agent 템플릿 렌더(키·헤더 제외, baseUrl 바꾸기)와 비밀 지문 모으기.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");

describe("render-agent-template", () => {
	test("허용 모델만·키와 헤더는 빼고·baseUrl 바꾸기", () => {
		const d = mkdtempSync(join(tmpdir(), "rt-tpl-"));
		const src = join(d, "models.yml");
		writeFileSync(
			src,
			[
				"providers:",
				"  hub:",
				"    baseUrl: https://hub.example.com/v1",
				"    api: openai-responses",
				"    apiKey: sk-should-not-leak-0123456789",
				"    headers: { X-Probe: header-must-not-leak }",
				"    models:",
				"      - { id: m1, name: M1 }",
				"      - { id: m2, name: M2 }",
			].join("\n"),
		);
		const out = join(d, "out");
		const r = Bun.spawnSync(["bun", join(ROOT, "scripts/render-agent-template.ts"), src, out, "hub", "m2", "http://127.0.0.1:10100/v1"]);
		expect(r.exitCode).toBe(0);
		const text = readFileSync(join(out, "models.yml"), "utf8");
		expect(text).not.toContain("should-not-leak");
		expect(text).not.toContain("header-must-not-leak");
		const doc = Bun.YAML.parse(text) as any;
		expect(doc.providers.hub.baseUrl).toBe("http://127.0.0.1:10100/v1");
		expect(doc.providers.hub.apiKeyEnv).toBe("GJC_RT_KEY");
		expect(doc.providers.hub.models.map((m: any) => m.id)).toEqual(["m2"]);
		const cfg = Bun.YAML.parse(readFileSync(join(out, "config.yml"), "utf8")) as any;
		expect(cfg.modelRoles.default).toBe("hub/m2");
		const bad = Bun.spawnSync(["bun", join(ROOT, "scripts/render-agent-template.ts"), src, out, "hub", "nope"]);
		expect(bad.exitCode).not.toBe(0);
	});
});

describe("rt_fingerprints", () => {
	test("jsonl·파일 쌍을 모아 중복·짧은 값을 버린다", () => {
		const rt = mkdtempSync(join(tmpdir(), "rt-fp-"));
		const key = join(rt, "key");
		writeFileSync(key, "abcdefghijklmnop\n");
		const line = JSON.stringify({ name: "x", len: 16, sha256: new Bun.CryptoHasher("sha256").update("abcdefghijklmnop").digest("hex") });
		writeFileSync(join(rt, "fingerprints.jsonl"), `${line}\n{"name":"short","len":3,"sha256":"00"}\nnot json\n`);
		const r = Bun.spawnSync(["bash", "-c", `HERE='${ROOT}'; RT='${rt}'; . "$HERE/deploy/lib.sh"; rt_fingerprints hub='${key}' none='${rt}/missing'`]);
		expect(r.exitCode).toBe(0);
		const list = JSON.parse(r.stdout.toString());
		expect(list).toHaveLength(1);
		expect(list[0]).toEqual({ name: "x", len: 16, sha256: JSON.parse(line).sha256 });
		expect(r.stdout.toString()).not.toContain("abcdefghijklmnop");
	});
});
