/**
 * 远端索引守卫：**索引里的路径是数据，不是指令。**
 *
 * 保留策略要删掉超额的旧快照，删除目标来自远端 `index.json` 里的
 * `archive` / `manifestFile` 字段。这构成一条信任边界 —— 索引可能被误改、
 * 被手工编辑、被另一个进程写坏，或者在多人共用的 WebDAV 目录里被替换。
 * 如果直接采信索引里的字符串当删除路径，一个 `../../../重要文件` 就能让
 * 清理逻辑删掉备份目录之外的东西。
 *
 * 所以本模块只认「本插件自己会生成的确切文件名」：id 形态 + 固定后缀，
 * 且必须位于配置的目录前缀下。任何不符的条目被丢弃并计数，**丢弃即意味着
 * 本轮不做任何删除** —— 对索引的认知不完整时，最安全的动作是什么都不删。
 *
 * 零第三方依赖。
 *
 * @module dsh-sync-backup/lib/index-guard
 */

/** 快照 id 形态：YYYYMMDD-HHMMSS-<8 位 hex>。与 archiveId() 的产出一致。 */
export const SNAPSHOT_ID_RE = /^\d{8}-\d{6}-[0-9a-f]{8}$/;

/** 两种通道各自的文件命名风格。 */
export const NAMING = Object.freeze({
  /** WebDAV：目录下直接放 `<id>.tar.gz`。 */
  webdav: (id) => ({ archive: `${id}.tar.gz`, manifest: `${id}.manifest.json` }),
  /** GitHub：仓库里用 `dsh-backup-` 前缀避免和别的文件混淆。 */
  github: (id) => ({
    archive: `dsh-backup-${id}.tar.gz`,
    manifest: `dsh-backup-${id}.manifest.json`,
  }),
});

/**
 * 校验单条索引条目。
 *
 * @param {unknown} entry
 * @param {{style: "webdav"|"github"}} opts
 * @returns {{ok:true, entry:object}|{ok:false, reason:string}}
 */
export function validateEntry(entry, opts) {
  const style = opts?.style ?? "webdav";
  const name = NAMING[style];
  if (!name) return { ok: false, reason: `未知的命名风格 "${style}"` };
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return { ok: false, reason: "条目不是对象" };
  }
  if (typeof entry.id !== "string" || !SNAPSHOT_ID_RE.test(entry.id)) {
    return { ok: false, reason: `id 形态非法: ${JSON.stringify(entry.id)}` };
  }
  const want = name(entry.id);
  // 关键：不是「消毒路径」，而是「必须精确等于我们会生成的文件名」。
  // 精确匹配天然排除 ../、绝对路径、盘符、查询符等一切变体。
  if (entry.archive !== want.archive) {
    return { ok: false, reason: `archive 不是本插件生成的文件名（期望 ${want.archive}，得到 ${JSON.stringify(entry.archive)}）` };
  }
  if (entry.manifestFile !== want.manifest) {
    return { ok: false, reason: `manifestFile 不是本插件生成的文件名（期望 ${want.manifest}，得到 ${JSON.stringify(entry.manifestFile)}）` };
  }
  if (entry.createdAt !== undefined && entry.createdAt !== null) {
    if (typeof entry.createdAt !== "string" || Number.isNaN(Date.parse(entry.createdAt))) {
      return { ok: false, reason: `createdAt 不是合法时间: ${JSON.stringify(entry.createdAt)}` };
    }
  }
  if (entry.archiveBytes !== undefined && entry.archiveBytes !== null) {
    const n = entry.archiveBytes;
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) {
      return { ok: false, reason: `archiveBytes 不是非负安全整数: ${JSON.stringify(n)}` };
    }
  }
  if (entry.archiveSha256 !== undefined && entry.archiveSha256 !== null) {
    if (typeof entry.archiveSha256 !== "string" || !/^[0-9a-f]{64}$/i.test(entry.archiveSha256)) {
      return { ok: false, reason: "archiveSha256 不是 64 位十六进制" };
    }
  }
  return { ok: true, entry };
}

/**
 * 过滤整份索引条目。
 *
 * @param {unknown[]} entries 索引里的 entries 数组
 * @param {{style: "webdav"|"github", dir: string}} opts
 * @returns {{valid: object[], rejected: Array<{reason:string, entry:unknown}>, trustIndex: boolean}}
 *   `trustIndex === false` 表示索引里有不可信条目 —— 调用方**必须跳过本轮删除**。
 */
export function filterIndexEntries(entries, opts) {
  const valid = [];
  const rejected = [];
  const seen = new Set();
  for (const raw of Array.isArray(entries) ? entries : []) {
    const r = validateEntry(raw, opts);
    if (!r.ok) {
      rejected.push({ reason: r.reason, entry: raw });
      continue;
    }
    // 重复 id 说明索引本身有矛盾（同一份快照两个条目），同样不可信。
    if (seen.has(r.entry.id)) {
      rejected.push({ reason: `id 重复: ${r.entry.id}`, entry: raw });
      continue;
    }
    seen.add(r.entry.id);
    valid.push(r.entry);
  }
  return { valid, rejected, trustIndex: rejected.length === 0 };
}

export default { SNAPSHOT_ID_RE, NAMING, validateEntry, filterIndexEntries };
