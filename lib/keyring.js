/**
 * 加密密钥管理（v4 / 信封加密）。零第三方依赖。
 *
 * ## 为什么从「明文存密钥」改成信封加密
 *
 * v3 把 32 字节 DEK（数据加密密钥）**以明文 Base64 写在 `key.b64`**。
 * Base64 不是加密 —— 任何读得到这个文件的人都直接拿到了归档的钥匙。
 * v4 改成标准的两层信封：DEK 随机生成、只以**密文**形态落盘，分别由两把
 * 独立的 KEK（密钥加密密钥）包裹：
 *
 * ```text
 * 归档  ──AES-256-GCM(DEK)──▶  密文归档
 * DEK   ──AES-256-GCM(本机KEK)──▶    wrappedLocal     （日常备份自动解包）
 * DEK   ──AES-256-GCM(恢复KEK)──▶    wrappedRecovery  （换机器时用恢复码）
 * ```
 *
 * 两把 KEK 都不落盘：
 * - **本机 KEK** 交给 DSH 宿主凭据 API 保管（`dsh-sync-backup/local-kek`），
 *   插件自己不起子进程、不碰 OS API、不引原生模块；
 * - **恢复 KEK** 由恢复码经 HKDF 派生，恢复码原文**永不落盘**。
 *
 * ## 安全边界（必须诚实说明）
 *
 * 宿主的凭据存储（`@deepseek-ai/dsh-credentials-local`）底层是**明文 YAML**
 * （权限 0600），它本身不加密。所以「本机 KEK 交给宿主」提供的**不是加密增益**，
 * 而是**物理隔离**：KEK 与包裹后的 DEK 不再躺在同一个文件、同一个目录里。
 * 它防的仍然是 v3 那句话说的那一段 —— **归档离开本机之后**。能读你这台机器
 * `.dsh` 目录的人，两处都读得到。这个取舍不能含糊。
 *
 * ## 恢复码不再等于 DEK
 *
 * v3 的恢复码就是 DEK 本身。v4 里恢复码编码的是一把**独立的随机恢复秘密（RS）**，
 * 它只用于派生恢复 KEK。因此：
 * - **恢复码无法事后从磁盘重算** —— RS 不落盘，`wrappedRecovery` 只含密文与 salt。
 *   首次生成 / 迁移 / 更换恢复码时必须**一次性展示 + 显式确认**。
 * - 迁移（v3 → v4）会**更换恢复码**：旧恢复码在迁移后失效。DEK 本身不变，
 *   所以**既有归档不需要重新加密**，仍然解得开。
 *
 * @module dsh-sync-backup/lib/keyring
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import {
  randomBytes,
  createHash,
  createCipheriv,
  createDecipheriv,
  hkdfSync,
} from "node:crypto";
import { encodeRecoveryCode, decodeRecoveryCode, maskRecoveryCode } from "./crypto.js";

export const KEY_FILENAME = "key.b64";
/** 信封格式版本。v1 = 旧的明文 Base64 DEK。 */
export const KEY_VERSION = 2;

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const SALT_BYTES = 16;

/** 本机 KEK 在宿主凭据库里的 record key（`<scope>/<id>`）。 */
export const LOCAL_KEK_SCOPE = "dsh-sync-backup";
export const LOCAL_KEK_ID = "local-kek";
export const LOCAL_KEK_KEY = `${LOCAL_KEK_SCOPE}/${LOCAL_KEK_ID}`;

/**
 * 包裹运算的附加认证数据（AAD）。
 * 把「用途 + 版本」绑进 GCM 的认证范围：即使有人把 wrappedLocal 的密文
 * 整体搬到 wrappedRecovery 上，认证标签也校验不过。
 */
const AAD_LOCAL = Buffer.from("dsh-sync-backup/dek-envelope/v2/local", "utf8");
const AAD_RECOVERY = Buffer.from("dsh-sync-backup/dek-envelope/v2/recovery", "utf8");
/** HKDF 的用途标签，避免同一把 RS 在别处被派生成别的东西。 */
const HKDF_INFO = Buffer.from("dsh-sync-backup/recovery-kek/v2", "utf8");

/* ------------------------------------------------------------------ */
/* KEK 来源                                                            */
/* ------------------------------------------------------------------ */

/**
 * 宿主凭据库支撑的 KEK 存储。
 *
 * 只依赖 `ctx.credentials` 的 record-half（`readRecord` / `modifyRecord`），
 * 这是 DSH 官方的凭据服务；服务缺失时**抛错**而不是静默退化 ——
 * 契约要求本机 KEK 必须是真秘密，不能降级成「没有本机层」。
 *
 * ## 为什么要有「等待服务就绪」（2026-10-11 真机 P0 竞态）
 *
 * 真机实测：插件的**启动补跑**（`startupRunOnBoot`）会在 base bundle 把
 * `@deepseek-ai/dsh-credentials-local` 挂载**之前**就发起第一次备份。此时
 * `ctx.get("credentials")` 返回 undefined，旧实现立刻 fail closed —— 备份直接失败，
 * 状态页显示「宿主凭据服务不可用」，而**密钥与服务其实都是好的**（实测：同一进程内
 * 服务挂载后立刻恢复，`ok:true`）。v3 没暴露这个问题，因为 v3 只读明文
 * `key.b64`、根本不依赖宿主服务。
 *
 * 所以这里把「服务还没挂载」与「宿主真的不支持 record API」区分开：
 *   - 前者是**短暂**的启动竞态 → 有界等待（默认 5 s，指数退避轮询）；
 *   - 后者在等待耗尽后仍然报错（fail closed 不变，只是不再把竞态误判成永久故障）。
 *
 * **为什么是 5 s 而不是 30 s**：实测该服务在启动后约 300 ms 内挂载，5 s 已有十几倍余量；
 * 而等待上限同时是「宿主真的没有这个服务时，用户点一下按钮要卡多久」——30 s 的卡顿
 * 会让人以为界面死了，5 s 足够区分两种情况又不会显得没反应。
 * 等待期间服务一旦出现就立刻返回，所以**服务正常时这个上限完全不生效**（零等待）。
 *
 * 等待是**有界**的：超时后照样抛 KeyError，绝不无限挂起或静默降级。
 *
 * @param {object} ctx Cordis 上下文
 * @param {{scope?:string, id?:string, readyTimeoutMs?:number, sleep?:Function}} [opts]
 */
export function hostKekStore(ctx, opts = {}) {
  const scope = opts.scope ?? LOCAL_KEK_SCOPE;
  const id = opts.id ?? LOCAL_KEK_ID;
  const bare = `${scope}/${id}`;
  /** 等待服务挂载的上限（毫秒）。0 = 不等待（测试与显式关掉时用）。 */
  const readyTimeoutMs = Number.isFinite(opts.readyTimeoutMs) ? opts.readyTimeoutMs : 5000;
  const sleep = typeof opts.sleep === "function" ? opts.sleep : (ms) => new Promise((r) => setTimeout(r, ms));

  /** 取服务，不做等待；拿不到返回 undefined。 */
  const peek = () => {
    const svc = typeof ctx?.get === "function" ? ctx.get("credentials") : ctx?.credentials;
    if (!svc || typeof svc.readRecord !== "function" || typeof svc.modifyRecord !== "function") return undefined;
    return svc;
  };

  /**
   * 取服务；未挂载时**有界等待**（启动竞态），超时才抛。
   * 每次调用都重新取 —— 服务可能在本插件加载后才挂载。
   */
  const service = async () => {
    let svc = peek();
    if (svc !== undefined) return svc;
    if (readyTimeoutMs > 0) {
      const deadline = Date.now() + readyTimeoutMs;
      let delay = 50;
      while (Date.now() < deadline) {
        await sleep(delay);
        svc = peek();
        if (svc !== undefined) return svc;
        delay = Math.min(1000, delay * 2); // 50 → 100 → 200 → 400 → 800 → 1000…
      }
    }
    throw new KeyError(
      "宿主凭据服务不可用（ctx.credentials.readRecord / modifyRecord 缺失）：" +
        `等待 ${readyTimeoutMs} ms 后仍未挂载。已保留原密钥文件、未生成新密钥。` +
        "请确认 DSH 版本支持凭据 record API，或用恢复码导入。",
      { code: "EKEYSTORE" },
    );
  };

  /** 品牌化 key；包不可解析时退回裸字符串（服务端只做字符串比较）。 */
  const brand = async (raw) => {
    try {
      const mod = await import("@deepseek-ai/dsh-credentials");
      if (typeof mod.credentialKey === "function") {
        return mod.credentialKey(scope, id);
      }
    } catch {
      /* 包不可解析：用裸 key */
    }
    return raw;
  };

  return {
    source: "host",
    keyName: bare,
    /** @returns {Promise<string|undefined>} Base64 的 KEK；undefined = 未初始化 */
    async read() {
      const svc = await service();
      let rec;
      try {
        rec = await svc.readRecord(await brand(bare));
      } catch (err) {
        // 适配器负责把底层异常翻译成 KeyError：上层要能按 code 区分
        // 「未初始化」与「读不了」，后者必须 fail closed 而不是当成首次生成。
        if (err instanceof KeyError) throw err;
        throw new KeyError(
          `读取宿主凭据库的 "${bare}" 失败（${err?.code ?? err?.message ?? err}）：` +
            "已保留原密钥文件、未生成新密钥。",
          { code: "EKEYSTOREREAD", cause: err },
        );
      }
      // 宿主明确回答「这个 key 不存在」→ 未初始化（对齐 key.b64 的 ENOENT 语义）
      if (rec === undefined || rec === null) return undefined;
      if (rec.kind !== "api-key" || typeof rec.key !== "string" || rec.key === "") {
        throw new KeyError(
          `宿主凭据库里 "${bare}" 的记录形态不对（kind=${rec.kind ?? "?"}）：拒绝当作 KEK 使用。` +
            "已保留原密钥文件、未生成新密钥。",
          { code: "EKEYSTORESHAPE" },
        );
      }
      return rec.key;
    },
    /** @param {string} b64 Base64 的 KEK */
    async write(b64) {
      const svc = await service();
      const key = await brand(bare);
      try {
        await svc.modifyRecord(key, (current) => {
          // 已存在就不覆盖：KEK 被换掉会让旧的 wrappedLocal 再也解不开。
          if (current !== undefined && current !== null) return undefined;
          return { kind: "api-key", key: b64 };
        });
      } catch (err) {
        if (err instanceof KeyError) throw err;
        throw new KeyError(
          `写入宿主凭据库的 "${bare}" 失败（${err?.code ?? err?.message ?? err}）：` +
            "本机 KEK 未能落盘，本次不做任何密钥变更。",
          { code: "EKEYSTOREWRITE", cause: err },
        );
      }
    },
  };
}

/**
 * 文件支撑的 KEK 存储 —— **仅用于测试与无宿主环境**。
 *
 * 之所以保留它：信封加密的核心性质（往返、fail closed、迁移不丢密钥）必须能
 * 在零依赖的离线单测里验证，而那些测试没有 Cordis 宿主。生产路径一律走
 * {@link hostKekStore}。文件务必放在**包裹数据之外的目录**，否则等于没做隔离。
 */
export function fileKekStore(file) {
  return {
    source: "file",
    keyName: file,
    async read() {
      try {
        const raw = (await fs.readFile(file, "utf8")).trim();
        return raw === "" ? undefined : raw;
      } catch (err) {
        if (err?.code === "ENOENT") return undefined;
        throw new KeyError(`无法读取本机 KEK 文件（${err?.code ?? "未知"}）：${file}`, {
          code: "EKEYSTOREREAD",
          cause: err,
        });
      }
    },
    async write(b64) {
      try {
        await fs.mkdir(path.dirname(file), { recursive: true });
        const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
        await fs.writeFile(tmp, b64, { encoding: "utf8", mode: 0o600 });
        await fs.rename(tmp, file);
        try {
          await fs.chmod(file, 0o600);
        } catch {
          /* Windows 上可能是空操作 */
        }
      } catch (err) {
        if (err instanceof KeyError) throw err;
        throw new KeyError(
          `写入本机 KEK 文件失败（${err?.code ?? err?.message ?? err}）：${file}`,
          { code: "EKEYSTOREWRITE", cause: err },
        );
      }
    },
  };
}

/* ------------------------------------------------------------------ */
/* 信封原语                                                            */
/* ------------------------------------------------------------------ */

/** 校验一把 KEK：必须正好 32 字节的规范 Base64。 */
function decodeKek(b64, where) {
  if (typeof b64 !== "string" || b64.trim() === "") {
    throw new KeyError(`${where} 为空`, { code: "EKEYKEKEMPTY" });
  }
  const text = b64.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text) || text.length % 4 !== 0) {
    throw new KeyError(`${where} 不是规范 Base64`, { code: "EKEYKEKCHARSET" });
  }
  const buf = Buffer.from(text, "base64");
  if (buf.length !== KEY_BYTES) {
    throw new KeyError(`${where} 长度不对：${buf.length} 字节（应为 ${KEY_BYTES}）`, {
      code: "EKEYKEKLEN",
    });
  }
  if (buf.toString("base64") !== text) {
    throw new KeyError(`${where} 不是规范 Base64（往返不一致）`, { code: "EKEYKEKNONCANON" });
  }
  return buf;
}

/** AES-256-GCM 包裹一段 32 字节密钥。 */
function wrapKey(kek, dek, aad) {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", kek, nonce);
  cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(dek), cipher.final()]);
  return {
    alg: "aes-256-gcm",
    nonce: nonce.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ct: ct.toString("base64"),
  };
}

/** 解包一把包裹的密钥。任一字节被改、AAD 不匹配都会抛。 */
function unwrapKey(kek, wrapped, aad, where) {
  if (!wrapped || typeof wrapped !== "object") {
    throw new KeyError(`${where} 缺失或形态不对`, { code: "EKEYENVELOPE" });
  }
  if (wrapped.alg !== "aes-256-gcm") {
    throw new KeyError(`${where} 的算法未知：${wrapped.alg}`, { code: "EKEYENVELOPEALG" });
  }
  const nonce = Buffer.from(String(wrapped.nonce ?? ""), "base64");
  const tag = Buffer.from(String(wrapped.tag ?? ""), "base64");
  const ct = Buffer.from(String(wrapped.ct ?? ""), "base64");
  if (nonce.length !== NONCE_BYTES || tag.length !== TAG_BYTES || ct.length !== KEY_BYTES) {
    throw new KeyError(
      `${where} 的长度不对（nonce ${nonce.length} / tag ${tag.length} / ct ${ct.length}）`,
      { code: "EKEYENVELOPELEN" },
    );
  }
  let dek;
  try {
    const d = createDecipheriv("aes-256-gcm", kek, nonce);
    d.setAAD(aad);
    d.setAuthTag(tag);
    dek = Buffer.concat([d.update(ct), d.final()]);
  } catch (err) {
    // 认证标签失败 = 密文被改，或 KEK 不对。**绝不**在这里生成新密钥。
    throw new KeyError(
      `${where} 解密失败（认证标签不匹配）：密文可能被篡改，或本机 KEK / 恢复码不对。` +
        "已保留原密钥文件、未生成新密钥。",
      { code: "EKEYAUTH", cause: err },
    );
  }
  if (dek.length !== KEY_BYTES) {
    throw new KeyError(`${where} 解出长度不对：${dek.length}`, { code: "EKEYENVELOPELEN" });
  }
  return dek;
}

/** 恢复码 → 恢复 KEK。恢复码本身已是 256 位高熵秘密，用 HKDF 而非慢速 KDF。 */
function deriveRecoveryKek(recoverySecret, salt) {
  const out = hkdfSync("sha256", recoverySecret, salt, HKDF_INFO, KEY_BYTES);
  return Buffer.from(out);
}

/* ------------------------------------------------------------------ */
/* 信封的构建与读写                                                    */
/* ------------------------------------------------------------------ */

/** 用 DEK 与（已就绪的）本机 KEK 造一份完整信封，并生成新的恢复码。 */
function buildEnvelope(dek, localKek) {
  const recoverySecret = randomBytes(KEY_BYTES);
  const salt = randomBytes(SALT_BYTES);
  const recoveryKek = deriveRecoveryKek(recoverySecret, salt);
  const envelope = {
    v: KEY_VERSION,
    kdf: "hkdf-sha256",
    wrappedLocal: wrapKey(localKek, dek, AAD_LOCAL),
    wrappedRecovery: {
      ...wrapKey(recoveryKek, dek, AAD_RECOVERY),
      salt: salt.toString("base64"),
    },
  };
  return { envelope, recoveryCode: encodeRecoveryCode(recoverySecret) };
}

/** 从信封的 wrappedRecovery 用恢复码解出 DEK。 */
export function unwrapWithRecoveryCode(envelope, code) {
  const recoverySecret = decodeRecoveryCode(code);
  const salt = Buffer.from(String(envelope?.wrappedRecovery?.salt ?? ""), "base64");
  if (salt.length !== SALT_BYTES) {
    throw new KeyError(`信封的 salt 长度不对：${salt.length}`, { code: "EKEYENVELOPE" });
  }
  const kek = deriveRecoveryKek(recoverySecret, salt);
  return unwrapKey(kek, envelope.wrappedRecovery, AAD_RECOVERY, "wrappedRecovery");
}

/**
 * 从信封里摘出可上行的恢复元数据。
 *
 * 契约「恢复元数据可迁移」：换机器 / 重装后光有归档和恢复码还不够 ——
 * 还需要 `wrappedRecovery` 这份密文才能把恢复码接回 DEK。所以它必须随归档与
 * manifest 一起放到可恢复位置。
 *
 * 可安全上行：只含密文、nonce、tag 与 salt。**不含**恢复码、明文 DEK、本机 KEK，
 * 也不含 `wrappedLocal`（那是本机专用包裹，换机器时反而应该丢弃重建）。
 *
 * @returns {object|null} 无信封或形态不对时返回 null（调用方自行决定是否报警）
 */
export function recoveryEnvelopeForUpload(envelope) {
  if (!envelope || typeof envelope !== "object") return null;
  const w = envelope.wrappedRecovery;
  if (!w || typeof w !== "object") return null;
  return {
    v: envelope.v,
    kdf: envelope.kdf,
    wrappedRecovery: {
      alg: w.alg,
      nonce: w.nonce,
      tag: w.tag,
      ct: w.ct,
      salt: w.salt,
    },
  };
}

/**
 * 从上行回来的恢复元数据 + 恢复码解出 DEK（**灾难恢复路径**）。
 *
 * 与 {@link unwrapWithRecoveryCode} 的区别只是入口形态：这里吃的是远端 manifest
 * 里那份 `recoveryEnvelope`，而不是本机的完整信封。
 *
 * @param {object} recoveryMeta 远端 manifest 里的 recoveryEnvelope
 * @param {string} code 用户保管的恢复码
 * @returns {Buffer} 32 字节 DEK
 */
export function unwrapFromRecoveryMeta(recoveryMeta, code) {
  if (!recoveryMeta || typeof recoveryMeta !== "object") {
    throw new KeyError("远端没有恢复元数据（recoveryEnvelope）：无法只凭恢复码恢复", {
      code: "EKEYNOMETA",
    });
  }
  return unwrapWithRecoveryCode(
    { v: recoveryMeta.v, wrappedRecovery: recoveryMeta.wrappedRecovery },
    code,
  );
}

/** 解析信封 JSON 文本（不做解密）。形态不对一律抛，不试图修正。 */
export function parseEnvelope(raw) {
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (err) {
    throw new KeyError(`信封不是合法 JSON：${err?.message ?? err}`, {
      code: "EKEYENVELOPEJSON",
      cause: err,
    });
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    throw new KeyError("信封不是对象", { code: "EKEYENVELOPE" });
  }
  if (obj.v !== KEY_VERSION) {
    // 未知版本必须 fail closed：将来若升到 v3，旧插件读不懂也**不能**猜着解。
    throw new KeyError(
      `信封版本未知：${JSON.stringify(obj.v)}（本版只认 ${KEY_VERSION}）`,
      { code: obj.v === undefined ? "EKEYENVELOPE" : "EKEYENVELOPEVERSION" },
    );
  }
  return obj;
}

/** 原子写信封文件：唯一 tmp（带随机后缀）+ 权限收紧 + rename。 */
async function writeEnvelopeFile(dataDir, envelope) {
  const file = keyPath(dataDir);
  await fs.mkdir(dataDir, { recursive: true });
  const body = JSON.stringify(envelope);
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  await fs.writeFile(tmp, body, { encoding: "utf8", mode: 0o600 });
  await fs.rename(tmp, file);
  try {
    await fs.chmod(file, 0o600);
  } catch {
    /* Windows 上可能是空操作 */
  }
  return file;
}

/* ------------------------------------------------------------------ */
/* 对外 API                                                            */
/* ------------------------------------------------------------------ */

/** key 文件绝对路径。 */
export function keyPath(dataDir) {
  return path.join(dataDir, KEY_FILENAME);
}

/** 同一个 dataDir 上的「正在取 key」的承诺（去重，避免并发撞 tmp 名）。 */
const inflight = new Map();

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
 * 严格解析 v3 的明文 Base64 密钥。**不只看解码后的长度**。
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

/** 文本看着像不像 v4 信封（以 `{` 开头）。 */
function looksLikeEnvelope(text) {
  return String(text).trim().startsWith("{");
}

/**
 * 取本机 KEK；不存在则生成一把并写入存储。
 *
 * 只有**存储明确回答「不存在」**才生成新 KEK（对齐 `key.b64` 的 ENOENT 语义）。
 * 读取报错、形态不对、权限不足一律抛 —— 否则会用一把新 KEK 覆盖掉唯一能解
 * 旧 `wrappedLocal` 的那把。
 */
async function ensureLocalKek(store) {
  let existing;
  try {
    existing = await store.read();
  } catch (err) {
    // 自定义 store 可能抛裸 Error；统一成 KeyError，让上层按 code 分流
    // （「未初始化」才生成，其它一律 fail closed）。
    if (err instanceof KeyError) throw err;
    throw new KeyError(`读取本机 KEK 失败（${err?.code ?? err?.message ?? err}）`, {
      code: "EKEYSTOREREAD",
      cause: err,
    });
  }
  if (existing !== undefined) {
    decodeKek(existing, "本机 KEK"); // 形态校验，坏了就报错而不是覆盖
    return existing;
  }
  const fresh = randomBytes(KEY_BYTES).toString("base64");
  await store.write(fresh);
  // 写完回读一次：写入未被接受（比如并发创建）时以磁盘现状为准。
  const back = await store.read();
  if (back === undefined) {
    throw new KeyError("本机 KEK 写入后仍读不到", { code: "EKEYSTOREWRITE" });
  }
  decodeKek(back, "本机 KEK");
  return back;
}

/**
 * 读取已有密钥，不存在则生成一个新的并写入。
 *
 * **只有明确的 ENOENT 才生成新密钥。** 文件存在但损坏、权限不足、IO 失败时
 * 一律抛 `KeyError` 并**保留原文件** —— 因为那些情况下一旦覆盖，旧归档就永久
 * 解不开了，而用户往往还以为是「第一次运行」。这一条是本模块最重要的不变量。
 *
 * @param {string} dataDir 插件数据目录
 * @param {{kek: {read:Function, write:Function, source?:string}}} opts 本机 KEK 存储（必填）
 * @returns {Promise<{key:Buffer, created:boolean, recoveryCode:string,
 *   recoveryChanged:boolean, migrated:boolean, kekSource:string}>}
 */
export function loadOrCreateKey(dataDir, opts = {}) {
  const pending = inflight.get(dataDir);
  if (pending) return pending;
  const task = loadOrCreateKeyOnce(dataDir, opts);
  inflight.set(dataDir, task);
  // 无论成功失败都要摘掉缓存项，否则一次失败会被永久记住。
  // `.finally()` 会返回一个**新** promise；上面 set 进去的是 `task` 本身，
  // 所以删除动作必须挂在 `task` 上，而不是把 finally 的结果写回 Map。
  void task.catch(() => {}).then(() => { if (inflight.get(dataDir) === task) inflight.delete(dataDir); });
  return task;
}

/** 校验 opts.kek 可用，否则 fail closed（绝不退化成「无本机层」）。 */
function requireKekStore(opts) {
  const store = opts?.kek;
  if (!store || typeof store.read !== "function" || typeof store.write !== "function") {
    throw new KeyError(
      "缺少本机 KEK 存储（opts.kek）：信封加密要求本机 KEK 必须是真秘密，" +
        "不接受「没有本机层」的降级形态。生产路径请传 hostKekStore(ctx)。",
      { code: "EKEYNOSTORE" },
    );
  }
  return store;
}

async function loadOrCreateKeyOnce(dataDir, opts) {
  const file = keyPath(dataDir);

  let raw;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") {
      // 唯一允许创建新密钥的分支：文件确实不存在
      const store = requireKekStore(opts);
      const kekB64 = await ensureLocalKek(store);
      const dek = randomBytes(KEY_BYTES);
      const { envelope, recoveryCode } = buildEnvelope(dek, decodeKek(kekB64, "本机 KEK"));
      await writeEnvelopeFile(dataDir, envelope);
      return {
        key: dek,
        created: true,
        recoveryCode,          // 首次生成：这里必须展示给用户并让他确认保管
        recoveryChanged: true,
        migrated: false,
        recoveryEnvelope: recoveryEnvelopeForUpload(envelope),
        kekSource: store.source ?? "unknown",
      };
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

  /* ---- v3 明文密钥：迁移到信封（DEK 不变，所以既有归档不用重新加密）---- */
  if (!looksLikeEnvelope(raw)) {
    let dek;
    try {
      dek = decodeKeyStrict(raw);
    } catch (err) {
      throw new KeyError(
        `密钥文件已存在但无法解析：${file}\n原因：${err?.message ?? err}\n` +
          "已保留原文件、未生成新密钥。请先用恢复码恢复，或备份该文件后手动删除以重新生成" +
          "（注意：重新生成后旧归档将无法解开）。",
        { code: err?.code ?? "EKEYINVALID", cause: err },
      );
    }
    // 迁移的每一步都可能在写盘前失败（取 KEK、生成随机数、序列化）——
    // 那些情况下旧文件仍是原样，这是「任一步失败都不能覆盖唯一可用旧密钥」的落点。
    const store = requireKekStore(opts);
    const kekB64 = await ensureLocalKek(store);
    const { envelope, recoveryCode } = buildEnvelope(dek, decodeKek(kekB64, "本机 KEK"));
    await writeEnvelopeFile(dataDir, envelope);
    return {
      key: dek,
      created: false,
      recoveryCode,          // 迁移会**更换**恢复码：旧恢复码此后失效，必须重新展示
      recoveryChanged: true,
      migrated: true,
      recoveryEnvelope: recoveryEnvelopeForUpload(envelope),
      kekSource: store.source ?? "unknown",
    };
  }

  /* ---- v4 信封 ---- */
  let envelope;
  try {
    envelope = parseEnvelope(raw);
  } catch (err) {
    throw new KeyError(
      `密钥信封已存在但无法解析：${file}\n原因：${err?.message ?? err}\n` +
        "已保留原文件、未生成新密钥。",
      { code: err?.code ?? "EKEYENVELOPE", cause: err },
    );
  }
  const store = requireKekStore(opts);
  let kekB64;
  try {
    kekB64 = await store.read();
  } catch (err) {
    if (err instanceof KeyError) throw err;
    throw new KeyError(
      `读取本机 KEK 失败（${err?.code ?? err?.message ?? err}）：已保留原密钥文件、未生成新密钥。`,
      { code: "EKEYSTOREREAD", cause: err },
    );
  }
  if (kekB64 === undefined) {
    // 信封在、KEK 没了 —— 本机再也解不开 wrappedLocal。fail closed，
    // 绝不生成新 KEK（那会假装一切正常，而归档其实解不开了）。
    throw new KeyError(
      "本机 KEK 不存在，但密钥信封存在：本机的归档密钥已无法解开。\n" +
        "已保留原密钥文件、未生成新密钥。请用恢复码导入以重建本机包裹。",
      { code: "EKEYKEKMISSING" },
    );
  }
  const dek = unwrapKey(decodeKek(kekB64, "本机 KEK"), envelope.wrappedLocal, AAD_LOCAL, "wrappedLocal");
  return {
    key: dek,
    created: false,
    recoveryCode: "",        // 恢复码不落盘 → 事后拿不到，只在生成/迁移时展示过一次
    recoveryChanged: false,
    migrated: false,
    // 契约「恢复元数据可迁移」：把它随 manifest 一起上行，换机器才能只凭恢复码回来。
    recoveryEnvelope: recoveryEnvelopeForUpload(envelope),
    kekSource: store.source ?? "unknown",
  };
}

/**
 * 只读密钥状态。**绝不创建、绝不写入、绝不改 mtime。**
 *
 * 状态页必须用这个而不是 `loadOrCreateKey` —— 后者在密钥缺失时会顺手生成一把，
 * 于是「打开设置页看一眼」就产生了写副作用。
 *
 * @returns {Promise<{status:"ok"|"missing"|"invalid"|"unreadable"|"locked",
 *   detail?:string, fingerprint?:string, version?:number, kekSource?:string}>}
 */
export async function keyStatus(dataDir, opts = {}) {
  const file = keyPath(dataDir);
  let raw;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return { status: "missing" };
    return { status: "unreadable", detail: String(err?.code ?? err?.message ?? err) };
  }

  // v3 明文密钥：能严格解出就算 ok（下次备份会自动迁移到 v4）
  if (!looksLikeEnvelope(raw)) {
    try {
      const key = decodeKeyStrict(raw);
      return { status: "ok", fingerprint: keyFingerprint(key), version: 1 };
    } catch (err) {
      return { status: "invalid", detail: String(err?.message ?? err) };
    }
  }

  let envelope;
  try {
    envelope = parseEnvelope(raw);
  } catch (err) {
    return { status: "invalid", detail: String(err?.message ?? err) };
  }

  const store = opts?.kek;
  if (!store || typeof store.read !== "function") {
    // 没有 KEK 来源就没法验证信封能否解开；这**不是** invalid（文件是好的），
    // 而是 locked —— 面板要能区分「坏了」和「暂时解不开」。
    return { status: "locked", version: KEY_VERSION, detail: "未提供本机 KEK 存储" };
  }
  let kekB64;
  try {
    kekB64 = await store.read();
  } catch (err) {
    return { status: "locked", version: KEY_VERSION, detail: String(err?.code ?? err?.message ?? err) };
  }
  if (kekB64 === undefined) {
    return { status: "locked", version: KEY_VERSION, detail: "本机 KEK 不存在" };
  }
  try {
    const dek = unwrapKey(decodeKek(kekB64, "本机 KEK"), envelope.wrappedLocal, AAD_LOCAL, "wrappedLocal");
    return {
      status: "ok",
      fingerprint: keyFingerprint(dek),
      version: KEY_VERSION,
      kekSource: store.source ?? "unknown",
    };
  } catch (err) {
    return { status: "locked", version: KEY_VERSION, detail: String(err?.message ?? err) };
  }
}

/**
 * 写入密钥文件（用给定 DEK 重建信封）。
 *
 * 语义在 v4 里变了：不再是「把 DEK 明文写盘」，而是「为这把 DEK 造一份新信封」。
 * **调用方必须传 opts.kek**，且传入新的 DEK 会更换恢复码。
 */
export async function saveKey(dataDir, key, opts = {}) {
  if (!(key instanceof Buffer) || key.length !== KEY_BYTES) {
    throw new KeyError(`密钥必须是 ${KEY_BYTES} 字节`, { code: "EKEYLEN" });
  }
  const store = requireKekStore(opts);
  const kekB64 = await ensureLocalKek(store);
  const { envelope, recoveryCode } = buildEnvelope(key, decodeKek(kekB64, "本机 KEK"));
  await writeEnvelopeFile(dataDir, envelope);
  return { file: keyPath(dataDir), recoveryCode };
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

/**
 * 用恢复码解出 DEK，并**重建本机包裹**（本机 KEK 不变或新建）。
 *
 * 这是「换机器 / 本机 KEK 丢失」的恢复入口：恢复码解 `wrappedRecovery` 得 DEK，
 * 再用本机 KEK 重新包一份 `wrappedLocal`。注意这会产生**新的恢复码**
 * （恢复秘密重新随机），因为无法从旧密文重算旧恢复码。
 *
 * @returns {Promise<{key:Buffer, recoveryCode:string}>}
 */
export async function restoreFromCode(dataDir, code, opts = {}) {
  const store = requireKekStore(opts);
  const file = keyPath(dataDir);
  let raw;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (err) {
    if (err?.code !== "ENOENT") {
      throw new KeyError(`无法读取密钥文件（${err?.code ?? "未知"}）：${file}`, {
        code: err?.code ?? "EKEYIO",
        cause: err,
      });
    }
    throw new KeyError(
      "本机没有密钥信封，无法用恢复码导入：请先把归档与本插件的信封元数据放到本机数据目录。",
      { code: "EKEYNOENVELOPE" },
    );
  }
  let envelope;
  try {
    envelope = parseEnvelope(raw);
  } catch (err) {
    throw new KeyError(`密钥信封无法解析：${err?.message ?? err}`, { code: "EKEYENVELOPE", cause: err });
  }
  const dek = unwrapWithRecoveryCode(envelope, code); // 错误恢复码 → EKEYAUTH
  const kekB64 = await ensureLocalKek(store);
  const { envelope: next, recoveryCode } = buildEnvelope(dek, decodeKek(kekB64, "本机 KEK"));
  await writeEnvelopeFile(dataDir, next);
  return { key: dek, recoveryCode };
}

export { encodeRecoveryCode, decodeRecoveryCode, maskRecoveryCode };
export default {
  keyPath,
  loadOrCreateKey,
  saveKey,
  hasKey,
  keyStatus,
  keyFingerprint,
  restoreFromCode,
  hostKekStore,
  fileKekStore,
  parseEnvelope,
  unwrapWithRecoveryCode,
  recoveryEnvelopeForUpload,
  unwrapFromRecoveryMeta,
  KeyError,
  KEY_FILENAME,
  KEY_VERSION,
  LOCAL_KEK_KEY,
};
