import { getWeapon, listWeaponIds } from '../combat/WeaponFormat';
import { getItem, listItemIds } from './ItemFormat';

/**
 * "投放内容"解析：地图投放点（`map.weapons[]`）既可以刷武器，也可以刷补给道具
 * （医疗包 / 防弹衣）。
 *
 * 为什么要统一解析：客户端（单机）与服务端（联机）必须**用同一套规则**决定
 * "这个点这次刷什么"，否则两端看到的东西不一样（联机时表现为"我这边是枪、
 * 你那边是药包"）。所以规则写死在这一个地方，服务端用 Go 里的同名函数照抄一份。
 */

export type DropContentKind = 'weapon' | 'item';

export interface DropContentDef {
  kind: DropContentKind;
  id: string;
  name: string;
}

/** 武器或道具 id → 内容定义（都不是 → null） */
export function resolveDropContent(id: string | null | undefined): DropContentDef | null {
  if (!id) return null;
  const weapon = getWeapon(id);
  if (weapon) return { kind: 'weapon', id, name: weapon.name };
  const item = getItem(id);
  if (item) return { kind: 'item', id, name: item.name };
  return null;
}

/** 可投放的全部内容（武器在前、道具在后，顺序稳定） */
export function listDropContents(): DropContentDef[] {
  const out: DropContentDef[] = [];
  for (const id of listWeaponIds()) {
    const w = getWeapon(id);
    if (w) out.push({ kind: 'weapon', id, name: w.name });
  }
  for (const id of listItemIds()) {
    const it = getItem(id);
    if (it) out.push({ kind: 'item', id, name: it.name });
  }
  return out;
}

/** 可投放的全部 id（武器 + 道具） */
export function listDropContentIds(): string[] {
  return [...listWeaponIds(), ...listItemIds()];
}
