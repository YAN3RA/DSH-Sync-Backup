# DSH-Sync

> DSH timed backup plugin. Package name: `dsh-sync-backup`.

Backs up the **memory layer** — project memory, handoff whiteboard, skills, storages, sessions — and
uploads it to a WebDAV collection plus a GitHub repository, giving you two independently verifiable
copies. Local packing is always available; both upload channels are off until you switch them on.

**Status:** P1–P5 complete and installed (2026-10-09). v2 four-tab panel and v3 encryption shipped
2026-10-10. The GitHub channel's *live* upload needs a repository and a PAT.

| What you asked for | How it is done |
| --- | --- |
| No outbound network until I say so | At the **schema** level `webdavEnabled` and `githubEnabled` both default to `false`; the bundled `cordis.patch.yml` then sets `webdavEnabled: true` while `webdavUrl` / `webdavUsername` stay empty. An enabled channel with no target is **skipped**, not attempted — so a fresh install still packs locally and touches nothing off-machine. `dryRun: true` is the hard gate on top of that. Read the **effective** values off the panel's Overview tab rather than assuming either layer. |
| Keep the archive on disk | `persistArchive`'s **schema default** is `true`. The value that actually applies is resolved in layers (`config.json` > `cordis.patch.yml` > schema default), so read the effective value off the panel's Overview tab instead of assuming. Artifacts land **encrypted** in `$DSH_HOME/dsh-sync-backup/artifacts/`. |
| Encrypt it | Every archive goes through **AES-256-GCM** before it touches disk or network. The key is generated on first run and never leaves the machine. |
| Stop making me edit YAML | Changes made in the settings panel are written to `$DSH_HOME/dsh-sync-backup/config.json`, which **overrides** the patch file. Delete that file to fall back to defaults. |

The recovery code is **not** a second factor — it is the key itself, base32-encoded. Whoever holds it
holds every archive ever written. The panel shows it masked and reveals the plaintext only when you
click export.

Two other safety properties worth knowing before you install:

- **Upload is gated twice.** While `dryRun: true`, `sync_backup_run` with `upload: true` is refused
  outright; even once allowed, a run succeeds only after credential resolution → target resolution →
  MKCOL → PUT → read-back SHA256 all agree.
- **The settings panel cannot upload.** Its endpoints are all local operations. The only two that
  reach further are `save-config` (writes your own `config.json`) and `export-recovery-code` (hands
  *you* the key, on your click).
- **A failing channel never aborts the other one.** The result reports `partial: true`; `partialAlertAfter`
  consecutive half-successes flip the state to `needsAttention`.

---

## Install

```sh
dsh plugin gate <path-to-plugin-dir>                        # safety scan first
dsh plugin --profile desktop add link:<path-to-plugin-dir>  # local link, not the registry
# restart DSH — the Host plugin row takes effect at load
```

The link install writes into `$DSH_HOME/profiles/<profile>/`, outside most workspace sandboxes —
expect `EPERM ... package.json.lock` under a workspace-scoped file policy. That is a sandbox denial,
not a file lock. If pnpm rejects with `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`, the whole lockfile is
being policy-checked, so another dependency added within 24 h blocks this install too;
`--config.minimumReleaseAge=0` clears it.

**Roll back:** `dsh plugin --profile desktop remove dsh-sync-backup`

> The plugin must declare its peers. A `link:` install is a symlink, so the manifest has to name
> `@deepseek-ai/dsh-tools` and `@deepseek-ai/schemastery` in `peerDependencies` or the loader will not
> intercept those bare imports — the plugin then fails to load **silently**, with no state directory.
> Editing the manifest needs only a restart, not a reinstall.

---

## What gets backed up

Source root = `$DSH_HOME` (default `~/.dsh`). This is an **allowlist, not a denylist**: anything
outside it is structurally incapable of entering the archive.

| Path | Purpose |
| --- | --- |
| `AGENTS.md` | Global instructions / persona baseline |
| `dsh-auto-memory.json` | Memory plugin configuration |
| `memory/**` | **Core**: MEMORY.md, workspaces/, hub/, handoff/, semantic/ |
| `skills/**` | All skills |
| `storages/**` | Includes `schedule.json` scheduled tasks |
| `task-board/**` | Task board ledger + scheduler |
| `dsh-config-manager/sync/*.json` | **Top-level `*.json` only** — see the trap below |
| `sessions/**` | Session logs (can be turned off) |

> ⚠️ **Trap: never recurse `dsh-config-manager/sync/`.** That directory holds hundreds of historical
> snapshot subdirectories; listing it as a `dir` entry inflates the payload roughly threefold. It must
> be collected with `kind: "glob"` and `pattern: /^[^\\/]+\.json$/`.

**Explicitly excluded:** `.credentials.yaml` (plaintext credential container — never leaves the
machine), `profiles/**` (~1.3 GiB), `web-login/**`, `dsh-runtimes/**`, `models/**`,
`speech-to-text/**`, `dsh-config-manager/exports/**`, `subagent-gc-backup/**`.

File counts drift as `sessions/` keeps being written, so verify against a live value rather than
asserting a fixed number. A real upload measured 267 files / 21.01 MB → gzip 15.46 MB.

---

## Credential slots

Secrets are never stored in the patch file, in this repository, or in the state file. They live in the
DSH credential layer: `$DSH_HOME/.credentials.yaml`, in the `refs:` block.

| | |
| --- | --- |
| **WebDAV slot** | `DSH_SYNC_BACKUP_WEBDAV_PASSWORD` — plugin-owned, no fallback |
| **GitHub slot** | `DSH_SYNC_BACKUP_GITHUB_TOKEN` — no fallback (a missing token skips the channel) |

Never paste a token into a command line — it lands in shell history and the process table. Use the
bundled helpers, which read from an environment variable or a hidden prompt and write the `refs:`
block with a backup plus atomic replace. Both support `--check` (read-only status), `--dry-run`
(line-level preview), `--verify` (prove it works), and `--remove`:

```sh
# hidden interactive input — recommended; never echoed, never in shell history
node tools/set-github-token.mjs --verify
node tools/set-webdav-password.mjs --verify

# or from an environment variable you exported yourself
$env:DSH_SYNC_BACKUP_GITHUB_TOKEN = "..."
node tools/set-github-token.mjs --from-env --verify
```

Both report only the **type and length** of a value, never the value. The panel never renders or
stores a password either — forgetting one costs nothing, just re-run the script.

Fine-grained PAT (recommended): scope it to the single repository with **Contents: Read and write**
and nothing else. A classic PAT needs the `repo` scope.

---

## Configuration

| Where | Who writes it | What it is for |
| --- | --- | --- |
| `cordis.patch.yml` | You | **Factory defaults**. Read once at load; changing it needs a restart. |
| `$DSH_HOME/dsh-sync-backup/config.json` | The settings panel | **Per-machine overrides**. Written on save, applied live, no restart. Wins when present. |

You do not need to touch either file to use the plugin. Delete `config.json` to return to factory
defaults. The merge uses `??` rather than `||` — with `||` there would be no way for an override to say
`false`, `0`, or `""`, because they would be indistinguishable from absent.

Key settings: `enabled`, `intervalHours` (12), `remoteIntervalHours` (0 = sync after every local pack),
`keepLast` (7), `persistArchive` (schema default true; patch/config can override), `localKeepDays` (7), `restoreCheck` (false), `selectedPaths`
(empty = everything except `profiles`), `dryRun` (**true** — the upload gate; schema default, patch keeps it),
`webdavEnabled` (schema default `false`, patch sets `true`; a channel with no target is skipped) /
`webdavUrl` / `webdavUsername` / `webdavPath`, `githubEnabled` / `githubRepo` / `githubPath`,
`uploadOnSchedule` (false). The full list is in `cordis.patch.yml`.

A scheduled upload happens **only** when `uploadOnSchedule: true` **and** `dryRun: false`. Flipping
either is a write-class action — confirm before doing it.

---

## Architecture

```
index.js          Host half: Config + apply, 2 tools, prompt section, scheduler, settings RPC channel
cordis.patch.yml  bundle patch row (row id must byte-match `export const name`)
lib/client.js     Client half: the settings panel (source-as-product, no build)
lib/collect.js    allowlist collection + structural forbidden-path assertions
lib/archive.js    hand-written USTAR writer + gzip (zero dependencies)
lib/crypto.js     AES-256-GCM envelope; lib/keyring.js owns the key and recovery code
lib/webdav.js     WebDAV client; lib/github.js GitHub contents API client
lib/artifacts.js  local artifact listing + pruning; lib/restore-check.js pre-restore verification
lib/scheduler.js  self-rescheduling timers with exponential backoff
lib/user-config.js  config.json allowlist + per-key validation
tools/            verification suites and the two credential helpers
```

| Design decision | Reason |
| --- | --- |
| Hand-written USTAR instead of the `tar` package | 45 of 259 paths exceed the 100-byte USTAR `name` field, up to 158 bytes; they need `name` + `prefix` splitting. Zero dependencies also keeps the observable attack surface small. |
| `peerDependencies` declared but no `dependencies` | Required by the loader for `link:` installs (see Install). Nothing is installed from them. |
| The panel asks for confirmation before saving `webdavUrl` / `webdavUsername` / `githubRepo` | Those three change *where data goes*; everything else is a quantity or a schedule. Friction belongs where a misclick becomes an exfiltration. |

### Settings panel

`lib/client.js` adds a **Backup & Sync** section, registered through
`ctx.slots.inject("settings.section", …)` with `id: "sync-backup"` and `inject: () => ({ rpcCall })`.
Transport is the official Connection RPC — no custom `/api` routes, no bundler, and the bundle only
ever does `require("react")`.

| Tab | Contents |
| --- | --- |
| Overview | health bar · run state · payload · **周期与保留 (editable)** · recovery code |
| Artifacts | local encrypted archives, remote copies per channel, prune action |
| Channels | controlled form: WebDAV enable/url/user/path, GitHub enable/repo/path |
| Environment | per-folder inventory with local sizes and risk badges · restore check |

Edit mode reads values straight from the host's `view` rather than a snapshot taken at mount, and only
the keys that actually changed are sent. Numeric inputs convert with `Number()` — the DOM always hands
back a string, and passing it through makes Save look inert.

### Tools (Host half)

| Tool | Behaviour |
| --- | --- |
| `sync_backup_run` | Defaults to dry-run: pack + verify, no network. `upload: true` uploads and verifies by reading back the SHA256; refused while `dryRun: true`. |
| `sync_backup_status` | Loaded state, last result, per-channel id/SHA256/retained count, effective settings, next planned run. |

> **Why tool outputs are built by omitting keys.** Host validates every tool return value twice, and the
> two gates disagree about absent data: `snapshotJsonValue` rejects `undefined` anywhere
> (`value is not lossless JSON`), while the declared schema rejects a `null` where an `object` or
> `string` is expected. **The only legal encoding of "no value" is an absent key.** This cost one
> real-Host failure that every offline suite had passed.

---

## Local verification

```sh
npm test              # everything below, in sequence
npm run dry-run:full  # full pack + per-file SHA256 comparison on extraction
```

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

---

## Known limitations

- No cloud-side retention pruning yet beyond `keepLast`; old remote snapshots must be removed manually.
- `restore-check` proves an archive *can* be restored; there is no one-click restore.
- The GitHub channel is exercised only against fake transports — no live upload has been performed.

## License

MIT — see [LICENSE](LICENSE).
