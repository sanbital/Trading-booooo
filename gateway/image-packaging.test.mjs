import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { stageEngine, STAGED_ENGINE_FILES } from './stage-engine.mjs';

const gatewayDir = dirname(fileURLToPath(import.meta.url));

// Mirror the current explicit-file Docker COPY manifest. Do not copy the whole
// checkout: that would hide runtime modules missing from the actual image.
function importImage({ omit = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gateway-image-test-'));
  try {
    const generated = join(root, 'generated');
    const image = join(root, 'image');
    mkdirSync(image);
    stageEngine({ to: generated });
    const dockerfile = readFileSync(join(gatewayDir, 'Dockerfile'), 'utf8');
    const copies = dockerfile.split(/\r?\n/).filter(line => /^COPY\s/.test(line));
    assert.ok(copies.length > 0, 'Docker COPY manifest must not be empty');
    for (const line of copies) {
      const match = /^COPY\s+([\w.-]+)\s+\.\/([\w.-]+)\s*$/.exec(line);
      assert.ok(match, `Update packaging test for unsupported COPY syntax: ${line}`);
      const [, source, destination] = match;
      if (source === omit) continue;
      copyFileSync(join(STAGED_ENGINE_FILES.includes(source) ? generated : gatewayDir, source),
        join(image, destination));
    }
    // Only load modules, never call startServer, a scheduler, a signer, or an
    // order route. The child inherits no credentials and fails on network use.
    const probe = `
      import net from 'node:net';
      import http from 'node:http';
      import https from 'node:https';
      import tls from 'node:tls';
      const deny = () => { throw Error('PACKAGING_TEST_NETWORK_FORBIDDEN'); };
      globalThis.fetch = deny;
      globalThis.WebSocket = class { constructor() { deny(); } };
      net.Socket.prototype.connect = deny;
      net.Server.prototype.listen = deny;
      http.request = http.get = https.request = https.get = tls.connect = deny;
      for (const name of ['server.mjs', 'v17-shadow-worker.mjs',
          'v17-shadow-host.mjs', 'leader-exit-r4.mjs']) {
        await import(new URL('./' + name, import.meta.url));
      }
      console.log('IMAGE_IMPORT_OK');
    `;
    return spawnSync(process.execPath, ['--input-type=module', '--eval', probe], {
      cwd: image,
      env: { SCHEDULER_ENABLED: 'false', V17_SHADOW_ENABLED: 'false', NODE_ENV: 'test' },
      encoding: 'utf8', timeout: 10000,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('Docker COPY manifest loads gateway and exit-shadow modules without checkout fallbacks', () => {
  const result = importImage();
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /IMAGE_IMPORT_OK/);
});

test('omitting account-mode module reproduces the pre-fix image startup failure', () => {
  const result = importImage({ omit: 'futures-mode-evidence.mjs' });
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ERR_MODULE_NOT_FOUND/);
  assert.match(result.stderr, /futures-mode-evidence\.mjs/);
});
