// 배포 스크립트용: 대상 플랫폼의 gjc를 확장과 같은 규칙(extension/core/gjcbin.ts)으로 고른다.
// 사용: bun scripts/gjc-resolve.ts <원점 상태 dir> trusted <플랫폼>   → "<판> <플랫폼> <sha256>" (작업 호스트 신뢰표 한 줄, 파일은 캐시에 받아 둔다)
//       bun scripts/gjc-resolve.ts <원점 상태 dir> box-shas            → "linux-x64=<sha>,linux-arm64=<sha>" (박스가 직접 받는 공식 해시)
import { join } from "node:path";
import { loadConfig } from "../extension/core/config";
import { assertOfficialOrigin, GjcResolveError, releaseShas, resolveGjc } from "../extension/core/gjcbin";

const [home, cmd, platform] = process.argv.slice(2);
if (!home || !cmd) {
	console.error("usage: gjc-resolve.ts <rt home> trusted <platform> | box-shas");
	process.exit(64);
}
const config = loadConfig(join(home, "config.yml"));
if (!config.gjcVersion) {
	console.error(`gjc 판을 모른다: ${config.gjcBinary} --version 실패`);
	process.exit(1);
}
try {
	if (cmd === "trusted" && platform) {
		const bin = await resolveGjc(config, platform, home);
		console.log(`${config.gjcVersion} ${platform} ${bin.sha}`);
	} else if (cmd === "box-shas") {
		const shas = await releaseShas(config.gjcVersion, home);
		assertOfficialOrigin(config, shas);
		const linux = Object.entries(shas).filter(([p]) => p.startsWith("linux-"));
		console.log(linux.map(([p, s]) => `${p}=${s}`).join(","));
	} else {
		console.error(`unknown command: ${cmd}`);
		process.exit(64);
	}
} catch (e) {
	console.error(e instanceof GjcResolveError ? e.message : String(e));
	process.exit(e instanceof GjcResolveError ? 3 : 1);
}
