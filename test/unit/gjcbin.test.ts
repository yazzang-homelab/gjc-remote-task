import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RtConfig } from "../../extension/core/config";
import { type Fetcher, localPlatform, parseShaList, platformOf, resolveGjc } from "../../extension/core/gjcbin";

const sha = (b: string) => createHash("sha256").update(b).digest("hex");
const local = localPlatform()!;
const other = local === "linux-x64" ? "linux-arm64" : "linux-x64";

let dir: string;
let config: RtConfig;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "rt-gjcbin-"));
	writeFileSync(join(dir, "gjc-origin"), "origin-binary");
	config = {
		origin: "main",
		targets: {},
		box: { hubBase: "", keyFile: "" },
		gjcVersion: "1.2.3",
		gjcBinary: join(dir, "gjc-origin"),
		gjcBinaries: {},
		defaultModel: "",
		rtKey: { allowedModels: [] },
		thresholds: { recommendLoad: 0.8, recommendMemFree: 0.2 },
		retentionDays: 7,
		sshConnectTimeoutS: 10,
	};
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** 가짜 릴리스: 해시 목록과 자산. 부른 URL을 남긴다. */
function release(assets: Record<string, string>, list?: string) {
	const calls: string[] = [];
	const text = list ?? Object.entries(assets).map(([n, b]) => `${sha(b)}  ${n}`).join("\n");
	const fetcher: Fetcher = async url => {
		calls.push(url);
		const name = url.split("/").pop()!;
		if (!url.startsWith("https://github.com/Yeachan-Heo/gajae-code/releases/download/v1.2.3/")) return new Response("", { status: 404 });
		if (name === "gajae-release-binaries.sha256") return new Response(text);
		return name in assets ? new Response(assets[name]) : new Response("", { status: 404 });
	};
	return { fetcher, calls };
}

describe("플랫폼 이름", () => {
	test("uname·process 값을 릴리스 자산 이름으로 바꾼다", () => {
		expect(platformOf("Linux", "x86_64")).toBe("linux-x64");
		expect(platformOf("Linux", "aarch64")).toBe("linux-arm64");
		expect(platformOf("darwin", "arm64")).toBe("darwin-arm64");
		expect(platformOf("win32", "x64")).toBeNull();
		expect(platformOf("Linux", "riscv64")).toBeNull();
	});
	test("해시 목록은 gjc-<플랫폼> 줄만 읽는다(윈도·잘못된 줄은 버린다)", () => {
		const a = "a".repeat(64);
		expect(parseShaList(`${a}  gjc-linux-x64\n${a}  gjc-windows-x64.exe\nnot a line\n${a} *gjc-darwin-arm64\n`)).toEqual({ "linux-x64": a, "darwin-arm64": a });
	});
});

describe("resolveGjc", () => {
	test("원점과 같은 플랫폼은 원점 gjc를 그대로 쓴다(직접 빌드도 된다, 릴리스를 부르지 않는다)", async () => {
		const r = release({});
		expect(await resolveGjc(config, local, dir, r.fetcher)).toEqual({ path: config.gjcBinary, sha: sha("origin-binary") });
		expect(r.calls).toEqual([]);
	});

	test("gjcBinaries에 적은 파일이 먼저다", async () => {
		writeFileSync(join(dir, "mine"), "custom-arm");
		config.gjcBinaries = { [other]: join(dir, "mine") };
		const r = release({});
		expect(await resolveGjc(config, other, dir, r.fetcher)).toEqual({ path: join(dir, "mine"), sha: sha("custom-arm") });
		expect(r.calls).toEqual([]);
	});

	test("다른 플랫폼은 공식 릴리스에서 받아 해시를 확인하고 캐시한다", async () => {
		const r = release({ [`gjc-${local}`]: "origin-binary", [`gjc-${other}`]: "other-binary" });
		const got = await resolveGjc(config, other, dir, r.fetcher);
		expect(got.sha).toBe(sha("other-binary"));
		expect(got.path).toBe(join(dir, "gjc", "1.2.3", `gjc-${other}`));
		expect(r.calls.length).toBe(2);
		// 두 번째는 해시 목록·파일 모두 캐시에서 읽는다.
		await resolveGjc(config, other, dir, r.fetcher);
		expect(r.calls.length).toBe(2);
	});

	test("원점이 그 판의 공식 빌드가 아니면 다른 플랫폼 바이너리를 받지 않는다", async () => {
		const r = release({ [`gjc-${local}`]: "official-not-mine", [`gjc-${other}`]: "other-binary" });
		await expect(resolveGjc(config, other, dir, r.fetcher)).rejects.toThrow("gjc_custom_build");
		expect(r.calls.some(u => u.endsWith(`gjc-${other}`))).toBe(false);
	});

	test("받은 파일의 해시가 목록과 다르면 버린다", async () => {
		const list = `${sha("origin-binary")}  gjc-${local}\n${sha("expected")}  gjc-${other}\n`;
		const r = release({ [`gjc-${local}`]: "origin-binary", [`gjc-${other}`]: "tampered" }, list);
		await expect(resolveGjc(config, other, dir, r.fetcher)).rejects.toThrow("gjc_hash_mismatch");
		expect(readdirSync(join(dir, "gjc", "1.2.3")).filter(n => n.startsWith("gjc-"))).toEqual([]);
	});

	test("릴리스에 없는 플랫폼·규칙 밖 플랫폼·릴리스 접속 실패", async () => {
		const r = release({ [`gjc-${local}`]: "origin-binary" });
		await expect(resolveGjc(config, other, dir, r.fetcher)).rejects.toThrow("gjc_platform_unsupported");
		await expect(resolveGjc(config, "windows-x64", dir, r.fetcher)).rejects.toThrow("gjc_platform_unsupported");
		await expect(resolveGjc(config, "", dir, r.fetcher)).rejects.toThrow("gjc_platform_unsupported");
		const down: Fetcher = async () => {
			throw new Error("offline");
		};
		const fresh = mkdtempSync(join(tmpdir(), "rt-gjcbin-"));
		await expect(resolveGjc(config, other, fresh, down)).rejects.toThrow("gjc_release_unavailable");
		expect(existsSync(join(fresh, "gjc", "1.2.3", "release.sha256"))).toBe(false);
		rmSync(fresh, { recursive: true, force: true });
	});
});
