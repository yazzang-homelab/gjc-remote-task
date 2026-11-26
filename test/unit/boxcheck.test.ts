import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nearestPublic } from "../../extension/core/boxcheck";

let dir: string;
const sh = (args: string[]) => {
	const p = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir });
	if (p.exitCode !== 0) throw new Error(p.stderr.toString());
	return p.stdout.toString().trim();
};
const commit = (n: string) => {
	writeFileSync(join(dir, `${n}.txt`), n);
	sh(["add", "."]);
	sh(["commit", "-qm", n]);
	return sh(["rev-parse", "HEAD"]);
};

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "rt-pub-"));
	sh(["init", "-q", "-b", "main"]);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("nearestPublic: 공개 ref 가운데 base에서 가장 가까운 조상을 고르고, 조상이 아닌 ref·없는 SHA는 무시한다", async () => {
	const c1 = commit("c1");
	const c2 = commit("c2");
	sh(["checkout", "-qb", "side"]);
	const s1 = commit("s1");
	sh(["checkout", "-q", "main"]);
	const c3 = commit("c3");
	const base = commit("c4");
	const missing = "f".repeat(40);
	// 공개: c1·c3(조상), s1(다른 가지), 없는 SHA. 가장 가까운 공개 조상은 c3, 미push 1개.
	expect(await nearestPublic(dir, new Set([c1, c3, s1, missing]), base)).toEqual({ sha: c3, ahead: 1 });
	expect(await nearestPublic(dir, new Set([c1, s1]), base)).toEqual({ sha: c1, ahead: 3 });
	expect(await nearestPublic(dir, new Set([base, c1]), base)).toEqual({ sha: base, ahead: 0 });
	expect(await nearestPublic(dir, new Set([s1, missing]), base)).toBeNull();
	expect(c2).not.toBe(c3);
});
