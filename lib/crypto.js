/**
 * 归档加密（v3）。零第三方依赖，只用 node:crypto。
 *
 * ## 为什么加密是「永远开」而不是选项
 *
 * 归档里装的是人格指令、长期记忆、会话记录 —— 这些东西一旦落到磁盘，
 * **任何能读该文件的进程都能读**。把它做成选项，等于让大多数人在不知情的
 * 情况下留一份明文履历在硬盘上。所以本插件不给「是否加密」这个开关：
 * 只要落盘，就一定加密。
 *
 * ## 恢复码就是密钥本身
 *
 * 没有做「密钥 → 恢复码」的二次派生。**恢复码 = base32 编码后的密钥原值**。
 * 理由是诚实：如果两者是不同的东西，用户会以为丢了一个还有一个，
 * 而实际上只要主密钥文件损坏，任何派生出来的「备份码」都无法单独解开归档。
 * 反过来也一样 —— 拿到恢复码就等于拿到全部数据，所以它必须被当作口令保管。
 *
 * ## 为什么用 AES-256-GCM 而不是自己拼
 *
 * GCM 同时给机密性 + 完整性：归档被改动过一个字节，解密就会抛错而不是
 * 给出乱码。这对备份是核心性质 —— 静默解出坏数据比解不开更糟。
 *
 * ## 恒定时间比较
 *
 * `timingSafeEqual` 在长度不等时会**抛异常**而不是返回 false，
 * 所以比较两个值时必须先比长度（长度本身不是秘密）再逐字节比。
 */

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

/** 归档文件 magic。用于「这是不是本插件的加密产物」的快速判定。 */
export const MAGIC = Buffer.from("DSHSB1", "ascii");

/** 密钥槽位名。放在 DSH 凭据槽位里，与其它凭据同一套保护。 */
export const KEY_REF = "DSH_SYNC_BACKUP_ENCRYPTION_KEY";

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** base32 字母表：去掉了 0/1/8/9，避免抄写时与 O/I/B/S 混淆。 */
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/**
 * 生成一个新密钥。
 * @returns {{key: Buffer, recoveryCode: string}}
 */
export function generateKey() {
  const key = randomBytes(KEY_BYTES);
  return { key, recoveryCode: encodeRecoveryCode(key) };
}

/**
 * 把 32 字节密钥编码成人类可抄写的恢复码。
 * 每 4 字符一组用 `-` 分隔 —— 纯视觉分组，解析时全部忽略。
 */
export function encodeRecoveryCode(key) {
  if (!(key instanceof Buffer) || key.length !== KEY_BYTES) {
    throw new Error(`恢复码只能由 ${KEY_BYTES} 字节密钥编码（收到 ${key?.length}）`);
  }
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of key) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  // 32 字节 = 256 bits → 52 个字符（末位补零）
  return out.match(/.{1,4}/g).join("-");
}

/**
 * 解析恢复码回密钥。
 * 容忍：大小写、空格、连字符缺失。不容忍：长度不对或有非法字符。
 */
export function decodeRecoveryCode(code) {
  if (typeof code !== "string") throw new Error("恢复码必须是字符串");
  const cleaned = code.replace(/[\s-]/g, "").toUpperCase();
  const expected = Math.ceil((KEY_BYTES * 8) / 5);
  if (cleaned.length !== expected) {
    throw new Error(`恢复码长度不对：应为 ${expected} 个字符（收到 ${cleaned.length}）`);
  }
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const ch of cleaned) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error(`恢复码含非法字符：${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  const buf = Buffer.from(bytes.slice(0, KEY_BYTES));
  if (buf.length !== KEY_BYTES) throw new Error("恢复码解码结果长度不足");
  // 往返自检：编码回去必须与清洗后的输入一致，否则说明抄错但恰好落在合法字符集里。
  if (encodeRecoveryCode(buf).replace(/-/g, "") !== cleaned) {
    throw new Error("恢复码校验失败（可能有字符抄错）");
  }
  return buf;
}

/** 显示用：只留前 6 字符，剩下的打点。绝不整串回显。 */
export function maskRecoveryCode(code) {
  if (typeof code !== "string" || code.length === 0) return "(未设置)";
  return `${code.slice(0, 6)}${"•".repeat(Math.max(0, Math.min(24, code.length - 6)))}`;
}

/**
 * 密钥是否变化了。用于「切换密钥会锁死旧归档」的确认。
 * 恒定时间比较，避免通过耗时侧信道逐字节猜。
 */
export function sameKey(a, b) {
  if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b)) return false;
  if (a.length !== b.length) return false; // 长度不是秘密，可安全短路
  return timingSafeEqual(a, b);
}

/**
 * 加密一段字节。
 * 输出布局：`MAGIC | iv(12) | tag(16) | ciphertext`
 * —— 长度全部固定，方便在不解密的前提下读出 IV 与 tag。
 */
export function encryptBytes(key, plain) {
  if (!(key instanceof Buffer) || key.length !== KEY_BYTES) {
    throw new Error(`密钥必须是 ${KEY_BYTES} 字节`);
  }
  if (!(plain instanceof Buffer)) throw new Error("待加密内容必须是 Buffer");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = cipher.update(plain);
  const tail = cipher.final();
  const tag = cipher.getAuthTag();
  return Buffer.concat([
    MAGIC,
    iv,
    tag,
    Buffer.concat([body, tail]),
  ]);
}

/**
 * 解密。任一字节被改都会抛 —— GCM 的 tag 校验会先失败。
 * @returns {Buffer}
 */
export function decryptBytes(key, packed) {
  if (!(packed instanceof Buffer)) throw new Error("待解密内容必须是 Buffer");
  if (packed.length < MAGIC.length + IV_BYTES + TAG_BYTES + 1) {
    throw new Error("文件太短，不可能是本插件的加密归档");
  }
  if (!packed.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error("不是本插件的加密归档（magic 不匹配）—— 可能是未加密的旧产物");
  }
  const off = MAGIC.length;
  const iv = packed.subarray(off, off + IV_BYTES);
  const tag = packed.subarray(off + IV_BYTES, off + IV_BYTES + TAG_BYTES);
  const body = packed.subarray(off + IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const head = decipher.update(body);
  const tail = decipher.final();
  return Buffer.concat([head, tail]);
}

/** 不解密地判断一个 buffer 是否为本插件的加密产物。 */
export function isEncrypted(packed) {
  return packed instanceof Buffer
    && packed.length >= MAGIC.length
    && packed.subarray(0, MAGIC.length).equals(MAGIC);
}
