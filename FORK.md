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
the duplicate plugin ID. Do not uninstall as a workaround until a tested private
state/settings transfer and restoration procedure is available. The production
source switch is pending that procedure.

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
