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
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

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
import { keyPath, loadOrCreateKey, saveKey, hasKey, restoreFromCode, KEY_FILENAME } from "../lib/keyring.js";
import {
  configPath,
  loadUserConfig,
  saveUserConfig,
  mergeConfig,
  pickEditable,
  sanitizeEditable,
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
 * 3. keyring
 * ============================================================ */

section("[3] keyring：密钥落地与复用");

await check("首次调用创建，第二次复用同一个 key", async () => {
  const dir = await tmpDir("dsh-sync-backup-key-");
  const first = await loadOrCreateKey(dir);
  assert.equal(first.created, true);
  // 让 task settle 后的回收微任务跑过去。`loadOrCreateKey` 在 task 落地后会
  // 摘掉 inflight 缓存项；不排这一格，第二次会命中**同一个 task 对象**并连带
  // 把 `created:true` 一起返回 —— 那不是 bug（同一个结果的多个观察者本就该看到
  // 同一份 created），但它会让本断言失去「第二次真的去读了文件」的意义。
  await new Promise((r) => setTimeout(r, 0));
  const second = await loadOrCreateKey(dir);
  assert.equal(second.created, false);
  assert.ok(sameKey(first.key, second.key), "两次拿到的不是同一个密钥");
  assert.equal(first.recoveryCode, second.recoveryCode);
  await fs.rm(dir, { recursive: true, force: true });
});

await check("key.b64 内容是 base64，解码 32 字节", async () => {
  const dir = await tmpDir("dsh-sync-backup-key-");
  const { key } = await loadOrCreateKey(dir);
  const raw = await fs.readFile(keyPath(dir), "utf8");
  assert.equal(Buffer.from(raw.trim(), "base64").length, 32);
  assert.ok(sameKey(Buffer.from(raw.trim(), "base64"), key));
  await fs.rm(dir, { recursive: true, force: true });
});

await check("saveKey 幂等：同内容不重写", async () => {
  const dir = await tmpDir("dsh-sync-backup-key-");
  const { key } = await loadOrCreateKey(dir);
  const file = keyPath(dir);
  const before = (await fs.stat(file)).mtimeMs;
  await new Promise((r) => setTimeout(r, 15));
  await saveKey(dir, key);
  const after = (await fs.stat(file)).mtimeMs;
  assert.equal(after, before, "同内容重写会让 mtime 无意义地前进");
  await fs.rm(dir, { recursive: true, force: true });
});

await check("hasKey 只读，不创建", async () => {
  const dir = await tmpDir("dsh-sync-backup-key-");
  assert.equal(await hasKey(dir), false);
  await loadOrCreateKey(dir);
  assert.equal(await hasKey(dir), true);
  await fs.rm(dir, { recursive: true, force: true });
});

await check("用恢复码可以把 key 放回来", async () => {
  const dirA = await tmpDir("dsh-sync-backup-key-a-");
  const dirB = await tmpDir("dsh-sync-backup-key-b-");
  const { recoveryCode } = await loadOrCreateKey(dirA);
  // 模拟「换机器」：B 上没有 key，用恢复码还原
  assert.equal(await hasKey(dirB), false);
  const restored = await restoreFromCode(dirB, recoveryCode);
  const b = await loadOrCreateKey(dirB);
  assert.ok(sameKey(restored, b.key), "恢复码放回去的 key 与后续读到的一致");
  // 用 B 的 key 能解开 A 加密的东西 —— 这才是「换机器后可恢复」的真正断言
  const { key: keyA } = await loadOrCreateKey(dirA);
  const packed = encryptBytes(keyA, Buffer.from("cross-machine"));
  assert.ok(decryptBytes(b.key, packed).equals(Buffer.from("cross-machine")));
  await fs.rm(dirA, { recursive: true, force: true });
  await fs.rm(dirB, { recursive: true, force: true });
});

await check("并发调用共享一次创建（不撞 tmp 文件名）", async () => {
  const dir = await tmpDir("dsh-sync-backup-key-");
  const results = await Promise.all([
    loadOrCreateKey(dir),
    loadOrCreateKey(dir),
    loadOrCreateKey(dir),
    loadOrCreateKey(dir),
  ]);
  // 注意别断言 `created` 的次数：四个 caller 共享**同一个** task，
  // 所以它返回的那个结果对象被数了四次。真正要保证的是「四把钥匙是同一把」
  // 以及「磁盘上只有一次写入」—— tmp 文件名撞车会表现为随机 ENOENT。
  for (const r of results) {
    assert.ok(sameKey(r.key, results[0].key), "并发调用拿到了不同的密钥");
    assert.equal(r.recoveryCode, results[0].recoveryCode);
  }
  const files = await fs.readdir(dir);
  assert.deepEqual(files, [KEY_FILENAME], `并发后不该留下 tmp 残留：${JSON.stringify(files)}`);
  await fs.rm(dir, { recursive: true, force: true });
});

await check("损坏的 key 文件会被替换而不是让插件起不来", async () => {
  const dir = await tmpDir("dsh-sync-backup-key-");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, KEY_FILENAME), "not-base64!!", "utf8");
  const got = await loadOrCreateKey(dir);
  assert.equal(got.created, true);
  assert.equal(sameKey(got.key, Buffer.from((await fs.readFile(keyPath(dir), "utf8")).trim(), "base64")), true);
  await fs.rm(dir, { recursive: true, force: true });
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

/* ============================================================
 * 5. 端到端：key + config + 归档
 * ============================================================ */

section("[5] 端到端");

await check("同一 dataDir 里 config.json 与 key.b64 互不干扰", async () => {
  const dir = await tmpDir("dsh-sync-backup-e2e-");
  await saveUserConfig(dir, { keepLast: 4 });
  const info = await loadOrCreateKey(dir);
  const got = await loadUserConfig(dir);
  assert.equal(got.keepLast, 4);
  assert.ok(info.recoveryCode.length > 0);
  // key.b64 是裸 base64 文本，绝不能被当作 JSON 读 —— 这条防的是两份文件互相串写
  const rawKey = await fs.readFile(keyPath(dir), "utf8");
  assert.throws(() => JSON.parse(rawKey), SyntaxError);
  await fs.rm(dir, { recursive: true, force: true });
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
