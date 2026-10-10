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
holds every archive ever written. The panel shows it masked; the plaintext only appears after an
explicit confirm, then auto-hides after 60 seconds or as soon as you leave the tab (it lives in
React state only — never localStorage, never a log).

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

`lib/client.js` adds a **Backup & Sync** section to Settings, backed by the official Connection RPC
(no custom `/api` routes, no bundler; the client bundle only ever does `require("react")`). The Host
half exports two tools — `sync_backup_run` and `sync_backup_status`.

📖 **[docs/architecture.md](docs/architecture.md)** — module map, design decisions, the settings panel,
the tool contract, and the invariants that must not regress (key handling, archive parsing, index
trust, run locking).

---

## Local verification

```sh
npm test              # all offline suites + full dry-run
npm run dry-run:full  # full pack + per-file SHA256 comparison on extraction
npm run security-smoke # malicious archive / symlink / key / index fixtures
```

📖 **[docs/testing.md](docs/testing.md)** — what each suite covers, how to run `host-gates` with the
Electron binary, what CI runs, and what is deliberately left out of it.

---

## Known limitations

- **`restore-check` verifies; it does not restore.** The plugin proves an archive *can* be decrypted,
  unpacked and matched against its manifest, but there is **no write-back to `$DSH_HOME`** and no
  one-click recovery. Verification success is **not** the same as "disaster recovery is done". Manual
  recovery is: put the recovery code back, decrypt the archive, and unpack it yourself.
- Remote retention is driven by `keepLast` per channel; there is no age-based remote pruning.
- The GitHub channel is exercised only against fake transports in tests — no live upload to a real
  repository has been performed yet.
- The encryption key lives next to the archives (`$DSH_HOME/dsh-sync-backup/key.b64`, base64 not
  re-encrypted). Copying that whole directory takes the key and the archives together; encryption
  protects archives *after they leave the machine*, not against someone with read access to this one.

## License

MIT — see [LICENSE](LICENSE).
