/**
 * crypto / keyring / user-config 三个模块的离线单测。零第三方依赖、零网络。
 *
 * 这三个模块是 v3「本地落盘 + 自动加密 + 界面改配置」的地基，而它们的失效方式
 * 都很安静 —— 密钥错了不会报错，只会在半年后需要恢复时打不开；配置形状错了不会
 * 报错，只会让人以为改过了其实没改成。所以这里测的都是「错了会静默」的那些性质。
 *
 * 用法：`node tools/crypto-smoke.mjs`
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  MAGIC,
  generateKey,
  encodeRecoveryCode,
  decodeRecoveryCode,
  maskRecoveryCode,
  sameKey,
  encryptBytes,
  decryptBytes,
  isEncrypted,
} from "../lib/crypto.js";
import {
  keyPath,
  loadOrCreateKey,
  saveKey,
  hasKey,
  keyStatus,
  decodeKeyStrict,
  KeyError,
  restoreFromCode,
  fileKekStore,
  hostKekStore,
  parseEnvelope,
  unwrapWithRecoveryCode,
  recoveryEnvelopeForUpload,
  unwrapFromRecoveryMeta,
  KEY_FILENAME,
  KEY_VERSION,
  LOCAL_KEK_KEY,
} from "../lib/keyring.js";
import {
  configPath,
  loadUserConfig,
  saveUserConfig,
  mergeConfig,
  pickEditable,
  sanitizeEditable,
  checkNumberRange,
  NUMBER_BOUNDS,
  GUI_EDITABLE_KEYS,
} from "../lib/user-config.js";

let passed = 0;
let failed = 0;
const failures = [];

function section(title) {
  console.log(`\n${title}`);
}

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    failures.push(name);
    console.log(`  ✗ ${name}  — ${err.message}`);
  }
}

async function tmpDir(prefix) {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/**
 * 给 dataDir 配一把「本机 KEK」（v4 起 keyring 的每个入口都要求它）。
 *
 * 用 fileKekStore 而不是 hostKekStore：单测没有 Cordis 宿主，而信封加密的核心
 * 性质（往返、迁移、fail closed）必须能在零依赖离线环境里验证。KEK 刻意放在
 * dataDir **之外**的兄弟路径 —— 契约要求本机 KEK 不与包裹数据同目录。
 */
function kekFor(dir) {
  return fileKekStore(path.join(path.dirname(dir), `${path.basename(dir)}-localkek`));
}

/** 清理 dataDir 时顺带清掉它旁边的 KEK。 */
async function rmCase(dir) {
  await fs.rm(dir, { recursive: true, force: true });
  await fs.rm(path.join(path.dirname(dir), `${path.basename(dir)}-localkek`), { force: true });
}

/* ============================================================
 * 1. 恢复码编解码
 * ============================================================ */

section("[1] 恢复码：32 字节 ↔ 52 字符");

await check("往返一致（随机密钥）", async () => {
  for (let i = 0; i < 25; i += 1) {
    const { key, recoveryCode } = generateKey();
    assert.equal(key.length, 32);
    const back = decodeRecoveryCode(recoveryCode);
    assert.ok(sameKey(key, back), `第 ${i} 个密钥往返后不一致`);
  }
});

await check("带分组连字符，长度 52 + 12 个 -", async () => {
  const { recoveryCode } = generateKey();
  assert.equal(recoveryCode.replace(/-/g, "").length, 52);
  assert.equal(recoveryCode.split("-").length, 13);
});

await check("容忍大小写、空格、缺连字符", async () => {
  const { key, recoveryCode } = generateKey();
  const ugly = ` ${recoveryCode.replace(/-/g, " ").toLowerCase()} `;
  assert.ok(sameKey(key, decodeRecoveryCode(ugly)));
});

await check("字母表去掉了易混字符 0/1/8/9", async () => {
  // 抄错是最现实的失效模式：把这些字符从字母表里剔除，比事后报错便宜。
  const { recoveryCode } = generateKey();
  assert.ok(!/[0189]/.test(recoveryCode), `恢复码含易混字符：${recoveryCode}`);
});

await check("长度不对 → 明确报错", async () => {
  const { recoveryCode } = generateKey();
  assert.throws(() => decodeRecoveryCode(recoveryCode.slice(0, 40)), /长度不对/);
});

await check("非法字符 → 明确报错", async () => {
  const { recoveryCode } = generateKey();
  const bad = `0${recoveryCode.replace(/-/g, "").slice(1)}`;
  assert.throws(() => decodeRecoveryCode(bad), /非法字符|长度不对|校验失败/);
});

await check("空串 / 非字符串 → 报错而非返回空 buffer", async () => {
  assert.throws(() => decodeRecoveryCode(""), /长度不对/);
  assert.throws(() => decodeRecoveryCode(null), /必须是字符串/);
});

await check("掩码不泄漏：只剩前 6 字符", async () => {
  const { recoveryCode } = generateKey();
  const masked = maskRecoveryCode(recoveryCode);
  assert.ok(masked.startsWith(recoveryCode.slice(0, 6)));
  assert.ok(!masked.includes(recoveryCode.slice(6)), "掩码之后不应还能找到原串尾部");
});

await check("未设置时掩码不崩", async () => {
  assert.equal(maskRecoveryCode(""), "(未设置)");
  assert.equal(maskRecoveryCode(undefined), "(未设置)");
});

/* ============================================================
 * 2. 加解密
 * ============================================================ */

section("[2] AES-256-GCM");

await check("往返一致，且带 magic 头", async () => {
  const { key } = generateKey();
  const plain = Buffer.from("hello backup", "utf8");
  const packed = encryptBytes(key, plain);
  assert.ok(isEncrypted(packed));
  assert.ok(packed.subarray(0, MAGIC.length).equals(MAGIC));
  assert.ok(decryptBytes(key, packed).equals(plain));
});

await check("每次 IV 不同 → 同一明文两次加密结果不同", async () => {
  const { key } = generateKey();
  const plain = Buffer.from("same content", "utf8");
  const a = encryptBytes(key, plain);
  const b = encryptBytes(key, plain);
  assert.ok(!a.equals(b), "IV 复用会让相同明文产生相同密文 —— 那是可观测的泄漏");
});

await check("改一个字节 → 解密抛错（不返回乱码）", async () => {
  const { key } = generateKey();
  const packed = encryptBytes(key, Buffer.from("payload".repeat(20)));
  const tampered = Buffer.from(packed);
  tampered[tampered.length - 1] ^= 0x01;
  assert.throws(() => decryptBytes(key, tampered));
});

await check("用错密钥 → 解密抛错", async () => {
  const { key: k1 } = generateKey();
  const { key: k2 } = generateKey();
  const packed = encryptBytes(k1, Buffer.from("secret"));
  assert.throws(() => decryptBytes(k2, packed));
});

await check("非加密内容有明确报错（提到 magic）", async () => {
  const { key } = generateKey();
  // 长度要够长，否则先撞「文件太短」那条分支，测不到 magic 判定。
  const notOurs = Buffer.alloc(200, 0x20);
  await assert.rejects(async () => decryptBytes(key, notOurs), /magic|不是本插件/);
});

await check("参数不合规直接抛，不静默产出坏数据", async () => {
  const { key } = generateKey();
  assert.throws(() => encryptBytes(Buffer.alloc(16), Buffer.from("x")), /32 字节/);
  assert.throws(() => encryptBytes(key, "string"), /Buffer/);
});

/* ============================================================
 * 3. keyring：DEK 双包裹信封加密（v4）
 * ============================================================ */

section("[3] keyring：信封加密与迁移");

await check("首次调用创建，第二次复用同一个 key", async () => {
  const dir = await tmpDir("dsh-sync-backup-key-");
  const first = await loadOrCreateKey(dir, { kek: kekFor(dir) });
  assert.equal(first.created, true);
  // 让 task settle 后的回收微任务跑过去。`loadOrCreateKey` 在 task 落地后会
  // 摘掉 inflight 缓存项；不排这一格，第二次会命中**同一个 task 对象**并连带
  // 把 `created:true` 一起返回 —— 那不是 bug（同一个结果的多个观察者本就该看到
  // 同一份 created），但它会让本断言失去「第二次真的去读了文件」的意义。
  await new Promise((r) => setTimeout(r, 0));
  const second = await loadOrCreateKey(dir, { kek: kekFor(dir) });
  assert.equal(second.created, false);
  assert.ok(sameKey(first.key, second.key), "两次拿到的不是同一个密钥");
  await rmCase(dir);
});

await check("落盘的是 v2 信封，且**磁盘上不含 DEK 明文**（v3 的核心缺陷）", async () => {
  const dir = await tmpDir("dsh-sync-backup-key-");
  const { key } = await loadOrCreateKey(dir, { kek: kekFor(dir) });
  const raw = await fs.readFile(keyPath(dir), "utf8");
  const env = parseEnvelope(raw);
  assert.equal(env.v, KEY_VERSION);
  assert.ok(env.wrappedLocal && env.wrappedRecovery, "信封必须含两份包裹");
  // 这是整次改造的**目的**：Base64 不是加密，DEK 不得以任何可直接读出的形态落盘。
  assert.ok(!raw.includes(key.toString("base64")), "磁盘上出现了 DEK 的 Base64");
  assert.ok(!raw.includes(key.toString("hex")), "磁盘上出现了 DEK 的 hex");
  // 旧格式（裸 base64 文本）也必须彻底消失：parseEnvelope 会因 JSON 解析失败而抛。
  assert.throws(() => JSON.parse("not json"), SyntaxError);
  await rmCase(dir);
});

await check("并发调用共享一次创建（不撞 tmp 文件名）", async () => {
  const dir = await tmpDir("dsh-sync-backup-key-");
  const kek = kekFor(dir);
  const results = await Promise.all([
    loadOrCreateKey(dir, { kek }),
    loadOrCreateKey(dir, { kek }),
    loadOrCreateKey(dir, { kek }),
    loadOrCreateKey(dir, { kek }),
  ]);
  // 注意别断言 `created` 的次数：四个 caller 共享**同一个** task，
  // 所以它返回的那个结果对象被数了四次。真正要保证的是「四把钥匙是同一把」
  // 以及「磁盘上只有一次写入」—— tmp 文件名撞车会表现为随机 ENOENT。
  for (const r of results) {
    assert.ok(sameKey(r.key, results[0].key), "并发调用拿到了不同的密钥");
  }
  const files = await fs.readdir(dir);
  assert.deepEqual(files, [KEY_FILENAME], `并发后不该留下 tmp 残留：${JSON.stringify(files)}`);
  await rmCase(dir);
});

await check("hasKey 只读，不创建", async () => {
  const dir = await tmpDir("dsh-sync-backup-key-");
  assert.equal(await hasKey(dir), false);
  await loadOrCreateKey(dir, { kek: kekFor(dir) });
  assert.equal(await hasKey(dir), true);
  await rmCase(dir);
});

await check("keyStatus 只读：缺失不创建，损坏不改写", async () => {
  const dir = await tmpDir("dsh-sync-backup-key-");
  assert.deepEqual(await keyStatus(dir, { kek: kekFor(dir) }), { status: "missing" });
  // 关键：查过状态之后，key.b64 仍不该出现 —— 打开设置页不能产生写副作用
  assert.equal(await hasKey(dir), false, "keyStatus 不该创建密钥");

  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, KEY_FILENAME), "broken!!", "utf8");
  const st = await keyStatus(dir, { kek: kekFor(dir) });
  assert.equal(st.status, "invalid");
  assert.equal(await fs.readFile(keyPath(dir), "utf8"), "broken!!", "keyStatus 不该改写文件");
  await rmCase(dir);
});

await check("keyStatus 对可用密钥返回指纹（不泄露密钥本体）", async () => {
  const dir = await tmpDir("dsh-sync-backup-key-");
  const { key } = await loadOrCreateKey(dir, { kek: kekFor(dir) });
  const st = await keyStatus(dir, { kek: kekFor(dir) });
  assert.equal(st.status, "ok");
  assert.equal(st.version, KEY_VERSION);
  assert.match(st.fingerprint, /^[0-9a-f]{16}$/);
  assert.ok(!st.fingerprint.includes(key.toString("base64").slice(0, 8)), "指纹不该是密钥片段");
  await rmCase(dir);
});

await check("decodeKeyStrict 往返一致（规范 base64 不被误杀）", async () => {
  const key = randomBytes(32);
  assert.ok(decodeKeyStrict(key.toString("base64")).equals(key));
  // 结尾换行是编辑器常见的「好心」，trim 之后仍应接受
  assert.ok(decodeKeyStrict(key.toString("base64") + "\n").equals(key));
});

/* ---- 3.1 两条 KEK 路径解出同一把 DEK（方案文档第 6 节 · 通用）-------- */

await check("本机 KEK 与恢复码路径解出同一把 DEK", async () => {
  const dir = await tmpDir("dsh-sync-backup-key-");
  const { key, recoveryCode } = await loadOrCreateKey(dir, { kek: kekFor(dir) });
  const env = parseEnvelope(await fs.readFile(keyPath(dir), "utf8"));
  // 恢复路径：恢复码 → 恢复 KEK → 解 wrappedRecovery
  assert.ok(unwrapWithRecoveryCode(env, recoveryCode).equals(key), "恢复码解出的 DEK 与本机路径不一致");
  // 本机路径：同一把 DEK 能解开这份归档密文
  const packed = encryptBytes(key, Buffer.from("envelope-e2e"));
  assert.equal(decryptBytes(key, packed).toString(), "envelope-e2e");
  await rmCase(dir);
});

await check("换机器：把信封拷过去 + 恢复码导入，得到同一把 DEK", async () => {
  const src = await tmpDir("dsh-sync-backup-key-src-");
  const dst = await tmpDir("dsh-sync-backup-key-dst-");
  const created = await loadOrCreateKey(src, { kek: kekFor(src) });
  // 模拟「换机器」：把信封搬过去（这是唯一随归档一起迁移的本机文件），
  // 新机器没有旧的本机 KEK。
  await fs.mkdir(dst, { recursive: true });
  await fs.copyFile(keyPath(src), keyPath(dst));
  const imported = await restoreFromCode(dst, created.recoveryCode, { kek: kekFor(dst) });
  assert.ok(sameKey(imported.key, created.key), "恢复码导入拿到的不是同一把 DEK");
  // 恢复码不落盘 → 导入后必然是一把**新的**恢复码（旧的无法从磁盘重算）
  assert.notEqual(imported.recoveryCode, created.recoveryCode, "导入后应生成新恢复码");
  const env = parseEnvelope(await fs.readFile(keyPath(dst), "utf8"));
  assert.ok(unwrapWithRecoveryCode(env, imported.recoveryCode).equals(created.key), "新恢复码解不开新信封");
  await rmCase(src);
  await rmCase(dst);
});

/* ---- 3.2 v3 明文 key.b64 → v4 信封 迁移（保持 DEK 不变）------------- */

/** 建一个放着指定 key 原文的临时 dataDir。 */
async function keyDirWith(text) {
  const dir = await tmpDir("dsh-sync-backup-key-");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, KEY_FILENAME), text, "utf8");
  return dir;
}

await check("v3 明文密钥迁移到信封：DEK 不变，所以既有归档仍可解", async () => {
  const legacyDek = randomBytes(32);
  const dir = await keyDirWith(legacyDek.toString("base64"));
  const got = await loadOrCreateKey(dir, { kek: kekFor(dir) });
  assert.equal(got.migrated, true, "应回报 migrated");
  assert.ok(sameKey(got.key, legacyDek), "迁移必须保留原 DEK（否则旧归档全部报废）");
  // 关键：既有归档是**用旧 DEK 加密**的，迁移后必须仍能解开 —— 这证明迁移
  // 只重建了包裹结构，没有重新加密归档。
  const oldArchive = encryptBytes(legacyDek, Buffer.from("pre-migration-archive"));
  assert.equal(decryptBytes(got.key, oldArchive).toString(), "pre-migration-archive");
  // 迁移会更换恢复码（恢复秘密重新随机），调用方必须重新展示给用户
  assert.equal(got.recoveryChanged, true, "迁移应回报 recoveryChanged");
  assert.ok(got.recoveryCode.length > 0, "迁移必须给出新的恢复码明文");
  assert.equal(parseEnvelope(await fs.readFile(keyPath(dir), "utf8")).v, KEY_VERSION);
  await rmCase(dir);
});

await check("迁移后原文件形态确实变了（不再是裸 base64）", async () => {
  const dir = await keyDirWith(randomBytes(32).toString("base64"));
  await loadOrCreateKey(dir, { kek: kekFor(dir) });
  const raw = (await fs.readFile(keyPath(dir), "utf8")).trim();
  assert.doesNotThrow(() => JSON.parse(raw), "迁移后应是 JSON 信封");
  assert.equal(JSON.parse(raw).v, KEY_VERSION);
  await rmCase(dir);
});

await check("损坏的 key 抛错，且原文件一个字节都不动", async () => {
  const broken = "not-base64!!";
  const dir = await keyDirWith(broken);
  await assert.rejects(
    () => loadOrCreateKey(dir, { kek: kekFor(dir) }),
    (err) => err instanceof KeyError && /无法解析/.test(err.message),
    "坏 key 必须显式失败，不能回退成「生成新密钥」",
  );
  // 核心断言：原文件仍在，内容未变。若这里被覆盖，用户的旧归档就再也打不开了。
  assert.equal(await fs.readFile(keyPath(dir), "utf8"), broken, "坏 key 文件被改写了");
  await rmCase(dir);
});

await check("迁移中断（KEK 存储写入失败）不丢旧密钥", async () => {
  const legacyDek = randomBytes(32);
  const broken = legacyDek.toString("base64");
  const dir = await keyDirWith(broken);
  // 让 KEK 存储在*写入*时抛错：迁移应在写盘前失败，旧文件保持原样。
  // 用 fileKekStore 指向一个必然写不进去的位置（把父路径占成普通文件），
  // 这样走的是适配器真实的错误翻译路径，而不是自造一个 fake store。
  const blocker = path.join(path.dirname(dir), `${path.basename(dir)}-blocker`);
  await fs.writeFile(blocker, "occupied", "utf8");
  const failing = fileKekStore(path.join(blocker, "cannot", "exist", "kek.b64"));
  await assert.rejects(
    () => loadOrCreateKey(dir, { kek: failing }),
    (err) => err instanceof KeyError,
  );
  assert.equal(await fs.readFile(keyPath(dir), "utf8"), broken, "迁移失败把旧密钥弄丢了");
  await fs.rm(blocker, { force: true });
  await rmCase(dir);
});

await check("长度为 32 字节但非规范的 key 也要拒绝（宽容解码陷阱）", async () => {
  // 这是最阴的一类：宽容的 Buffer.from(x,'base64') 能解出 32 字节，
  // 长度检查会通过，但密钥是错的 —— 直到解密才炸，那时已经晚了。
  // 构造：把最后一组的第 3 个字符从 'A'(0) 改成 'B'(1)。多余的低位会被
  // 宽容解码丢掉，于是解出**同样 32 字节**，但再编码回去就不是原文了。
  const sneaky = "A".repeat(42) + "B=";
  assert.equal(Buffer.from(sneaky, "base64").length, 32, "前置条件：确实解出 32 字节");
  assert.notEqual(Buffer.from(sneaky, "base64").toString("base64"), sneaky, "前置条件：确实非规范");
  const dir = await keyDirWith(sneaky);
  await assert.rejects(() => loadOrCreateKey(dir, { kek: kekFor(dir) }), (err) => err instanceof KeyError);
  await rmCase(dir);
});

await check("错误长度 / 空文件 / 含非法字符 一律抛 KeyError 且不改写", async () => {
  for (const bad of ["", Buffer.alloc(16).toString("base64"), "abc\ndef ghi!!", "A".repeat(44)]) {
    const dir = await keyDirWith(bad);
    await assert.rejects(
      () => loadOrCreateKey(dir, { kek: kekFor(dir) }),
      (err) => err instanceof KeyError,
      `${JSON.stringify(bad.slice(0, 12))} 应被拒绝`,
    );
    assert.equal(await fs.readFile(keyPath(dir), "utf8"), bad);
    await rmCase(dir);
  }
});

/* ---- 3.3 fail closed（方案文档第 6 节 · 通用）---------------------- */

await check("篡改 wrappedLocal 密文 → 认证标签失败，且不覆盖原文件", async () => {
  const dir = await tmpDir("dsh-sync-backup-key-");
  await loadOrCreateKey(dir, { kek: kekFor(dir) });
  const raw = await fs.readFile(keyPath(dir), "utf8");
  // 只翻 ct 的第一个字符：GCM 的 tag 校验必须先失败，而不是解出垃圾明文
  const tampered = raw.replace(/"ct":"([A-Za-z0-9+/])/, (_m, c) => `"ct":"${c === "A" ? "B" : "A"}`);
  assert.notEqual(tampered, raw, "前置条件：确实改动了密文");
  await fs.writeFile(keyPath(dir), tampered, "utf8");
  await assert.rejects(
    () => loadOrCreateKey(dir, { kek: kekFor(dir) }),
    (err) => err instanceof KeyError && err.code === "EKEYAUTH",
  );
  assert.equal(await fs.readFile(keyPath(dir), "utf8"), tampered, "认证失败不该改写文件");
  await rmCase(dir);
});

await check("把 wrappedLocal 搬到 wrappedRecovery → AAD 不匹配，被拒", async () => {
  const dir = await tmpDir("dsh-sync-backup-key-");
  await loadOrCreateKey(dir, { kek: kekFor(dir) });
  const env = parseEnvelope(await fs.readFile(keyPath(dir), "utf8"));
  // 两份包裹用不同的 AAD 绑定用途；互换后即使 KEK 对也必须失败。
  const swapped = {
    ...env,
    wrappedRecovery: { ...env.wrappedLocal, salt: env.wrappedRecovery.salt },
  };
  assert.throws(
    () => unwrapWithRecoveryCode(swapped, "A".repeat(52)),
    (err) => err instanceof KeyError,
  );
  await rmCase(dir);
});

await check("未知信封版本 → fail closed（绝不猜着解）", async () => {
  const dir = await tmpDir("dsh-sync-backup-key-");
  await loadOrCreateKey(dir, { kek: kekFor(dir) });
  const env = parseEnvelope(await fs.readFile(keyPath(dir), "utf8"));
  await fs.writeFile(keyPath(dir), JSON.stringify({ ...env, v: 99 }), "utf8");
  await assert.rejects(
    () => loadOrCreateKey(dir, { kek: kekFor(dir) }),
    (err) => err instanceof KeyError && err.code === "EKEYENVELOPEVERSION",
  );
  await rmCase(dir);
});

await check("信封在但本机 KEK 丢失 → locked，且绝不生成新 KEK", async () => {
  const dir = await tmpDir("dsh-sync-backup-key-");
  const kekPath = path.join(path.dirname(dir), `${path.basename(dir)}-localkek`);
  await loadOrCreateKey(dir, { kek: fileKekStore(kekPath) });
  await fs.rm(kekPath, { force: true }); // 模拟本机 KEK 被删 / 换机器
  const st = await keyStatus(dir, { kek: fileKekStore(kekPath) });
  // 关键区分：这不是 invalid（文件是好的），而是 locked（暂时解不开）
  assert.equal(st.status, "locked", `应为 locked，实为 ${st.status}`);
  await assert.rejects(
    () => loadOrCreateKey(dir, { kek: fileKekStore(kekPath) }),
    (err) => err instanceof KeyError && err.code === "EKEYKEKMISSING",
  );
  // 绝不能顺手生成一把新 KEK —— 那会假装一切正常，而归档其实解不开了
  assert.equal(await fs.access(kekPath).then(() => true, () => false), false, "不该生成新 KEK");
  await rmCase(dir);
});

await check("错误恢复码被拒，且不覆盖本机包裹", async () => {
  const dir = await tmpDir("dsh-sync-backup-key-");
  await loadOrCreateKey(dir, { kek: kekFor(dir) });
  const before = await fs.readFile(keyPath(dir), "utf8");
  const wrong = encodeRecoveryCode(randomBytes(32));
  await assert.rejects(
    () => restoreFromCode(dir, wrong, { kek: kekFor(dir) }),
    (err) => err instanceof KeyError && err.code === "EKEYAUTH",
  );
  assert.equal(await fs.readFile(keyPath(dir), "utf8"), before, "错误恢复码不该改写文件");
  await rmCase(dir);
});

await check("KEK 存储形态不对（非 32 字节）→ 拒绝，不覆盖", async () => {
  const dir = await tmpDir("dsh-sync-backup-key-");
  const badKek = {
    source: "test",
    async read() { return Buffer.alloc(16).toString("base64"); },
    async write() {},
  };
  await assert.rejects(
    () => loadOrCreateKey(dir, { kek: badKek }),
    (err) => err instanceof KeyError && err.code === "EKEYKEKLEN",
  );
  await rmCase(dir);
});

await check("缺少 KEK 存储 → 显式失败（不接受「没有本机层」的降级）", async () => {
  const dir = await tmpDir("dsh-sync-backup-key-");
  await assert.rejects(
    () => loadOrCreateKey(dir),
    (err) => err instanceof KeyError && err.code === "EKEYNOSTORE",
  );
  await rmCase(dir);
});

/* ---- 3.4 分支 A 专属：宿主 API 语义（方案文档第 6 节）-------------- */

/** 造一个「宿主凭据库」假实现，只实现 record-half 的两个方法。 */
function fakeHost({ initial, readThrows = false, writeThrows = false } = {}) {
  const records = new Map();
  if (initial !== undefined) records.set(LOCAL_KEK_KEY, { kind: "api-key", key: initial });
  const wrote = [];
  return {
    wrote,
    records,
    ctx: {
      get: (name) => (name !== "credentials" ? undefined : {
        async readRecord(key) {
          if (readThrows) throw new Error("EACCES：凭据库不可读（模拟）");
          assert.equal(String(key), LOCAL_KEK_KEY, "插件必须用固定 key 名");
          return records.get(String(key));
        },
        async modifyRecord(key, mutate) {
          if (writeThrows) throw new Error("EPERM：凭据库不可写（模拟）");
          assert.equal(String(key), LOCAL_KEK_KEY, "插件必须用固定 key 名");
          const cur = records.get(String(key));
          const next = await mutate(cur);
          if (next === undefined) return cur;
          records.set(String(key), next);
          wrote.push(next);
          return next;
        },
      }),
    },
  };
}

await check("分支 A：宿主返回「不存在」→ 走首次生成并写入固定 key 名", async () => {
  const dir = await tmpDir("dsh-sync-backup-key-");
  const host = fakeHost(); // 空库 = 未初始化
  const got = await loadOrCreateKey(dir, { kek: hostKekStore(host.ctx) });
  assert.equal(got.created, true, "宿主说没有 KEK → 应走首次生成");
  assert.equal(got.kekSource, "host");
  assert.equal(host.wrote.length, 1, "应把新 KEK 写进宿主凭据库");
  assert.equal(host.wrote[0].kind, "api-key");
  assert.equal(Buffer.from(host.wrote[0].key, "base64").length, 32, "KEK 必须是 32 字节");
  // 下次读同一把：宿主里有记录时不再生成
  await new Promise((r) => setTimeout(r, 0));
  const again = await loadOrCreateKey(dir, { kek: hostKekStore(host.ctx) });
  assert.equal(again.created, false);
  assert.ok(sameKey(again.key, got.key));
  await rmCase(dir);
});

await check("分支 A：宿主读抛错 → fail closed，key.b64 不被覆盖", async () => {
  const dir = await tmpDir("dsh-sync-backup-key-");
  const good = fakeHost();
  await loadOrCreateKey(dir, { kek: hostKekStore(good.ctx) });
  const before = await fs.readFile(keyPath(dir), "utf8");

  const bad = fakeHost({ readThrows: true });
  await assert.rejects(
    () => loadOrCreateKey(dir, { kek: hostKekStore(bad.ctx) }),
    (err) => err instanceof KeyError,
  );
  assert.equal(await fs.readFile(keyPath(dir), "utf8"), before, "凭据库不可读时不该改写密钥文件");
  await rmCase(dir);
});

await check("分支 A：宿主写抛错 → fail closed，不留下半成品", async () => {
  const dir = await tmpDir("dsh-sync-backup-key-");
  const bad = fakeHost({ writeThrows: true });
  await assert.rejects(
    () => loadOrCreateKey(dir, { kek: hostKekStore(bad.ctx) }),
    (err) => err instanceof KeyError,
  );
  assert.equal(await hasKey(dir), false, "KEK 写不进去就不该产出密钥文件");
  await rmCase(dir);
});

await check("分支 A：宿主凭据服务缺失 → 显式失败（不静默退化）", async () => {
  const dir = await tmpDir("dsh-sync-backup-key-");
  const noService = { get: () => undefined };
  await assert.rejects(
    () => loadOrCreateKey(dir, { kek: hostKekStore(noService) }),
    (err) => err instanceof KeyError && err.code === "EKEYSTORE",
  );
  await rmCase(dir);
});

await check("分支 A：宿主记录的形态不对（不是 api-key）→ 拒绝", async () => {
  const dir = await tmpDir("dsh-sync-backup-key-");
  const host = fakeHost({ initial: undefined });
  host.records.set(LOCAL_KEK_KEY, { kind: "grant", payload: { nested: true } });
  await assert.rejects(
    () => loadOrCreateKey(dir, { kek: hostKekStore(host.ctx) }),
    (err) => err instanceof KeyError && err.code === "EKEYSTORESHAPE",
  );
  await rmCase(dir);
});

/* ---- 3.5 磁盘 / 日志 / state 中不出现任何明文秘密 ------------------- */

await check("落盘文件里不出现恢复码明文、DEK 明文、本机 KEK 明文", async () => {
  const dir = await tmpDir("dsh-sync-backup-key-");
  const kekPath = path.join(path.dirname(dir), `${path.basename(dir)}-localkek`);
  const store = fileKekStore(kekPath);
  const { key, recoveryCode } = await loadOrCreateKey(dir, { kek: store });
  const kekB64 = (await fs.readFile(kekPath, "utf8")).trim();

  const keyFile = await fs.readFile(keyPath(dir), "utf8");
  const bare = recoveryCode.replace(/-/g, "");
  const kekBuf = Buffer.from(kekB64, "base64");

  // 三条都必须是「磁盘上没有」——这是 v4 相对 v3 的全部意义。
  assert.ok(!keyFile.replace(/-/g, "").includes(bare), "key.b64 里出现了恢复码明文");
  assert.ok(!keyFile.includes(key.toString("base64")), "key.b64 里出现了 DEK 明文");
  assert.ok(!keyFile.includes(kekB64), "key.b64 里出现了本机 KEK 明文");
  // 本机 KEK 文件本身只应存在于它自己的位置，且不含 DEK
  assert.ok(!kekB64.includes(key.toString("base64")), "KEK 文件里出现了 DEK 明文");
  // 掩码函数不会泄漏整串
  assert.ok(!maskRecoveryCode(recoveryCode).includes(bare), "掩码函数泄漏了恢复码");
  assert.ok(kekBuf.length === 32);
  await rmCase(dir);
});

/* ---- 3.6 恢复元数据可迁移（契约 3）--------------------------------- */

await check("recoveryEnvelopeForUpload 只含密文，可安全随 manifest 上行", async () => {
  const dir = await tmpDir("dsh-sync-backup-key-");
  const { key, recoveryCode } = await loadOrCreateKey(dir, { kek: kekFor(dir) });
  const env = parseEnvelope(await fs.readFile(keyPath(dir), "utf8"));
  const meta = recoveryEnvelopeForUpload(env);

  assert.ok(meta, "必须能摘出恢复元数据");
  assert.equal(meta.v, KEY_VERSION);
  // 上行物**不得**含本机专用包裹（换机器时它本来就该丢弃重建）
  assert.equal(meta.wrappedLocal, undefined, "recoveryEnvelope 不该带上 wrappedLocal");
  // 也不得含任何明文秘密
  const text = JSON.stringify(meta);
  assert.ok(!text.includes(recoveryCode.replace(/-/g, "")), "恢复元数据里出现了恢复码明文");
  assert.ok(!text.includes(key.toString("base64")), "恢复元数据里出现了 DEK 明文");

  // 灾难恢复：只有这份元数据 + 用户保管的恢复码，也能解回 DEK
  assert.ok(unwrapFromRecoveryMeta(meta, recoveryCode).equals(key), "仅凭恢复元数据应能解回同一 DEK");
  await rmCase(dir);
});

await check("恢复元数据缺失时给出明确错误（不是静默失败）", async () => {
  assert.throws(
    () => unwrapFromRecoveryMeta(null, encodeRecoveryCode(randomBytes(32))),
    (err) => err instanceof KeyError && err.code === "EKEYNOMETA",
  );
});

/* ============================================================
 * 4. user-config
 * ============================================================ */

section("[4] user-config：界面改配置");

await check("缺失 / 损坏一律返回 {} 而不抛", async () => {
  const dir = await tmpDir("dsh-sync-backup-cfg-");
  assert.deepEqual(await loadUserConfig(dir), {});
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(configPath(dir), "{ this is not json", "utf8");
  assert.deepEqual(await loadUserConfig(dir), {});
  await fs.writeFile(configPath(dir), '["an","array"]', "utf8");
  assert.deepEqual(await loadUserConfig(dir), {});
  await fs.rm(dir, { recursive: true, force: true });
});

await check("save → load 往返一致", async () => {
  const dir = await tmpDir("dsh-sync-backup-cfg-");
  await saveUserConfig(dir, { keepLast: 5, githubRepo: "o/r" });
  await saveUserConfig(dir, { webdavEnabled: true });
  const got = await loadUserConfig(dir);
  assert.equal(got.keepLast, 5);
  assert.equal(got.githubRepo, "o/r");
  assert.equal(got.webdavEnabled, true);
  await fs.rm(dir, { recursive: true, force: true });
});

await check("写前备份成 config.json.bak", async () => {
  const dir = await tmpDir("dsh-sync-backup-cfg-");
  await saveUserConfig(dir, { keepLast: 1 });
  await saveUserConfig(dir, { keepLast: 2 });
  const bak = await fs.readFile(`${configPath(dir)}.bak`, "utf8");
  assert.equal(JSON.parse(bak).keepLast, 1, "备份里应是上一版");
  await fs.rm(dir, { recursive: true, force: true });
});

await check("mergeConfig 用 ?? 语义：false / 0 / \"\" 不被默认值盖回", async () => {
  const defaults = { webdavEnabled: true, keepLast: 7, githubRepo: "default/repo" };
  const merged = mergeConfig(defaults, { webdavEnabled: false, keepLast: 0, githubRepo: "" });
  // 这是「用 || 会错、用 ?? 才对」的核心断言：用户显式关掉的东西必须留得住。
  assert.equal(merged.webdavEnabled, false);
  assert.equal(merged.keepLast, 0);
  assert.equal(merged.githubRepo, "");
});

await check("用户没写过的键仍取默认值", async () => {
  const merged = mergeConfig({ a: 1, b: 2 }, { a: 9 });
  assert.equal(merged.a, 9);
  assert.equal(merged.b, 2);
});

await check("pickEditable 白名单：白名单外的键落在 rejected", async () => {
  const { accepted, rejected } = pickEditable({ keepLast: 3, dataDir: "/evil", dryRun: false });
  assert.deepEqual(Object.keys(accepted), ["keepLast"]);
  assert.deepEqual(rejected.sort(), ["dataDir", "dryRun"]);
});

await check("每个 GUI_EDITABLE_KEYS 都有形状定义", async () => {
  // 白名单单方面扩了但忘记定义类型，sanitizeEditable 会静默放行任意值。
  const types = sanitizeEditable(Object.fromEntries(GUI_EDITABLE_KEYS.map((k) => [k, null])));
  assert.equal(types.accepted && Object.keys(types.accepted).length, 0, "null 一把梭应全部被拒");
  assert.ok(types.problems.length > 0);
});

await check("形状不对 → 进 problems，一个都不写盘", async () => {
  const out = sanitizeEditable(
    { keepLast: "七天", webdavEnabled: "yes", selectedPaths: "not-an-array", githubRepo: 42 },
    { knownPathIds: new Set(["persona", "memory"]) },
  );
  assert.deepEqual(Object.keys(out.accepted), [], "有问题时不应接受任何键");
  assert.ok(out.problems.some((p) => /keepLast/.test(p)));
  assert.ok(out.problems.some((p) => /webdavEnabled/.test(p)));
  assert.ok(out.problems.some((p) => /selectedPaths/.test(p)));
  assert.ok(out.problems.some((p) => /githubRepo/.test(p)));
});

await check("selectedPaths 去重 + 排序；未知 id 被拒", async () => {
  const ok = sanitizeEditable({ selectedPaths: ["memory", "persona", "memory"] }, { knownPathIds: new Set(["persona", "memory"]) });
  assert.deepEqual(ok.accepted.selectedPaths, ["memory", "persona"]);
  const bad = sanitizeEditable({ selectedPaths: ["../../etc/passwd"] }, { knownPathIds: new Set(["persona"]) });
  assert.equal(bad.accepted.selectedPaths, undefined);
  assert.ok(bad.problems.some((p) => /未知条目/.test(p)));
});

await check("负数与非有限 number 被拒", async () => {
  for (const v of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const out = sanitizeEditable({ keepLast: v });
    assert.equal(out.accepted.keepLast, undefined, `keepLast=${v} 不该被接受`);
  }
});

await check("空改动 → accepted 为空（调用方据此返回 bad-request）", async () => {
  const out = sanitizeEditable({});
  assert.equal(Object.keys(out.accepted).length, 0);
  assert.equal(out.problems.length, 0);
});

// ---------------------------------------------------------------
// 2.4：数值的业务范围（不只是「是数字」）
// ---------------------------------------------------------------

await check("intervalHours=0 被拒（否则界面显示 0、实际按 12 跑）", async () => {
  const out = sanitizeEditable({ intervalHours: 0 });
  assert.equal(out.accepted.intervalHours, undefined, "0 必须被拒");
  assert.ok(out.problems.some((p) => /周期/.test(p)), `应有可读原因，实际 ${JSON.stringify(out.problems)}`);
});

await check("keepLast=0 被拒（本地与远端会给出不同语义）", async () => {
  const out = sanitizeEditable({ keepLast: 0 });
  assert.equal(out.accepted.keepLast, undefined);
  assert.ok(out.problems.length > 0);
});

await check("本地与远端周期都不接受小数（周期是整小时）", async () => {
  for (const key of ["intervalHours", "remoteIntervalHours", "keepLast", "localKeepDays"]) {
    const out = sanitizeEditable({ [key]: 1.5 });
    assert.equal(out.accepted[key], undefined, `${key} 不该接受小数`);
  }
});

await check("remoteIntervalHours=0 合法（语义：每次本地打包后同步）", async () => {
  const out = sanitizeEditable({ remoteIntervalHours: 0 });
  assert.equal(out.accepted.remoteIntervalHours, 0);
  assert.equal(out.problems.length, 0);
});

await check("超出上限的大数被拒", async () => {
  for (const [key, v] of [["keepLast", 99999], ["intervalHours", 24 * 365], ["localKeepDays", 99999]]) {
    const out = sanitizeEditable({ [key]: v });
    assert.equal(out.accepted[key], undefined, `${key}=${v} 应被拒`);
  }
});

await check("checkNumberRange 与 NUMBER_BOUNDS 是同一份口径（供 UI/host/调度器共用）", async () => {
  for (const [key, b] of Object.entries(NUMBER_BOUNDS)) {
    assert.equal(checkNumberRange(key, b.min).ok, true, `${key} 的下界应合法`);
    assert.equal(checkNumberRange(key, b.max).ok, true, `${key} 的上界应合法`);
    assert.equal(checkNumberRange(key, b.min - 1).ok, false, `${key} 低于下界应被拒`);
    assert.equal(checkNumberRange(key, b.max + 1).ok, false, `${key} 高于上界应被拒`);
  }
});

await check("手工把越界数值写进 config.json → 载入时被丢弃（回落到默认）", async () => {
  const dir = await tmpDir("dsh-sync-backup-cfg-");
  await fs.mkdir(dir, { recursive: true });
  // 用户用编辑器直接改文件，绕过 sanitizeEditable
  await fs.writeFile(
    configPath(dir),
    JSON.stringify({ schemaVersion: 1, intervalHours: 0, keepLast: -5, enabled: false }),
    "utf8",
  );
  const got = await loadUserConfig(dir);
  assert.equal(got.intervalHours, undefined, "越界的 intervalHours 不该进入配置");
  assert.equal(got.keepLast, undefined, "负的 keepLast 不该进入配置");
  assert.equal(got.enabled, false, "非数值键不受影响");
  await fs.rm(dir, { recursive: true, force: true });
});

await check("并发保存不丢更新（同一文件读改写串行化）", async () => {
  const dir = await tmpDir("dsh-sync-backup-cfg-");
  // 三次并发保存不同键：若没有串行化，后写者会基于旧快照把别人的键抹掉
  await Promise.all([
    saveUserConfig(dir, { keepLast: 3 }),
    saveUserConfig(dir, { intervalHours: 6 }),
    saveUserConfig(dir, { localKeepDays: 2 }),
  ]);
  const got = await loadUserConfig(dir);
  assert.equal(got.keepLast, 3, `keepLast 丢了：${JSON.stringify(got)}`);
  assert.equal(got.intervalHours, 6, `intervalHours 丢了：${JSON.stringify(got)}`);
  assert.equal(got.localKeepDays, 2, `localKeepDays 丢了：${JSON.stringify(got)}`);
  await fs.rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------
// 4.1：真实出厂默认值 = schema 默认 ⊕ cordis.patch.yml
// ---------------------------------------------------------------
//
// 只断言 Config 的 schema 默认值是**不够的** —— patch 的显式值会覆盖它，
// 而用户实际拿到的是合并后的那一层。这里直接解析 patch 文件，
// 保证文档承诺与出厂行为是同一种东西。

await check("cordis.patch.yml 的显式值与 README 描述一致（合并后才算数）", async () => {
  const patchPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "cordis.patch.yml");
  const yml = await fs.readFile(patchPath, "utf8");
  /** 从 patch 里取某个键的标量值（够用即可，不引入 YAML 依赖）。 */
  const scalar = (key) => {
    const m = new RegExp(`^\\s*${key}:\\s*(.+?)\\s*$`, "m").exec(yml);
    if (!m) return undefined;
    return m[1].replace(/^['"]|['"]$/g, "");
  };

  // 这几条是 README「How it is done」表里明确承诺过的行为
  assert.equal(scalar("persistArchive"), "false", "patch 的 persistArchive 应为 false（README 已按分层解析说明）");
  assert.equal(scalar("webdavEnabled"), "true", "patch 的 webdavEnabled 应为 true（目标为空时会被 skip）");
  assert.equal(scalar("webdavUrl"), "", "出厂 webdavUrl 必须为空，否则会真的外传");
  assert.equal(scalar("webdavUsername"), "", "出厂 webdavUsername 必须为空");
  assert.equal(scalar("dryRun"), "true", "出厂 dryRun 必须为 true（上传闸门）");
  assert.equal(scalar("uploadOnSchedule"), "false", "出厂不得自动上传");
  assert.equal(scalar("githubRepo"), "", "出厂 githubRepo 必须为空");
});

/* ============================================================
 * 5. 端到端：key + config + 归档
 * ============================================================ */

section("[5] 端到端");

await check("同一 dataDir 里 config.json 与 key.b64 互不干扰", async () => {
  const dir = await tmpDir("dsh-sync-backup-e2e-");
  await saveUserConfig(dir, { keepLast: 4 });
  const info = await loadOrCreateKey(dir, { kek: kekFor(dir) });
  const got = await loadUserConfig(dir);
  assert.equal(got.keepLast, 4);
  assert.ok(info.recoveryCode.length > 0);
  // v4 的 key.b64 是 JSON 信封、config.json 是配置对象 —— 两者都合法 JSON，
  // 所以「不许互相串写」改成断言**结构可区分**：信封有 v/wrappedLocal，
  // 配置文件里绝不该出现加密字段。
  const rawKey = await fs.readFile(keyPath(dir), "utf8");
  const env = JSON.parse(rawKey);
  assert.equal(env.v, KEY_VERSION);
  assert.ok(env.wrappedLocal, "key.b64 应是信封");
  assert.equal(got.wrappedLocal, undefined, "config.json 里混进了信封字段");
  assert.equal(got.v, undefined, "config.json 里混进了信封版本号");
  await rmCase(dir);
});

/* ============================================================ */

console.log(`\n=== 结果 ===`);
console.log(`crypto-smoke: 通过 ${passed} / 失败 ${failed}`);
if (failed > 0) {
  console.log(failures.map((f) => `  ✗ ${f}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log("全部通过。");
}
