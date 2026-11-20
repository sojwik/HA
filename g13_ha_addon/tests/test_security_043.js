'use strict';
/* 0.4.3: weryfikacja poprawek bezpieczeństwa, CSP nonce, auth fail-closed,
 * ETag/If-Match w KV, walidacji kluczy, XSS i kompletnego btnReset. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const { once } = require('events');

const APP_DIR = path.resolve(__dirname, '../app');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'g13-sec043-'));
const procs = [];
let pass = 0, fail = 0;

async function test(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.error('  ✗ ' + name + '\n      ' + (e && e.stack ? e.stack : e)); fail++; }
}

async function freePort() {
  const s = net.createServer();
  s.listen(0, '127.0.0.1');
  await once(s, 'listening');
  const p = s.address().port;
  await new Promise(r => s.close(r));
  return p;
}

async function startServer(optsObj, extraEnv = {}) {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(TMP, 'srv-'));
  const optFile = path.join(dir, 'options.json');
  fs.writeFileSync(optFile, JSON.stringify(optsObj));
  let log = '';
  const p = spawn(process.execPath, ['server.js'], {
    cwd: APP_DIR,
    env: Object.assign({}, process.env, {
      PORT: String(port),
      DATA_DIR: dir,
      OPTIONS_FILE: optFile,
      ADDON_TOKEN: '',
    }, extraEnv),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  procs.push(p);
  p.stdout.on('data', d => { log += d; });
  p.stderr.on('data', d => { log += d; });
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch('http://127.0.0.1:' + port + '/api/health');
      if (r.status) return { port, base: 'http://127.0.0.1:' + port, dir, proc: p, log: () => log };
    } catch (_) {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('Serwer nie wystartował: ' + log);
}

(async () => {
  console.log('\n=== 0.4.3: bezpieczeństwo, CSP, auth fail-closed, KV ETag i XSS ===');

  const sOpen = await startServer({ require_auth: false, growatt_entities: [] });

  await test('SEC01 CSP usuwa unsafe-inline ze script-src i nadaje losowy nonce', async () => {
    const r1 = await fetch(sOpen.base + '/');
    const r2 = await fetch(sOpen.base + '/');
    const csp1 = r1.headers.get('content-security-policy') || '';
    const csp2 = r2.headers.get('content-security-policy') || '';
    const html1 = await r1.text();
    const m1 = csp1.match(/script-src 'self' 'nonce-([^']+)'/);
    const m2 = csp2.match(/script-src 'self' 'nonce-([^']+)'/);
    assert.ok(m1 && m2, 'brak nonce w CSP: ' + csp1);
    assert.notStrictEqual(m1[1], m2[1], 'nonce musi być losowy per żądanie');
    assert.ok(!/script-src[^;]*unsafe-inline/.test(csp1), 'unsafe-inline nie może być w script-src');
    assert.ok(html1.includes('<script nonce="' + m1[1] + '">'), 'skrypty inline muszą otrzymać nonce');
    assert.ok(!html1.includes('fonts.googleapis.com'), 'brak zewnętrznych Google Fonts');
  });

  await test('SEC02 KV odrzuca niebezpieczne nazwy kluczy (400)', async () => {
    for (const bad of ['__proto__', 'constructor', 'prototype', 'a..b', 'bad key', 'x<script>']) {
      const r = await fetch(sOpen.base + '/api/kv/' + encodeURIComponent(bad), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: '1' }),
      });
      assert.strictEqual(r.status, 400, 'klucz ' + bad + ' powinien zwrócić 400, otrzymano ' + r.status);
    }
  });

  await test('SEC03 KV ETag i optymistyczna blokada If-Match (409)', async () => {
    const r0 = await fetch(sOpen.base + '/api/kv/monthly-ledger');
    assert.strictEqual(r0.status, 404);
    const absentTag = r0.headers.get('etag');
    assert.strictEqual(absentTag, '"ABSENT"');

    const r1 = await fetch(sOpen.base + '/api/kv/monthly-ledger', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'If-Match': absentTag },
      body: JSON.stringify({ value: '{"months":{"2026-09":{"kwh":10}}}' }),
    });
    assert.strictEqual(r1.status, 200);
    const tag1 = r1.headers.get('etag');
    assert.ok(tag1 && tag1 !== absentTag);

    const rConflict = await fetch(sOpen.base + '/api/kv/monthly-ledger', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'If-Match': absentTag },
      body: JSON.stringify({ value: '{"months":{}}' }),
    });
    assert.strictEqual(rConflict.status, 409, 'stary If-Match musi zwrócić 409');
    assert.strictEqual(rConflict.headers.get('etag'), tag1);

    const r2 = await fetch(sOpen.base + '/api/kv/monthly-ledger', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'If-Match': tag1 },
      body: JSON.stringify({ value: '{"months":{"2026-09":{"kwh":20}}}' }),
    });
    assert.strictEqual(r2.status, 200);
    assert.strictEqual((await (await fetch(sOpen.base + '/api/kv/monthly-ledger')).json()).value, '{"months":{"2026-09":{"kwh":20}}}');
  });

  await test('SEC04 uprawnienia kv-store.json to 0o600 na systemach POSIX', () => {
    if (process.platform === 'win32') return;
    const mode = fs.statSync(path.join(sOpen.dir, 'kv-store.json')).mode & 0o777;
    assert.strictEqual(mode, 0o600, 'oczekiwano 0600, otrzymano 0' + mode.toString(8));
  });

  await test('SEC05 require_auth=true bez ADDON_TOKEN blokuje dostęp (503 fail-closed)', async () => {
    const sMis = await startServer({ require_auth: true, growatt_entities: [] }, { ADDON_TOKEN: '' });
    assert.strictEqual((await fetch(sMis.base + '/api/health')).status, 200);
    const r = await fetch(sMis.base + '/api/config');
    assert.strictEqual(r.status, 503);
    assert.strictEqual((await r.json()).error, 'auth_misconfigured');
    assert.ok(sMis.log().includes('fail-closed'));
  });

  await test('SEC06 require_auth=true z ADDON_TOKEN weryfikuje nagłówek X-Addon-Token', async () => {
    const sAuth = await startServer({ require_auth: true, growatt_entities: [] }, { ADDON_TOKEN: 'sekret-043' });
    assert.strictEqual((await fetch(sAuth.base + '/api/health')).status, 200);
    assert.strictEqual((await fetch(sAuth.base + '/api/config')).status, 401);
    assert.strictEqual((await fetch(sAuth.base + '/api/config', { headers: { 'X-Addon-Token': 'zly' } })).status, 401);
    assert.strictEqual((await fetch(sAuth.base + '/api/config', { headers: { 'X-Addon-Token': 'sekret-043' } })).status, 200);
  });

  await test('SEC07 statyczna kontrola escapowania XSS i btnReset w index.html', () => {
    const html = fs.readFileSync(path.join(APP_DIR, 'public/index.html'), 'utf8');
    assert.ok(!html.includes('fonts.googleapis.com'), 'brak Google Fonts');
    assert.ok(html.includes('const safeKey = V.escapeHtml(r.key);'), 'r.key musi być escapowane');
    assert.ok(html.includes("V.escapeHtml(formatMonthLabel(r.key))"), 'formatMonthLabel(r.key) musi być escapowane');
    assert.ok(html.includes("V.escapeHtml(formatMonthLabel(mk))"), 'formatMonthLabel(mk) musi być escapowane');
    assert.ok(html.includes("window.storage.delete('ami-v1-meter')"), 'btnReset musi usuwać ami-v1-meter');
    assert.ok(html.includes("'ha-hourly-'"), 'btnReset musi usuwać ha-hourly-*');
    assert.ok(html.includes("ifMatch: expected"), 'saveState musi wysyłać If-Match dla monthly-ledger');
  });

  await test('SEC08 ha-ws ustawia jawny maxPayload', () => {
    const src = fs.readFileSync(path.join(APP_DIR, 'lib/ha-ws.js'), 'utf8');
    assert.ok(/maxPayload\s*:\s*16\s*\*\s*1024\s*\*\s*1024/.test(src));
  });

  await test('SEC09 ami-store zwraca ledgerEtag po skutecznym zapisie', () => {
    const src = fs.readFileSync(path.join(APP_DIR, 'lib/ami-store.js'), 'utf8');
    assert.ok(src.includes("ledgerEtag:kv.etagOf(all['monthly-ledger'])"));
  });

  for (const p of procs) { try { p.kill('SIGTERM'); } catch (_) {} }
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log('\nBezpieczeństwo 0.4.3: ' + pass + ' przeszło, ' + fail + ' nie przeszło');
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error(e);
  for (const p of procs) { try { p.kill('SIGKILL'); } catch (_) {} }
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(1);
});
