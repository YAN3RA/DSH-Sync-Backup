/**
 * 静态一致性检查：lib/client.js 里每一个 t("key") 用到的键，都必须在 STRINGS.zh 里定义。
 *
 * 为什么单列一条检查：client bundle 在浏览器里跑，`t()` 找不到键时不会抛错，
 * 只会把键名原样渲染成丑陋的占位串（"restoreCheck" 之类）。离线测试用固定 fixture，
 * 很容易漏掉只在特定分支才走的键。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = fs.readFileSync(path.join(root, "lib", "client.js"), "utf8");

let failed = 0;
const fail = (msg) => {
  process.stderr.write(`✗ ${msg}\n`);
  failed += 1;
};
const pass = (msg) => process.stdout.write(`  ✓ ${msg}\n`);

/* ---- 1) 抽出 STRINGS.zh 的键集合 ---- */
const stringsStart = src.indexOf("const STRINGS = {");
if (stringsStart < 0) {
  fail("找不到 STRINGS 定义");
  process.exit(1);
}
// zh 块：从 "zh: {" 到紧随其后的顶层 "en: {" 之前
const zhStart = src.indexOf("zh: {", stringsStart);
const enStart = src.indexOf("en: {", zhStart);
if (zhStart < 0 || enStart < 0) {
  fail("STRINGS 里找不到 zh / en 块");
  process.exit(1);
}
const zhBlock = src.slice(zhStart, enStart);
const enBlock = src.slice(enStart, src.indexOf("\n\t\t}", enStart) + 1);

const keysOf = (block) => {
  const out = new Set();
  for (const m of block.matchAll(/^\s{4,}([A-Za-z][A-Za-z0-9_]*)\s*:/gm)) out.add(m[1]);
  return out;
};
const zhKeys = keysOf(zhBlock);
const enKeys = keysOf(enBlock);

if (zhKeys.size === 0) fail("zh 键集合为空（正则可能没匹配上缩进）");
else pass(`zh 键 ${zhKeys.size} 个`);

/* ---- 2) 抽出所有 t("...") 调用的第一参数 ---- */
const used = new Set();
// t("key") 与 t("key", {...}) 两种形态；TAB_LABEL 的值是间接引用，单独处理
for (const m of src.matchAll(/\bt\(\s*"([A-Za-z][A-Za-z0-9_]*)"/g)) used.add(m[1]);

const missing = [...used].filter((k) => !zhKeys.has(k));
if (missing.length > 0) fail(`zh 缺失键：${missing.join(", ")}`);
else pass(`用到的 ${used.size} 个键在 zh 里全部存在`);

const missingEn = [...used].filter((k) => !enKeys.has(k));
if (missingEn.length > 0) fail(`en 缺失键：${missingEn.join(", ")}`);
else pass(`用到的 ${used.size} 个键在 en 里全部存在`);

/* ---- 3) TAB_LABEL 的间接引用也要存在 ---- */
const labelKeys = [...src.matchAll(/tab(Overview|Artifacts|Channels|Env)/g)].map((m) => m[0]);
const missingLabels = [...new Set(labelKeys)].filter((k) => !zhKeys.has(k));
if (missingLabels.length > 0) fail(`tab 标签键缺失：${missingLabels.join(", ")}`);
else pass("四个 tab 标签键齐备");

/* ---- 4) 四个 tab 组件都必须被 body 分派引用 ---- */
for (const name of ["OverviewTab", "ArtifactsTab", "ChannelsTab", "EnvTab"]) {
  if (!new RegExp(`function ${name}\\(`).test(src)) fail(`缺少组件 ${name}`);
  else if (!new RegExp(`= ${name}\\(`).test(src)) fail(`${name} 定义了但没被渲染`);
  else pass(`${name} 定义并参与渲染`);
}

/* ---- 5) RPC 端点白名单：不得臆造 host 没有的端点 ---- */
const ALLOWED = new Set([
  "sync-backup.status",
  "sync-backup.run",
  "sync-backup.prune",
  "sync-backup.restore-check",
  "sync-backup.catalog-sizes",
  // v3：界面开始写配置 / 按需导出恢复码
  "sync-backup.save-config",
  "sync-backup.export-recovery-code",
  // v4：只读版本检查（一次不带凭据的 GET，不写盘）
  "sync-backup.check-update",
]);
const called = new Set([...src.matchAll(/call\(\s*"(sync-backup\.[a-z-]+)"/g)].map((m) => m[1]));
if (called.size === 0) fail("没找到任何 call() 端点调用");
else {
  const bogus = [...called].filter((c) => !ALLOWED.has(c));
  if (bogus.length > 0) fail(`调用了 host 未实现的端点：${bogus.join(", ")}`);
  else pass(`调用的 ${called.size} 个端点全部在 host 白名单内：${[...called].join(", ")}`);
}

/* ---- 6) 安全：面板不得出现任何回显口令的意图 ---- */
if (/type:\s*"password"/.test(src)) fail("client 里出现了 password 输入框（口令只能由脚本写入，面板不得读取）");
else pass("无 password 输入框（口令只写不读）");

// 不在 checkbox 上做「可改却存不下」的假承诺。
// v3 之前：唯一的 checkbox 是备份条目的只读投影，一律 disabled。
// v3 起：通道总开关是**受控** checkbox（有 checked + onChange），它不是假承诺，反而是要在 Save 之前
// 让用户先把意图摆出来。所以规则从「必须 disabled」放宽为「disabled 或受控」，二者皆非才算缺陷。
//
// 关键：**逐个** checkbox 判定，不能在整份源码上做一次全局 `disabled: true` 正则——
// 那样只要备份条目那一处投影写了 disabled，后面所有野生 checkbox 都能免费过关，规则变成永真式。
/** 逐个抽出每个 h("input", {...}) 的属性块（按花括号配平，跨行也能取到）。 */
function inputPropBlocks(source) {
  const out = [];
  const startRe = /h\(\s*"input"\s*,\s*\{/g;
  let m;
  while ((m = startRe.exec(source)) !== null) {
    let depth = 1;
    let i = startRe.lastIndex;
    for (; i < source.length && depth > 0; i += 1) {
      const ch = source[i];
      if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
    }
    out.push(source.slice(m.index, i));
    startRe.lastIndex = i;
  }
  return out;
}

const boxes = inputPropBlocks(src).filter((b) => /type:\s*"checkbox"/.test(b));
if (boxes.length === 0) pass("无 checkbox");
else {
  const bad = boxes.filter((b) => {
    if (/disabled:/.test(b)) return false; // 只读投影：点了就不会变，不会误导
    if (/checked:/.test(b) && /onChange:/.test(b)) return false; // 受控：变不变由 state 说了算
    return true; // 既非 disabled 又非受控 ⇒ React 受控告警 + 点了没反应
  });
  if (bad.length > 0) {
    fail(`${boxes.length} 个 checkbox 中有 ${bad.length} 个既不 disabled 也不受控（checked + onChange）`);
    for (const b of bad) process.stderr.write(`    ↳ ${b.replace(/\s+/g, " ").slice(0, 160)}\n`);
  } else {
    pass(`${boxes.length} 个 checkbox：要么 disabled（只读投影），要么受控（checked + onChange）`);
  }
}

/* ---- 6c) 数字输入框必须把字符串转成数字再交给 draft ----
 * e.target.value 永远是字符串；直接塞进 draft 会让 save-config 的形状校验拒掉整次保存，
 * 而用户看到的是「点了保存没反应」。这条规则把那个 bug 钉死在离它最近的地方。 */
{
  const numbers = inputPropBlocks(src).filter((b) => /type:\s*"number"/.test(b));
  if (numbers.length === 0) pass("无数字输入框");
  else {
    const bad = numbers.filter((b) => !/Number\(/.test(b));
    if (bad.length > 0) {
      fail(`${numbers.length} 个数字输入框中有 ${bad.length} 个未做 Number() 转换（e.target.value 是字符串）`);
      for (const b of bad) process.stderr.write(`    ↳ ${b.replace(/\s+/g, " ").slice(0, 160)}\n`);
    } else {
      pass(`${numbers.length} 个数字输入框均把 e.target.value 转成 Number`);
    }
  }
}

/* ---- 8) 安装可用性契约（报告：三种客户端都能装上） ----
 *
 * 这些属**打包元数据**，坏了不会有任何运行时症状 —— 插件的代码、测试、CI 可能全绿，
 * 而用户看到的是「不认识这个包」或装完缺文件。所以在这里钉住。
 */
const pkgPath = path.join(root, "package.json");
let pkg = null;
try {
  pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
} catch (err) {
  fail(`package.json 读不出来：${err.message}`);
}
if (pkg) {
  // 8a) private:true 会让 npm publish 直接被拒 —— 那样「用 npm 包名安装」这条路就断了。
  if (pkg.private === true) fail("package.json 仍是 private:true，npm 包名安装不可用");
  else pass("package.json 未标记 private（npm 包名安装可用）");

  // 8b) npm registry 元数据：缺了它们包的页面与安装提示都不完整。
  for (const k of ["name", "version", "description", "license", "repository", "main"]) {
    if (pkg[k] === undefined || pkg[k] === "") fail(`package.json 缺 ${k}`);
  }
  if (pkg.repository?.url && !String(pkg.repository.url).includes("github.com")) {
    fail(`repository.url 不是 GitHub：${pkg.repository.url}`);
  } else if (pkg.repository?.url) {
    pass("npm 元数据齐全（name/version/description/license/repository/main）");
  }

  // 8c) files 白名单必须覆盖**实际运行所需**的每个顶层项。
  //     漏掉 docs/ 只是文档缺失，但漏掉 lib/ 或 cordis.patch.yml 会直接装出一个坏插件。
  const files = Array.isArray(pkg.files) ? pkg.files : [];
  const norm = (f) => String(f).replace(/^\/+/, "").replace(/\/+$/, "");
  const covered = (target) => files.some((f) => norm(f) === target || norm(f) === target + "/" || norm(f).startsWith(target + "/"));
  for (const need of ["index.js", "cordis.patch.yml", "lib", "package.json"]) {
    // package.json 永远会被 npm 带上，无需写进 files
    if (need === "package.json") continue;
    if (!covered(need)) fail(`files 未覆盖 ${need}（装出来的插件会缺文件）`);
  }
  pass(`files 覆盖运行所需项：${files.join(", ")}`);

  // 8d) bundle patch 声明必须指向真实存在的文件（缺失 = 插件静默不加载）。
  const patchRel = pkg.dsh?.bundle?.patch;
  if (typeof patchRel !== "string" || patchRel === "") {
    fail("dsh.bundle.patch 未声明（bundle 插件不会被注册）");
  } else if (!fs.existsSync(path.join(root, patchRel))) {
    fail(`dsh.bundle.patch 指向的文件不存在：${patchRel}`);
  } else {
    pass(`dsh.bundle.patch = ${patchRel}（文件存在）`);
  }

  // 8e) peerDependencies 必须在 —— link: 安装靠它让 loader 拦截裸 import。
  const peers = pkg.peerDependencies ?? {};
  for (const need of ["@deepseek-ai/dsh-tools", "@deepseek-ai/schemastery"]) {
    if (typeof peers[need] !== "string") fail(`peerDependencies 缺 ${need}（link 安装会静默加载失败）`);
  }
  pass("peerDependencies 声明完整");
}

/* ---- 7) 形态：source-as-product 的收尾 ---- */
if (!/module\.exports = \{ inject, apply \}/.test(src)) fail("结尾缺少 module.exports = { inject, apply }");
else pass("module.exports = { inject, apply }");
if (!/var inject = \["connection", "slots"\]/.test(src)) fail('inject 不是 ["connection","slots"]');
else pass('inject = ["connection","slots"]');
if (!/window\.__ModuleLoader__\.load\(/.test(src)) fail("缺少 window.__ModuleLoader__.load 包裹");
else pass("ModuleLoader 包裹完整");

process.stdout.write(failed === 0 ? "\nclient 契约检查全部通过\n" : `\nclient 契约检查失败 ${failed} 项\n`);
process.exit(failed === 0 ? 0 : 1);
