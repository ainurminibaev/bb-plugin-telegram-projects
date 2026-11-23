# Personal assistant fork

Upstream: https://github.com/VKirill/bb-plugin-telegram-projects
Base: upstream tag `v0.9.0`. Upstream history and MIT license are preserved.
Fork: https://github.com/ainurminibaev/bb-plugin-telegram-projects
Development branch: `personal-assistant`.

This fork keeps the existing BB chat bindings, durable queues and agency
integration. It adds personal-assistant Telegram behavior: input reactions,
transient public progress (including direct child tasks), formatted answers,
local output attachments, visible provider failures/retry times, and incoming
large files through a local Telegram Bot API. It does not implement a second
agent runtime, project router or memory system. Those remain with BB and the
assistant's instructions.

## Installation and updates

Keep plugin ID `telegram-projects` to preserve settings and chat bindings.
For a fresh installation, install from this fork pinned to an audited commit,
not an upstream semver range:

```
bb plugin install git:https://github.com/ainurminibaev/bb-plugin-telegram-projects.git@COMMIT
```

Existing managed installs cannot currently change Git source in place: BB refuses
the duplicate plugin ID. Do not uninstall as a shortcut: it deletes settings,
secrets and schedules. The personal-assistant installation has already moved to
this fork using a separately verified private state-transfer procedure; that
completed migration does not authorize repeating removal on another installation.

Replace COMMIT with the reviewed commit hash. Do not install two copies of the
same Telegram bot poller. Back up the existing sources, bundle and BB data before
changing the source. Re-enable only after building and checking the saved bot
identity and chat binding. Do not remove/uninstall the old plugin as a migration
step: that deletes its settings and state.

No stable release is claimed yet. Upstream changes must be reviewed and merged
explicitly; an upstream update must not silently replace this fork.

## Local Bot API

The default endpoint remains `https://api.telegram.org`. Optional settings:

- `telegramApiRoot`: HTTPS endpoint or loopback HTTP origin.
- `telegramLocalRoot`: trusted local Bot API data root.
- `telegramInboxRoot`: private destination for received files.
- `projectInboxRoots`: `proj_id=/path` pairs, comma separated: received files for that project's threads go to its own inbox, the folder its agent reads under its own account (folders 0750, 2750 when the inbox has the group bit; files 0640). Other projects use `telegramInboxRoot`.
- `telegramFileHostId`: BB host holding those directories.

The server and bot-file volumes must use identical absolute paths. A receiving
thread must run on that host; mismatches are rejected. Files are streamed to disk
with size/free-space checks, SHA-256 receipts, confined paths and restricted file
permissions. File content is not inserted into the model prompt. Up to 2 GiB is
accepted by this storage layer; actual Telegram limits still apply.

For cloud-to-local transfer, disable both `enabled` and `chatEnabled`, wait for
receivers to stop (or reload while disabled), then call `prepareLocalApi` with
`{"expectedUsername":"YOUR_BOT_USERNAME","confirm":true}`. This uses the protected
token internally, verifies identity, calls cloud `logOut` and records the outcome.
An uncertain logout is not retried automatically. Configure the four local
settings before enabling receivers. CLI string settings take raw strings, not
JSON-quoted strings. Follow Telegram's official server-migration procedure and
cloud-return cooldown. The preparation method is not a local-to-local migration
or a bot-token replacement command.

## Validation and limits

Run `npm ci`, `npm run check`, `npm test`, and `bb plugin build`.
Tests cover formatting, child progress, file receipts, unsafe paths, duplicate
updates, download interruption/recovery, post-dispatch uncertainty, pending
questions and cloud-transfer identity checks. A filesystem-only 2 GB copy, a real 24 MiB Telegram delivery, and a full
2,000,000,000-byte Telegram delivery have passed. The large file was independently
hashed on the receiving host, checked again by the assistant, and acknowledged
back in Telegram; the temporary download status was deleted. A real provider-limit notification and scheduled retry were seen;
automatic post-limit recovery has not yet been accepted.

Do not silently repeat a task whose dispatch outcome is unknown. The bridge
resumes interrupted pre-dispatch downloads; it reports uncertain later outcomes.
New unbound chats still need a project/thread binding before receiving files.
Outgoing attachments retain their separate size limit. Download progress is a
transient status message, not a fabricated percentage or private model reasoning.


## Prepared personal.8 update

This version is not yet published or installed. The personal-chat overview fix
is independent of BB core. Exact child-result routing additionally requires BB
notifications to preserve `outcomes[].turnId` from the actual terminal turn,
including durable queued notices. An absent field retains legacy behavior for old BB versions. An explicit null
means no terminal turn exists and cannot inherit an earlier result. Multiple
possible results are never resolved by choosing the newest one.

Before deployment, preserve the currently installed commit, settings and state.
Use a pinned commit from this same fork and verify the installed source and
version afterwards. Do not remove the plugin, clear its database or rebind the
chat. Validate Telegram-origin failure and completion after reusing a child,
BB-origin responses remaining in BB, and duplicate-notification handling.
Rollback must preserve current chat state and restore the previous plugin code
and corresponding BB runtime files. A build or a passing unit test is not live
acceptance. The original memory and conversation archives are not part of this
plugin update.

### Roll back a channel-enabled installation to personal.15

Stop both receivers and wait for in-flight deliveries to finish. Save an ordinary private export first. Then call `exportPrivateState` with `{"confirm":true,"targetVersion":"personal.15"}`. Keep both receipt IDs and checksums privately. The second export stages the channel allowlist as a private storage row and omits the newer setting from the snapshot. personal.15 can retain this row across removal or restore it into an empty store.

Install personal.15, then call its `restorePrivateState` with the **second** receipt's ID, SHA-256 and `confirm:true`. Check the private chat binding and queues before enabling the receivers. Group and channel actions become available again after returning to the newer fork. To return, stop the receivers and export the **current** personal.15 state so that activity during the rollback is retained. Install the newer fork and restore this latest export. The newer fork reads the saved channel allowlist. A snapshot from before channels were configured restores an empty list.
