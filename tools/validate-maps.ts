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
import { expandPrefab } from '../src/map/PrefabExpand';
import type { MaterialsFile } from '../src/config/materials';

const ROOT = join(import.meta.dirname, '..');
const DATA = join(ROOT, 'data');

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

/**
 * 收集一张地图里所有地图物体的 id（与 MapLoader.buildMap 的编号规则一致）。
 *
 * 为什么必须校验唯一性：联机时"哪个箱子被摧毁/哪块物体被推开"全靠这个 id 对齐。
 * 一旦重复，销毁事件会作用到别的物体上（或只作用到其中一个），
 * 表现就是"我这少了一个箱子、你那边没少"。
 */
function collectObjectIds(raw: unknown, prefabs: PrefabData[]): string[] {
  const m = (raw ?? {}) as Record<string, unknown>;
  const ids: string[] = [];
  let seq = 0;
  const byId = new Map(prefabs.map((p) => [p.id, p]));

  const objects = Array.isArray(m.objects) ? (m.objects as Array<Record<string, unknown>>) : [];
  for (const obj of objects) ids.push(typeof obj.id === 'string' && obj.id ? obj.id : `obj_${seq++}`);

  const instances = Array.isArray(m.prefabs) ? (m.prefabs as Array<Record<string, unknown>>) : [];
  for (const inst of instances) {
    const instId = typeof inst.id === 'string' && inst.id ? inst.id : `prefab_${seq++}`;
    const prefab = byId.get(String(inst.ref));
    if (!prefab) continue;
    if ((prefab.bodyMode ?? 'loose') === 'compound') {
      ids.push(instId);
      continue;
    }
    expandPrefab(prefab, { ...inst, id: instId } as never).forEach((part, j) => {
      ids.push(typeof part.id === 'string' && part.id ? part.id : `${instId}#${j}`);
    });
  }
  return ids;
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

  // ---- items（道具表：用于校验 map.items[].type）----
  const itemsPath = join(DATA, 'items.json');
  const itemIds = existsSync(itemsPath)
    ? Object.keys((readJson<{ items?: Record<string, unknown> }>(itemsPath).items ?? {}))
    : [];
  const weaponsPath = join(DATA, 'weapons.json');
  const weaponIds = existsSync(weaponsPath)
    ? Object.keys((readJson<{ weapons?: Record<string, unknown> }>(weaponsPath).weapons ?? {}))
    : [];

  // ---- maps ----
  const mapDir = join(DATA, 'maps');
  const mapFiles = existsSync(mapDir) ? readdirSync(mapDir).filter((f) => f.endsWith('.json')).sort() : [];
  const mapIssues: Issue[] = [];
  for (const file of mapFiles) {
    const raw = readJson<unknown>(join(mapDir, file));
    const ctx = makeContext(materialIds, prefabs, itemIds, weaponIds);
    mapIssues.push(...validateMap(raw, ctx).map((i) => ({ ...i, path: `maps/${file} → ${i.path}` })));
    // 物体 id 唯一性（联机同步的基石）
    const counts = new Map<string, number>();
    for (const id of collectObjectIds(raw, prefabs)) counts.set(id, (counts.get(id) ?? 0) + 1);
    for (const [id, n] of counts) {
      if (n > 1) {
        mapIssues.push({
          level: 'error',
          path: `maps/${file} → objects.id`,
          message: `物体 id "${id}" 重复 ${n} 次（联机的销毁/同步会串到别的物体上）`,
        });
      }
    }
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
