// 메인 models.yml에서 허용 모델만 골라 원격 agent dir 템플릿(models.yml, config.yml)을 만든다.
// 사용: bun scripts/render-agent-template.ts <메인 models.yml> <출력 dir> <provider> <모델ID,...> [baseUrl]
//   baseUrl을 주면 공급자 주소를 바꾼다(박스 relay, 시험용 가짜 허브).
// 키 값은 옮기지 않는다. 원격은 apiKeyEnv GJC_RT_KEY로 받는다.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [src, outDir, provider, modelList, baseUrl] = process.argv.slice(2);
if (!src || !outDir || !provider || !modelList) {
	console.error("usage: render-agent-template.ts <models.yml> <outDir> <provider> <ids> [baseUrl]");
	process.exit(64);
}
const wanted = modelList.split(",").map(s => s.trim()).filter(Boolean);
const doc = Bun.YAML.parse(readFileSync(src, "utf8")) as any;
const p = doc?.providers?.[provider];
if (!p) throw new Error(`provider not found: ${provider}`);
const models = (p.models ?? []).filter((m: any) => wanted.includes(m.id));
const missing = wanted.filter(id => !models.some((m: any) => m.id === id));
if (missing.length) throw new Error(`models not found: ${missing.join(",")}`);
// 키·헤더(비밀이 들 수 있음)는 옮기지 않는다.
const { apiKey: _drop, apiKeyEnv: _drop2, headers: _drop3, models: _m, modelOverrides, ...rest } = p;
// 원격에서 쓰는 모델의 덮어쓰기만 남긴다.
const overrides = Object.fromEntries(Object.entries(modelOverrides ?? {}).filter(([id]) => wanted.includes(id)));
const out = { providers: { [provider]: { ...rest, ...(baseUrl ? { baseUrl } : {}), ...(Object.keys(overrides).length ? { modelOverrides: overrides } : {}), apiKeyEnv: "GJC_RT_KEY", models } } };
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "models.yml"), Bun.YAML.stringify(out, null, 2));
const config = {
	configSchemaVersion: 2,
	ui: { language: "ko" },
	modelRoles: { default: `${provider}/${wanted[0]}` },
	pet: { mode: "off" },
	hideThinkingBlock: true,
	// 원격 executor에는 goal 도구가 필요 없다(tools.txt 밖 도구를 늘리지 않는다).
	goal: { enabled: false },
};
writeFileSync(join(outDir, "config.yml"), Bun.YAML.stringify(config, null, 2));
console.log(JSON.stringify({ provider, models: wanted }));
