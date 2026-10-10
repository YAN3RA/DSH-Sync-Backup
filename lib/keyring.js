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
import { randomBytes, createHash } from "node:crypto";
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

/**
 * 密钥文件相关错误。**独立类型**：调用方必须能把它与「没有密钥」区分开 ——
 * 前者要停下来告知用户，后者才轮到生成新密钥。
 */
export class KeyError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = "KeyError";
    this.code = opts.code ?? "EKEY";
    if (opts.cause !== undefined) this.cause = opts.cause;
  }
}

/**
 * 严格解析密钥 Base64。**不只看解码后的长度**。
 *
 * 为什么必须严格：`Buffer.from(x, "base64")` 是**宽容解码** —— 它会忽略非法字符、
 * 容忍缺失 padding，于是「文件被人手改了一半」「多写了一个换行」都可能恰好解出
 * 32 字节。那种情况下长度检查通过、密钥却是错的，等到解密才炸，而那时旧密钥
 * 可能已经被覆盖掉了。这里用「字符集 + padding + 往返一致」三重校验把它挡在门口。
 *
 * @param {string} raw 文件原文
 * @returns {Buffer} 32 字节密钥
 * @throws {KeyError} 任何非规范形态
 */
export function decodeKeyStrict(raw) {
  const text = String(raw).trim();
  if (text === "") throw new KeyError("密钥文件为空", { code: "EKEYEMPTY" });
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) {
    throw new KeyError("密钥文件含非 Base64 字符（可能被手工编辑或写入中断）", { code: "EKEYCHARSET" });
  }
  if (text.length % 4 !== 0) {
    throw new KeyError(`密钥 Base64 长度不是 4 的倍数（${text.length}）`, { code: "EKEYPAD" });
  }
  const key = Buffer.from(text, "base64");
  if (key.length !== 32) {
    throw new KeyError(`密钥长度不对：${key.length} 字节（应为 32）`, { code: "EKEYLEN" });
  }
  // 往返校验：同一组 32 字节只有一种规范 Base64 写法。不一致说明原文有非规范修饰。
  if (key.toString("base64") !== text) {
    throw new KeyError("密钥 Base64 不是规范编码（往返不一致）", { code: "EKEYNONCANON" });
  }
  return key;
}

/** 密钥指纹：SHA256 前 8 字节 hex。给「恢复码导入」时让用户核对，**不泄露密钥本身**。 */
export function keyFingerprint(key) {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

/**
 * 读取已有密钥，不存在则生成一个新的并写入。
 *
 * **只有明确的 ENOENT 才生成新密钥。** 文件存在但损坏、权限不足、IO 失败时
 * 一律抛 `KeyError` 并**保留原文件** —— 因为那些情况下一旦覆盖，旧归档就永久
 * 解不开了，而用户往往还以为是「第一次运行」。这一条是本模块最重要的不变量。
 */
async function loadOrCreateKeyOnce(dataDir) {
  const file = keyPath(dataDir);

  let raw;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") {
      // 唯一允许创建新密钥的分支：文件确实不存在
      const { key, recoveryCode } = generateKey();
      await saveKey(dataDir, key);
      return { key, created: true, recoveryCode };
    }
    // 权限不足（EACCES/EPERM）、目录不存在（ENOTDIR）、IO 错误……
    // 都不能当作「首次运行」，否则会用一把新密钥覆盖掉用户唯一的那把。
    throw new KeyError(
      `无法读取密钥文件（${err?.code ?? "未知错误"}）：${file}\n` +
        "已保留原文件、未生成新密钥。请检查文件权限后在界面重试；" +
        "若确认文件已丢失，可用恢复码恢复，或手动删除该文件后重新生成。",
      { code: err?.code ?? "EKEYIO", cause: err },
    );
  }

  let key;
  try {
    key = decodeKeyStrict(raw);
  } catch (err) {
    throw new KeyError(
      `密钥文件已存在但无法解析：${file}\n原因：${err?.message ?? err}\n` +
        "已保留原文件、未生成新密钥。请先用恢复码恢复，或备份该文件后手动删除以重新生成" +
        "（注意：重新生成后旧归档将无法解开）。",
      { code: err?.code ?? "EKEYINVALID", cause: err },
    );
  }
  return { key, created: false, recoveryCode: encodeRecoveryCode(key) };
}

/**
 * 只读密钥状态。**绝不创建、绝不写入、绝不改 mtime。**
 *
 * 状态页必须用这个而不是 `loadOrCreateKey` —— 后者在密钥缺失时会顺手生成一把，
 * 于是「打开设置页看一眼」就产生了写副作用。
 *
 * @returns {Promise<{status:"ok"|"missing"|"invalid"|"unreadable", detail?:string, fingerprint?:string}>}
 */
export async function keyStatus(dataDir) {
  const file = keyPath(dataDir);
  let raw;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return { status: "missing" };
    return { status: "unreadable", detail: String(err?.code ?? err?.message ?? err) };
  }
  try {
    const key = decodeKeyStrict(raw);
    return { status: "ok", fingerprint: keyFingerprint(key) };
  } catch (err) {
    return { status: "invalid", detail: String(err?.message ?? err) };
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

/** 是否已有密钥文件。只读，不生成。需要「存在但是否可用」请用 {@link keyStatus}。 */
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
export default { keyPath, loadOrCreateKey, saveKey, hasKey, keyStatus, keyFingerprint, restoreFromCode, KeyError, KEY_FILENAME };
