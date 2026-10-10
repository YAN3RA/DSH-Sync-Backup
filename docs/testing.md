# Testing

> Moved out of the README. Run everything offline: no network, no credentials, no real `$DSH_HOME`.

## What to run

```sh
npm test              # everything below, in sequence
npm run dry-run:full  # full pack + per-file SHA256 comparison on extraction
```

## Suites

| Suite | Covers |
| --- | --- |
| `smoke` | Host half: manifest contract, RPC dispatch, tool output gates, temp DSH_HOME |
| `client-smoke` / `client-contract` | Client half: module loader, slot registration, four tabs, i18n keys, endpoint allowlist, no password field |
| `crypto-smoke` | Encryption round-trip, IV uniqueness, wrong-key rejection, cross-machine recovery-code restore |
| `webdav-smoke` / `github-smoke` | Both clients against injected fake requests — **zero network** |
| `scheduler-smoke` / `channels-smoke` | Fake clock and timers; two-channel orchestration on local fake servers |

`smoke` uses `--import ./tools/_hooks-register.mjs` to redirect the two harness packages to minimal
stubs, so the Host half is testable without booting DSH. `host-gates` is deliberately **not** part of
`npm test` — it needs the Electron binary to read `app.asar` and is the only suite that drives the real
Host output gates:

```sh
$env:ELECTRON_RUN_AS_NODE = "1"
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\DeepSeek Harness.exe" --expose-internals (Resolve-Path tools\host-gates.mjs).Path
```

## 测试覆盖的边界（诚实口径）

- `npm test` **不包含** `dry-run:full`，也**不包含** `host-gates`（后者需要 Electron 二进制）。
  不要以为跑一次 `npm test` 就覆盖了所有关口。
- 离线单测通过 ≠ 真实通道已验证。GitHub 通道目前只跑过假传输，**没有做过真实上传**。
- 断言数量会随测试增长而变化；要写数字请以脚本输出为准，别把某个时间点的数字抄进文档。

## CI

`.github/workflows/ci.yml` 在 Linux + Windows × Node 20/22 上跑 `npm test`、`npm run dry-run:full`
与 `npm run scheduler-plan`，另有独立的安全回归与前端契约作业。

刻意**不**放进 CI 的：

| 项目 | 原因 | 何时跑 |
| --- | --- | --- |
| `tools/host-gates.mjs` | 需要 Electron-as-Node 与真实 DSH 运行时 | 发布前手动 |
| 真实通道写入 | 需要 WebDAV 凭据 / GitHub PAT，不能暴露给 PR | 隔离环境手动 |
