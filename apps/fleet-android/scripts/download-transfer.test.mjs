import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../app/src/main/assets/downloads.js', import.meta.url), 'utf8').replaceAll('\r\n', '\n');

function instrument(source) {
  const start = '  document.addEventListener(\n';
  const end = '    },\n    true,\n  );\n})();';
  const owner = '  async function downloadTransfer(address, name) {\n';
  for (const boundary of [start, owner, end]) {
    assert.equal(source.split(boundary).length, 2, `Expected one source boundary: ${boundary}`);
  }
  return source.slice(0, source.indexOf(start)) + '  expose(downloadTransfer);\n})();';
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Transfer fixture did not reach its checkpoint')), 1000);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

function fixture(options = {}) {
  const effects = [];
  const messages = [];
  const checkpoints = [];
  let readIndex = 0;
  let id = 0;
  let transfer;
  const bridge = {
    postMessage(json) {
      const message = JSON.parse(json);
      messages.push(message);
      effects.push(message.operation);
      for (const checkpoint of checkpoints) checkpoint();
      if (options.post) options.post(message, acknowledge);
      else if (message.operation === 'begin') acknowledge('ready');
      else if (message.operation === 'chunk') acknowledge('continue');
    },
  };
  function acknowledge(data) {
    effects.push(`ack:${data}`);
    bridge.onmessage({ data });
  }
  const reader = {
    async read() {
      effects.push('read');
      for (const checkpoint of checkpoints) checkpoint();
      if (options.read) return options.read(readIndex++);
      const value = (options.parts ?? [])[readIndex++];
      return value === undefined ? { done: true } : { done: false, value };
    },
    async cancel() {
      effects.push('cancel');
      for (const checkpoint of checkpoints) checkpoint();
      if (options.cancel) await options.cancel();
      effects.push('cancelled');
    },
  };
  vm.runInNewContext(instrument(source), {
    machdochDownload: bridge,
    crypto: { randomUUID: () => `transfer-${++id}` },
    btoa: (value) => Buffer.from(value, 'binary').toString('base64'),
    async fetch(url, configuration) {
      effects.push('fetch');
      assert.equal(url, 'https://fleet.example/file');
      assert.deepEqual(JSON.parse(JSON.stringify(configuration)), {
        credentials: 'same-origin', mode: 'same-origin', redirect: 'error',
      });
      if (options.fetchError) throw new Error('fetch failed');
      return {
        ok: options.ok ?? true,
        headers: { get: (name) => { assert.equal(name, 'Content-Length'); return options.length ?? null; } },
        body: options.noBody ? null : { getReader: () => { effects.push('reader'); return reader; } },
      };
    },
    expose: (owner) => { transfer = owner; },
  });
  return {
    effects, messages, acknowledge,
    run: (name = 'file.bin') => transfer({ href: 'https://fleet.example/file' }, name),
    until(predicate) {
      if (predicate()) return Promise.resolve();
      const checkpoint = deferred();
      checkpoints.push(() => { if (predicate()) checkpoint.resolve(); });
      return bounded(checkpoint.promise);
    },
  };
}

function operations(fixture) {
  return fixture.messages.map((message) => message.operation);
}

test('synchronous acknowledgements preserve binary chunks, names and exact ordering', async () => {
  const parts = [Uint8Array.from({ length: 32770 }, (_, index) => index % 256), Uint8Array.of(0, 128, 255)];
  const f = fixture({ parts });
  await bounded(f.run());
  assert.deepEqual(f.messages[0], { id: 'transfer-1', operation: 'begin', url: 'https://fleet.example/file', name: 'file.bin' });
  const chunks = f.messages.filter((message) => message.operation === 'chunk');
  assert.deepEqual(chunks.map((message) => Buffer.from(message.data, 'base64').length), [32768, 2, 3]);
  assert.deepEqual(Buffer.concat(chunks.map((message) => Buffer.from(message.data, 'base64'))), Buffer.concat(parts));
  assert.deepEqual(f.effects, ['fetch', 'reader', 'begin', 'ack:ready', 'read', 'chunk', 'ack:continue', 'chunk', 'ack:continue', 'read', 'chunk', 'ack:continue', 'read', 'complete', 'cancel', 'cancelled']);
  await bounded(f.run(''));
  assert.deepEqual(f.messages.at(-2), { id: 'transfer-2', operation: 'begin', url: 'https://fleet.example/file', name: 'download' });
  assert.deepEqual(f.messages.at(-1), { id: 'transfer-2', operation: 'complete' });
});

test('delayed acknowledgements block reads and subsequent chunks; concurrent attempts are busy', async () => {
  const f = fixture({ parts: [new Uint8Array(32769)], post() {} });
  const completion = f.run();
  await f.until(() => operations(f).includes('begin'));
  assert.equal(f.effects.includes('read'), false);
  await bounded(f.run());
  assert.deepEqual(f.messages.at(-1), { id: 'busy', operation: 'busy' });
  f.acknowledge('ready');
  await f.until(() => operations(f).includes('chunk'));
  assert.equal(f.effects.filter((effect) => effect === 'read').length, 1);
  f.acknowledge('continue');
  await f.until(() => operations(f).filter((operation) => operation === 'chunk').length === 2);
  assert.equal(f.effects.filter((effect) => effect === 'read').length, 1);
  f.acknowledge('continue');
  await bounded(completion);
  assert.deepEqual(operations(f), ['begin', 'busy', 'chunk', 'chunk', 'complete']);
});

for (const phase of ['begin', 'chunk']) {
  test(`cancellation during ${phase} acknowledgement cleans up without completion`, async () => {
    const f = fixture({ parts: [Uint8Array.of(1)], post(message, ack) {
      if (message.operation === phase) ack('cancel');
      else if (message.operation === 'begin') ack('ready');
    } });
    await bounded(f.run());
    assert.deepEqual(operations(f), phase === 'begin' ? ['begin'] : ['begin', 'chunk']);
    assert.deepEqual(f.effects.slice(-2), ['cancel', 'cancelled']);
    await bounded(f.run());
    assert.equal(f.messages.some((message) => message.operation === 'busy'), false);
  });
}

test('cancellation during a pending read does not abort the read or prevent completion', async () => {
  const pending = deferred();
  const f = fixture({ read: () => pending.promise });
  const completion = f.run();
  await f.until(() => f.effects.includes('read'));
  f.acknowledge('cancel');
  assert.equal(f.effects.includes('cancel'), false);
  await bounded(f.run());
  pending.resolve({ done: true });
  await bounded(completion);
  assert.deepEqual(operations(f), ['begin', 'busy', 'complete']);
});

test('cancellation during reader cleanup keeps ownership until cleanup finishes', async () => {
  const pending = deferred();
  const f = fixture({ cancel: () => pending.promise });
  const completion = f.run();
  await f.until(() => f.effects.includes('cancel'));
  f.acknowledge('cancel');
  await bounded(f.run());
  assert.deepEqual(operations(f), ['begin', 'complete', 'busy']);
  pending.resolve();
  await bounded(completion);
  await bounded(f.run());
  assert.equal(f.messages.at(-1).operation, 'complete');
});

const limit = 512 * 1024 * 1024;
for (const length of [limit - 1, limit, limit + 1]) {
  test(`advertised size ${length} preserves the inclusive limit`, async () => {
    const f = fixture({ length: String(length) });
    await bounded(f.run());
    assert.deepEqual(operations(f), length > limit ? ['error'] : ['begin', 'complete']);
    if (length > limit) {
      assert.deepEqual(f.messages[0], { id: 'transfer-1', operation: 'error', reason: 'size' });
      assert.equal(f.effects.includes('reader'), false);
    }
  });
}

for (const extra of [0, 1]) {
  test(`accumulated size at limit plus ${extra} preserves accounting before encoding`, async () => {
    const f = fixture({ parts: [{ byteLength: limit - 1, length: 0 }, { byteLength: 1 + extra, length: 0 }] });
    await bounded(f.run());
    assert.deepEqual(operations(f), ['begin', extra ? 'error' : 'complete']);
    if (extra) assert.equal(f.messages.at(-1).reason, 'size');
    assert.deepEqual(f.effects.slice(-2), ['cancel', 'cancelled']);
  });
}

for (const [name, options, expected] of [
  ['rejected fetch', { fetchError: true }, ['error']],
  ['unsuccessful response', { ok: false }, ['error']],
  ['missing body', { noBody: true }, ['error']],
  ['read failure', { read: () => { throw new Error('read failed'); } }, ['begin', 'error']],
]) {
  test(`${name} reports network failure and permits subsequent attempts`, async () => {
    const f = fixture(options);
    await bounded(f.run());
    assert.deepEqual(operations(f), expected);
    assert.deepEqual(f.messages.at(-1), { id: 'transfer-1', operation: 'error', reason: 'network' });
    await bounded(f.run());
    assert.equal(f.messages.at(-1).id, 'transfer-2');
  });
}

test('reader cancellation failure reports an unclassified error then releases ownership', async () => {
  const f = fixture({ cancel: () => { throw new Error('cancel failed'); } });
  await bounded(f.run());
  assert.deepEqual(f.messages, [
    { id: 'transfer-1', operation: 'begin', url: 'https://fleet.example/file', name: 'file.bin' },
    { id: 'transfer-1', operation: 'complete' },
    { id: 'transfer-1', operation: 'error' },
  ]);
  assert.deepEqual(f.effects.slice(-3), ['complete', 'cancel', 'error']);
  await bounded(f.run());
  assert.equal(f.messages.at(-1).id, 'transfer-2');
});

for (const phase of ['begin', 'chunk', 'complete']) {
  test(`bridge failure posting ${phase} reports network failure before cleanup`, async () => {
    const f = fixture({ parts: [Uint8Array.of(1)], post(message, ack) {
      if (message.operation === phase) throw new Error('bridge failed');
      if (message.operation === 'begin') ack('ready');
      if (message.operation === 'chunk') ack('continue');
    } });
    await bounded(f.run());
    const expected = ['begin', 'chunk', 'complete'].slice(0, ['begin', 'chunk', 'complete'].indexOf(phase) + 1);
    assert.deepEqual(operations(f), [...expected, 'error']);
    assert.deepEqual(f.messages.at(-1), { id: 'transfer-1', operation: 'error', reason: 'network' });
    assert.deepEqual(f.effects.slice(-3), ['error', 'cancel', 'cancelled']);
    await bounded(f.run());
    assert.equal(f.messages.at(-1).id, 'transfer-2');
  });
}

test('bridge failure reporting transfer error rejects completion but cleanup releases ownership', async () => {
  const f = fixture({ read: () => { throw new Error('read failed'); }, post(message, ack) {
    if (message.operation === 'begin') ack('ready');
    if (message.operation === 'error') throw new Error('report failed');
  } });
  await assert.rejects(bounded(f.run()), /report failed/);
  assert.deepEqual(operations(f), ['begin', 'error']);
  assert.deepEqual(f.effects.slice(-3), ['error', 'cancel', 'cancelled']);
  await assert.rejects(bounded(f.run()), /report failed/);
  assert.equal(f.messages.at(-1).id, 'transfer-2');
});

test('bridge failure reporting cleanup error leaves ownership busy', async () => {
  const f = fixture({ cancel: () => { throw new Error('cancel failed'); }, post(message, ack) {
    if (message.operation === 'begin') ack('ready');
    if (message.operation === 'error') throw new Error('cleanup report failed');
  } });
  await assert.rejects(bounded(f.run()), /cleanup report failed/);
  assert.deepEqual(operations(f), ['begin', 'complete', 'error']);
  await bounded(f.run());
  assert.deepEqual(f.messages.at(-1), { id: 'busy', operation: 'busy' });
});
