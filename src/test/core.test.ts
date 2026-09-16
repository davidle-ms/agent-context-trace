import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { excluded, hash, isWithin, parseSession, ReadEvent, resolveFile, sliceRead, summary, TraceStore, validateInput } from '../core';

const input = { sessionId: randomUUID(), filePath: '/workspace/source.ts', startLine: 1, endLine: 3 };
const event = (startLine = 1, endLine = 10): ReadEvent => ({ id: randomUUID(), rootId: hash('root'), relativePath: 'source.ts',
    startLine, endLine, requestedEndLine: endLine, snapshotHash: hash('snapshot'), isDirty: false, at: new Date().toISOString() });

test('ranges return numbered CRLF lines, clamp EOF, preserve final empty lines', () => {
    assert.equal(sliceRead('first\r\nsecond', input).output, '1: first\n2: second');
    assert.equal(sliceRead('first\n', input).endLine, 2);
    assert.equal(sliceRead('', input).output, '1: ');
    assert.throws(() => sliceRead('first', { ...input, startLine: 2 }), /past/);
});
test('rejects invalid parameters and oversized or binary output', () => {
    for (const parameters of [{ ...input, startLine: 0 }, { ...input, endLine: 501 }, { ...input, endLine: 0 },
        { ...input, startLine: 1.5 }, { ...input, extra: true }]) { assert.throws(() => validateInput(parameters)); }
    assert.deepEqual(validateInput(input), input);
    assert.throws(() => sliceRead('x'.repeat(32000), input), /too large/);
    assert.throws(() => sliceRead('binary\0', input), /supported text/);
});
test('revision-aware interval union counts repetition without mutating inputs', () => {
    const events = [event(5, 15), event(1, 10)];
    assert.deepEqual(summary(events), { volume: 21, unique: 15, repeated: 6 });
    assert.equal(events[0]?.startLine, 5);
    assert.equal(summary([...events, { ...event(), snapshotHash: hash('edited') }]).unique, 25);
});
test('containment and exclusions reject sibling prefixes and secret paths', () => {
    const root = path.resolve('workspace');
    assert.equal(isWithin(root, `${root}-sibling/file`), false);
    assert.equal(isWithin(root, path.join(root, 'src', 'file')), true);
    for (const name of ['.env', 'src/.env.prod', '.git/config', '.npmrc', 'key.pem', '.ssh/id_ed25519', 'node_modules/index.js']) {
        assert.equal(excluded(name), true, name);
    }
    assert.equal(excluded('src/core.ts'), false);
});
test('canonical file resolution blocks external files, junction escape, directories, and secrets', async () => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'act-policy-'));
    try {
        const directory = path.join(temporary, 'workspace');
        const outside = path.join(temporary, 'outside');
        await fs.mkdir(directory); await fs.mkdir(outside);
        await fs.writeFile(path.join(directory, 'safe.txt'), 'safe');
        await fs.writeFile(path.join(directory, '.env'), 'secret');
        await fs.writeFile(path.join(outside, 'external.txt'), 'outside');
        await fs.symlink(outside, path.join(directory, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
        const roots = [{ id: hash('root'), directory: await fs.realpath(directory), name: 'workspace' }];
        assert.equal((await resolveFile(path.join(directory, 'safe.txt'), roots)).relativePath, 'safe.txt');
        for (const candidate of [outside, directory, path.join(directory, '.env'), path.join(directory, 'escape', 'external.txt')]) {
            await assert.rejects(resolveFile(candidate, roots));
        }
    } finally { await fs.rm(temporary, { recursive: true, force: true }); }
});
test('sessions serialize calls, reject stale generations, and restore metadata only', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'act-store-'));
    try {
        const store = new TraceStore(directory);
        await store.load();
        const session = await store.start('Test', [hash('root')]);
        await assert.rejects(store.start('Duplicate', [hash('root')]));
        await Promise.all([store.record(session.id, 0, event(), () => false), store.record(session.id, 0, event(5, 15), () => false)]);
        assert.equal(store.get(session.id)?.events.length, 2);
        await store.setState(session.id, 'paused');
        await store.setState(session.id, 'recording');
        await assert.rejects(store.record(session.id, 0, event(), () => false));
        await assert.rejects(store.record(session.id, 2, event(), () => true));
        const restored = new TraceStore(directory);
        assert.equal(await restored.load(), 0);
        assert.throws(() => restored.requireRecording(session.id));
        await assert.rejects(restored.delete(session.id));
        const persisted = JSON.parse(await fs.readFile(path.join(directory, `${session.id}.json`), 'utf8'));
        assert.deepEqual(Object.keys(persisted.events[0]).sort(), Object.keys(event()).sort());
        assert.throws(() => parseSession({ ...persisted, schemaVersion: 2 }));
        assert.throws(() => parseSession({ ...persisted, events: [{ ...event(), relativePath: '../secret' }] }));
        await store.setState(session.id, 'stopped');
        await store.delete(session.id);
        assert.equal(store.list().length, 0);
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
test('failed persistence never updates in-memory read history; corrupt metadata is isolated', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'act-failure-'));
    try {
        await fs.writeFile(path.join(directory, 'broken.json'), '{');
        const store = new TraceStore(directory);
        assert.equal(await store.load(), 1);
        const session = await store.start('Read', [hash('root')]);
        await fs.rm(directory, { recursive: true, force: true });
        await assert.rejects(store.record(session.id, 0, event(), () => false));
        assert.equal(store.get(session.id)?.events.length, 0);
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
});