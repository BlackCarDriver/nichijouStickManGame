/**
 * 数据注册表：把 data/ 下的 JSON 收集成运行时可用列表。
 * - 游戏：取默认地图 / 指定地图
 * - 编辑器：列出所有地图与预制件供选择
 *
 * 注意：校验用 MapValidator（纯逻辑，不依赖 Vite），这里只负责收集。
 */
import type { MapData } from './MapFormat';
import type { PrefabData } from './PrefabFormat';

interface JsonModule<T> {
  default: T;
}

const mapModules = import.meta.glob<JsonModule<MapData>>('../../data/maps/*.json', { eager: true });
const prefabModules = import.meta.glob<JsonModule<PrefabData>>('../../data/prefabs/*.json', { eager: true });

/** 所有地图（按 name 排序，顺序稳定） */
export function listMaps(): MapData[] {
  return Object.values(mapModules)
    .map((m) => m.default)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function getMapByName(name: string): MapData | undefined {
  return listMaps().find((m) => m.name === name);
}

/** 默认地图：优先 arena1，否则第一张 */
export function getDefaultMap(): MapData {
  const maps = listMaps();
  if (maps.length === 0) {
    throw new Error('[MapRegistry] data/maps 下没有任何地图文件');
  }
  return maps.find((m) => m.name === 'arena1') ?? maps[0];
}

/** 所有预制件（按 id 排序） */
export function listPrefabs(): PrefabData[] {
  return Object.values(prefabModules)
    .map((m) => m.default)
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** 预制件 id → 数据 */
export function getPrefabTable(): Record<string, PrefabData> {
  const table: Record<string, PrefabData> = {};
  for (const p of listPrefabs()) table[p.id] = p;
  return table;
}

/**
 * 内容指纹（djb2 哈希，只用于"文件是否被外部改过"的变更检测）。
 * 与 `MATERIALS_FILE_HASH` 同源同算法，保证编辑器几处草稿守卫行为一致。
 */
export function dataHash(value: unknown): string {
  const input = JSON.stringify(value);
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

/**
 * 地图「文件版本」的指纹（按 name 找 data/maps/*.json）。
 * 编辑器草稿恢复时用它判断：文件从存草稿到现在有没有被外部改过。
 * 返回 null = 当前没有同名文件（例如编辑器里新建、还没导出）。
 */
export function mapFileHash(name: string): string | null {
  const file = getMapByName(name);
  return file ? dataHash(file) : null;
}

/** 预制件「文件版本」的指纹（按 id 找 data/prefabs/*.json）；null = 文件不存在 */
export function prefabFileHash(id: string): string | null {
  const file = listPrefabs().find((p) => p.id === id);
  return file ? dataHash(file) : null;
}
