/**
 * 恢复前自检（dry-run restore）。
 *
 * ⚠️ **它回答「这份归档能不能恢复出来」，不负责真的恢复。**
 * 本插件至今没有 restore 接口（也不打算在没有明确交互前加），
 * 所以这里做的是「把归档解到临时目录 + 逐项校验」，**绝不写进 $DSH_HOME**。
 *
 * 五项检查：
 * 1. gzip + tar 能否完整解开（`openArchive`，带 checksum 校验）；
 * 2. 每个条目的 SHA256 与 manifest 记录是否逐条一致；
 * 3. 是否存在 USTAR 长路径拆分后无法还原的路径（>100 字节或 prefix>155）；
 * 4. 目标是否冲突：$DSH_HOME 里已存在同名文件（列出数量，不对比内容，不覆盖）；
 * 5. 版本兼容性：归档里的 dsh 版本标记 vs 当前运行时版本。
 *
 * 零第三方依赖。
 *
 * @module dsh-sync-backup/lib/restore-check
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { openArchive, resolveInside, checkArchivePath, PARSE_LIMITS } from "./archive.js";
import { sha256, isForbidden } from "./collect.js";
import { NAME_MAX, PREFIX_MAX, splitUstarPath } from "./archive.js";
import { decryptBytes, isEncrypted } from "./crypto.js";

/**
 * @typedef {Object} RestoreCheckResult
 * @property {boolean} ok            是否通过（等价于 errors 为空）
 * @property {string[]} errors       致命问题（这份归档恢复会失败）
 * @property {string[]} warnings     非致命提示（能恢复，但要注意）
 * @property {Object}   stats        {entries, bytes, forbidden, longPaths}
 * @property {string}   tempDir      解包用的临时目录（调用方负责删除）
 */

/**
 * 跑一次自检。
 *
 * @param {Buffer} gz gzip 后的归档
 * @param {object} opts
 * @param {string} opts.home         $DSH_HOME（用于目标冲突检查）
 * @param {Array<{path:string,sha256:string}>} [opts.manifest] 期望的条目清单
 * @param {string} [opts.archiveVersion] 归档里记录的 dsh 版本
 * @param {string} [opts.runtimeVersion] 当前 dsh 版本
 * @param {boolean} [opts.extract=false] 是否真把文件解到临时目录（默认只解元数据）
 * @returns {Promise<RestoreCheckResult>}
 */
export async function restoreCheck(packed, opts) {
  const errors = [];
  const warnings = [];
  const manifest = opts?.manifest ?? [];
  const extract = opts?.extract === true;
  const encrypted = isEncrypted(packed);

  // --- 0：解密（v3）—— 密钥不对就在这里停，不该等到 tar 报错才知道是密钥问题
  let gz = packed;
  if (encrypted) {
    const key = opts?.key;
    if (!Buffer.isBuffer(key)) {
      return {
        ok: false,
        errors: ["这份归档是加密的，但没有拿到密钥 —— 无法验证"],
        warnings,
        stats: { entries: 0, bytes: 0, forbidden: 0, longPaths: 0, encrypted: true },
        tempDir: "",
        encrypted: true,
      };
    }
    try {
      gz = decryptBytes(key, packed);
    } catch (err) {
      return {
        ok: false,
        errors: [`解密失败（密钥不对或归档被动过）：${String(err?.message ?? err)}`],
        warnings,
        stats: { entries: 0, bytes: 0, forbidden: 0, longPaths: 0, encrypted: true },
        tempDir: "",
        encrypted: true,
      };
    }
  }

  // --- 1 + 3：解包（含 USTAR checksum）与长路径检查 -----------------------------
  let entries;
  try {
    entries = openArchive(gz, { verifyChecksum: true, limits: opts?.limits });
  } catch (err) {
    return {
      ok: false,
      errors: [`归档无法解开：${String(err?.message ?? err)}`],
      warnings,
      stats: { entries: 0, bytes: 0, forbidden: 0, longPaths: 0, encrypted },
      tempDir: "",
      encrypted,
    };
  }

  let longPaths = 0;
  let forbidden = 0;
  let unsafePaths = 0;
  const actualPaths = new Map();
  for (const e of entries) {
    const rel = String(e.path).replace(/\\/g, "/");
    // 路径安全是所有后续动作（写文件、拼路径、对账）的前提，先查再记。
    if (!checkArchivePath(rel).ok) unsafePaths += 1;
    if (rel.length > NAME_MAX || rel.length > PREFIX_MAX + 1 + NAME_MAX) {
      const { name, prefix } = splitUstarPath(rel);
      if (name.length > NAME_MAX || prefix.length > PREFIX_MAX) {
        longPaths += 1;
        warnings.push(`路径过长无法用 USTAR 表示（${rel.length} 字节）：${rel}`);
      }
    }
    if (isForbidden(rel) != null) forbidden += 1;
    actualPaths.set(rel, sha256(e.data));
  }
  if (forbidden > 0) {
    errors.push(`归档里出现 ${forbidden} 条危险路径（凭据类），按设计不可能出现 —— 拒绝继续`);
  }
  if (unsafePaths > 0) {
    errors.push(
      `归档里有 ${unsafePaths} 条路径不安全（绝对路径 / 相对路径穿越 / 盘符 / 控制字符）—— 拒绝继续`,
    );
  }

  const bytes = entries.reduce((n, e) => n + e.data.length, 0);

  // --- 2：逐条 SHA256 比对 ----------------------------------------------------
  if (manifest.length > 0) {
    const expected = new Map(manifest.map((m) => [String(m.path).replace(/\\/g, "/"), m.sha256]));
    const missing = [];
    const mismatch = [];
    for (const [p, want] of expected) {
      const got = actualPaths.get(p);
      if (got === undefined) missing.push(p);
      else if (got !== want) mismatch.push(p);
    }
    const extra = [...actualPaths.keys()].filter((p) => !expected.has(p));
    if (missing.length > 0) errors.push(`manifest 声明但归档里缺失 ${missing.length} 项（如 ${missing[0]}）`);
    if (mismatch.length > 0) errors.push(`SHA256 不一致 ${mismatch.length} 项（如 ${mismatch[0]}）`);
    if (extra.length > 0) warnings.push(`归档里有 ${extra.length} 项不在 manifest 中`);
  } else {
    warnings.push("未提供 manifest，跳过逐条 SHA256 比对");
  }

  // --- 4：目标冲突（只 stat，不写） -------------------------------------------
  let conflicts = 0;
  for (const rel of actualPaths.keys()) {
    try {
      await fs.stat(path.join(opts.home, rel));
      conflicts += 1;
    } catch {
      // 不存在 = 无冲突
    }
  }
  if (conflicts > 0) {
    warnings.push(
      `${conflicts}/${actualPaths.size} 个文件在 \$DSH_HOME 里已存在 —— 真恢复时会覆盖同名文件（本次未写入任何文件）`,
    );
  }

  // --- 5：版本兼容 -------------------------------------------------------------
  if (opts?.archiveVersion && opts?.runtimeVersion) {
    if (opts.archiveVersion !== opts.runtimeVersion) {
      warnings.push(`版本差异：归档由 dsh ${opts.archiveVersion} 产生，当前为 ${opts.runtimeVersion}`);
    }
  }

  // --- 可选：解到临时目录（证明「能读出来」而不是只算出哈希） -------------------
  //
  // 契约：**成功时返回 tempDir 交给调用方删**（调用方可能还要看内容）；
  // 但中途失败时我们自己立刻删掉。以前这段没有兜底，一旦写文件抛错，
  // tempDir 变量压根没进入返回值，调用方拿不到路径 —— 临时目录就永久留在
  // 系统盘上了。自检失败往往是反复重试的场景，泄漏会不断累积。
  let tempDir = "";
  try {
    if (extract && errors.length === 0) {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dshsb-restore-"));
      for (const e of entries) {
        const rel = String(e.path).replace(/\\/g, "/");
        if (isForbidden(rel) != null) continue;
        // 前面已做过路径预检；这里是**写盘前的最后一道**：用解析后的绝对路径
        // 判断落点，不靠字符串拼接的直觉。
        const safe = resolveInside(tempDir, rel);
        if (!safe.ok) {
          throw new Error(`自检解包遇到不安全路径 "${rel}"（${safe.reason}）`);
        }
        await fs.mkdir(path.dirname(safe.abs), { recursive: true });
        await fs.writeFile(safe.abs, e.data);
      }
    }
  } catch (err) {
    await cleanupTempDir(tempDir).catch(() => {});
    tempDir = "";
    errors.push(`解到临时目录时失败：${String(err?.message ?? err)}`);
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    stats: { entries: entries.length, bytes, forbidden, longPaths, unsafePaths, encrypted },
    tempDir,
    encrypted,
  };
}

/** 删掉自检产生的临时目录（含内容）。 */
export async function cleanupTempDir(tempDir) {
  if (!tempDir) return;
  if (!tempDir.includes("dshsb-restore-")) return; // 只删我们自己 mkdtemp 出来的
  await fs.rm(tempDir, { recursive: true, force: true });
}

export default { restoreCheck, cleanupTempDir };
