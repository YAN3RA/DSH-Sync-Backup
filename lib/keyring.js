/**
 * 加密密钥管理（v3）。零第三方依赖。
 *
 * ## 存在哪里，以及这意味着什么
 *
 * 密钥落在 `$DSH_HOME/dsh-sync-backup/key.b64`（权限 0600），
 * **和归档放在同一个目录下**。所以加密防的不是「同机上的另一个进程」——
 * 真有那个权限的话，它连 key 一起读走了。
 *
 * 加密防的是**归档离开本机之后的那一段**：拷到 U 盘、传上网盘、
 * 或者哪天目录被人整体打包带走。归档本身是密文的，没有那份 key 就解不开。
 *
 * 这个取舍必须说清楚，否则「本地落盘 + 自动加密」听起来比它实际提供的强得多。
 * 想让 key 和归档物理分离，就把 `key.b64` 挪到别处，或只用恢复码保管好后
 * 删掉它 —— 但那样每次备份都要先用恢复码把 key 放回来。
 *
 * ## 恢复码为什么等于密钥本身
 *
 * 见 `lib/crypto.js` 的说明。**拿到恢复码 = 拿到全部数据**。
 * 界面只在用户主动点「导出」时才会显示完整的一次，之后永远是掩码。
 *
 * @module dsh-sync-backup/lib/keyring
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { generateKey, encodeRecoveryCode, decodeRecoveryCode, maskRecoveryCode } from "./crypto.js";

export const KEY_FILENAME = "key.b64";

/**
 * 同一个 dataDir 上的「正在取 key」的承诺。
 *
 * **为什么必须去重**：tmp 文件名原本只带 pid，于是同一进程里两个并发调用
 * （runOnce 的打包线程与 statusSnapshot 的取状态）会写同一个 tmp 文件，
 * 先完成的那个把它 rename 走，后一个再 rename 就是 ENOENT —— 表现为随机一条
 * 「ENOENT: ... key.b64.tmp-<pid>」错误，极难归因。这里让并发调用共享一次
 * 真实创建，顺手也避免同一次备份跑两遍随机数生成。
 */
const inflight = new Map();

/** key 文件绝对路径。 */
export function keyPath(dataDir) {
  return path.join(dataDir, KEY_FILENAME);
}

/**
 * 读取已有密钥，不存在则生成一个新的并写入。
 *
 * @returns {Promise<{key: Buffer, created: boolean, recoveryCode: string}>}
 */
export function loadOrCreateKey(dataDir) {
  const pending = inflight.get(dataDir);
  if (pending) return pending;
  const task = loadOrCreateKeyOnce(dataDir);
  inflight.set(dataDir, task);
  // 无论成功失败都要摘掉缓存项，否则一次失败会被永久记住。
  // `.finally()` 会返回一个**新** promise；上面 set 进去的是 `task` 本身，
  // 所以删除动作必须挂在 `task` 上，而不是把 finally 的结果写回 Map。
  void task.catch(() => {}).then(() => { if (inflight.get(dataDir) === task) inflight.delete(dataDir); });
  return task;
}

async function loadOrCreateKeyOnce(dataDir) {
  const file = keyPath(dataDir);
  try {
    const raw = await fs.readFile(file, "utf8");
    const key = Buffer.from(raw.trim(), "base64");
    if (key.length !== 32) throw new Error(`密钥长度不对：${key.length}`);
    return { key, created: false, recoveryCode: encodeRecoveryCode(key) };
  } catch {
    const { key, recoveryCode } = generateKey();
    await saveKey(dataDir, key);
    return { key, created: true, recoveryCode };
  }
}
/**
 * 写入密钥文件。幂等：内容相同不重写，避免每次跑备份都动一次 mtime。
 */
export async function saveKey(dataDir, key) {
  const file = keyPath(dataDir);
  await fs.mkdir(dataDir, { recursive: true });
  const body = key.toString("base64");
  try {
    if ((await fs.readFile(file, "utf8")).trim() === body) return file;
  } catch {
    // 不存在，继续写
  }
  // tmp 文件名带上随机后缀：pid 只是「当前进程」，同一进程内的并发调用
  // （打包与状态快照各跑一次）仍会撞车。详见上面的 inflight 注释。
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  await fs.writeFile(tmp, body, { encoding: "utf8", mode: 0o600 });
  await fs.rename(tmp, file);
  // rename 不继承 mode（Windows 上尤其），写后显式收紧一次
  try {
    await fs.chmod(file, 0o600);
  } catch {
    // Windows 上 chmod 可能是空操作，忽略
  }
  return file;
}

/** 是否已有密钥文件。只读，不生成。 */
export async function hasKey(dataDir) {
  try {
    await fs.access(keyPath(dataDir));
    return true;
  } catch {
    return false;
  }
}

/** 用恢复码替换现有密钥（会把旧归档一起锁住，调用方须先确认）。 */
export async function restoreFromCode(dataDir, code) {
  const key = decodeRecoveryCode(code);
  await saveKey(dataDir, key);
  return key;
}

export { encodeRecoveryCode, decodeRecoveryCode, maskRecoveryCode };
export default { keyPath, loadOrCreateKey, saveKey, hasKey, restoreFromCode, KEY_FILENAME };
