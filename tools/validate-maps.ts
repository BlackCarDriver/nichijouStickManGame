/**
 * 数据校验 CLI —— AI Agent / 手写地图的第一道护栏。
 *
 * 用法：npm run validate
 * 退出码：有 error 时为 1（可直接接 CI / pre-commit）
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';

import {
  validateMap,
  validatePrefab,
  validateMaterialsFile,
  makeContext,
  type Issue,
} from '../src/map/MapValidator';
import type { PrefabData } from '../src/map/PrefabFormat';
import type { MaterialsFile } from '../src/config/materials';

const ROOT = join(import.meta.dirname, '..');
const DATA = join(ROOT, 'data');

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function printIssues(title: string, issues: Issue[]): number {
  const errors = issues.filter((i) => i.level === 'error');
  const warns = issues.filter((i) => i.level === 'warn');
  if (issues.length === 0) {
    console.log(`  ✅ ${title}`);
    return 0;
  }
  const icon = errors.length > 0 ? '❌' : '⚠️ ';
  console.log(`  ${icon} ${title}  (${errors.length} error, ${warns.length} warn)`);
  for (const i of issues) {
    const tag = i.level === 'error' ? 'error' : 'warn ';
    console.log(`     [${tag}] ${i.path}: ${i.message}`);
  }
  return errors.length;
}

function main(): void {
  console.log('\n=== 校验 data/ ===\n');
  let errorCount = 0;

  // ---- materials ----
  const materialsPath = join(DATA, 'materials.json');
  let materialIds: string[] = [];
  if (!existsSync(materialsPath)) {
    console.log('  ❌ 缺少 data/materials.json');
    errorCount++;
  } else {
    const raw = readJson<MaterialsFile>(materialsPath);
    // 贴图文件是否真的存在于 public/ 下（浏览器校验做不到，CLI 可以）
    const textureExists = (rel: string): boolean => {
      const clean = rel.replace(/^\/+/, '');
      return existsSync(join(ROOT, 'public', clean)) || existsSync(join(ROOT, clean));
    };
    errorCount += printIssues('data/materials.json', validateMaterialsFile(raw, { textureExists }));
    materialIds = Object.keys(raw.materials ?? {});
  }

  // ---- prefabs ----
  const prefabDir = join(DATA, 'prefabs');
  const prefabs: PrefabData[] = [];
  const prefabIssues: Issue[] = [];
  if (existsSync(prefabDir)) {
    for (const file of readdirSync(prefabDir).filter((f) => f.endsWith('.json')).sort()) {
      const path = join(prefabDir, file);
      const raw = readJson<PrefabData>(path);
      const ctx = makeContext(materialIds, prefabs);
      prefabIssues.push(...validatePrefab(raw, ctx).map((i) => ({ ...i, path: `prefabs/${file} → ${i.path}` })));
      prefabs.push(raw);
      if (raw.id && raw.id !== basename(file, '.json')) {
        prefabIssues.push({
          level: 'warn',
          path: `prefabs/${file} → id`,
          message: `id "${raw.id}" 与文件名不一致（地图用 ref 引用的是 id，建议保持一致）`,
        });
      }
    }
  }
  errorCount += printIssues(`data/prefabs  (${prefabs.length} 个)`, prefabIssues);

  // ---- maps ----
  const mapDir = join(DATA, 'maps');
  const mapFiles = existsSync(mapDir) ? readdirSync(mapDir).filter((f) => f.endsWith('.json')).sort() : [];
  const mapIssues: Issue[] = [];
  for (const file of mapFiles) {
    const raw = readJson<unknown>(join(mapDir, file));
    const ctx = makeContext(materialIds, prefabs);
    mapIssues.push(...validateMap(raw, ctx).map((i) => ({ ...i, path: `maps/${file} → ${i.path}` })));
  }
  errorCount += printIssues(`data/maps  (${mapFiles.length} 张地图)`, mapIssues);

  console.log('');
  if (errorCount > 0) {
    console.log(`❌ 校验失败：${errorCount} 个错误\n`);
    process.exit(1);
  }
  console.log('✅ 校验通过\n');
}

main();
