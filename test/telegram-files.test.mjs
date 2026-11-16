import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { telegramApiRoot, saveLocalTelegramFile } from '../telegram-files.ts';

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'telegram-file-test-'));
  const localRoot = join(root, 'api');
  await mkdir(localRoot);
  const sourcePath = join(localRoot, 'upload.bin');
  await writeFile(sourcePath, 'payload');
  const input = { sourcePath, localRoot, inboxRoot: join(root, 'inbox'),
    updateId: 7, fileId: 'fixture', name: 'report.txt', expectedBytes: 7,
    signal: new AbortController().signal };
  try { await run(input, root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('API root keeps cloud compatibility and allows only TLS or loopback HTTP', () => {
  assert.equal(telegramApiRoot(), 'https://api.telegram.org');
  assert.equal(telegramApiRoot('http://127.0.0.1:8081/'), 'http://127.0.0.1:8081');
  for (const invalid of ['http://example.com', 'https://user:password@example.com',
    'https://example.com/path', 'https://example.com/?token=x', 'file:///tmp', 'bad'])
    assert.throws(() => telegramApiRoot(invalid), /telegram_api_root_invalid/);
});

test('copy preserves bytes, sanitizes filename and reuses a verified complete receipt', async () => {
  await fixture(async input => {
    input.name = '../../report.txt';
    const first = await saveLocalTelegramFile(input);
    assert.equal(first.name, 'report.txt');
    assert.equal(await readFile(first.path, 'utf8'), 'payload');
    assert.equal(first.sha256, createHash('sha256').update('payload').digest('hex'));
    assert.deepEqual(await saveLocalTelegramFile(input), first);
  });
});

test('path outside local root and symlink escape are rejected', async () => {
  await fixture(async (input, root) => {
    const outside = join(root, 'private.txt');
    await writeFile(outside, 'private');
    await assert.rejects(saveLocalTelegramFile({ ...input, sourcePath: outside }), /outside_local_root/);
    const link = join(input.localRoot, 'escape');
    await symlink(outside, link);
    await assert.rejects(saveLocalTelegramFile({ ...input, sourcePath: link }), /outside_local_root/);
  });
});

test('actual size is enforced even when Telegram metadata is absent', async () => {
  await fixture(async input => {
    await assert.rejects(saveLocalTelegramFile({ ...input, expectedBytes: undefined, maxBytes: 6 }), /too_large/);
    await assert.rejects(saveLocalTelegramFile({ ...input, expectedBytes: 6 }), /size_mismatch/);
  });
});

test('cancelled copy produces no successful receipt', async () => {
  await fixture(async input => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(saveLocalTelegramFile({ ...input, signal: controller.signal }), /cancelled/);
    await assert.rejects(readdir(input.inboxRoot), { code: 'ENOENT' });
  });
});

test('same-size corruption is not accepted as a completed download', async () => {
  await fixture(async input => {
    const saved = await saveLocalTelegramFile(input);
    await writeFile(saved.path, 'changed');
    await assert.rejects(saveLocalTelegramFile(input), /cached_copy_invalid/);
  });
});

test('a filename cannot overwrite the durable receipt', async () => {
  await fixture(async input => {
    const saved = await saveLocalTelegramFile({ ...input, name: '.complete.json' });
    assert.equal(saved.name, 'file_.complete.json');
    assert.equal(await readFile(saved.path, 'utf8'), 'payload');
  });
});
