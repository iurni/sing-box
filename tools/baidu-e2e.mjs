#!/usr/bin/env node
// Exercise the compiled core through its mixed inbound using loopback fixtures only.
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const binary = process.argv[2] && resolve(process.argv[2]);
if (!binary || process.argv.length !== 3) throw new Error('Usage: node tools/baidu-e2e.mjs <compiled-sing-box>');
const temporary = await mkdtemp(join(tmpdir(), 'baidu-loopback-'));
const sockets = new Set();
const servers = [];
let child, logs = '', childError;
function track(socket) {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
  socket.on('error', () => {});
  return socket;
}
async function listen(handler) {
  const server = net.createServer(socket => handler(track(socket)));
  servers.push(server);
  await new Promise((accept, reject) => server.listen(0, '127.0.0.1', accept).once('error', reject));
  return server.address().port;
}
async function unusedPort() {
  const server = net.createServer();
  await new Promise(accept => server.listen(0, '127.0.0.1', accept));
  const port = server.address().port;
  await new Promise(accept => server.close(accept));
  return port;
}
function readUntil(socket, delimiter) {
  return new Promise((accept, reject) => {
    let buffered = Buffer.alloc(0);
    const timer = setTimeout(() => finish(new Error('Loopback read timeout')), 5000);
    const onData = chunk => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length > 65536) finish(new Error('Unexpected fixture response size'));
      else if (buffered.includes(delimiter)) finish(null, buffered);
    };
    const onClose = () => finish(new Error('Connection closed before fixture response'));
    function finish(error, value) {
      clearTimeout(timer);
      socket.off('data', onData); socket.off('error', finish); socket.off('close', onClose);
      error ? reject(error) : accept(value);
    }
    socket.on('data', onData); socket.once('error', finish); socket.once('close', onClose);
  });
}
async function request(port, destination, expectedGreeting, payload, expectedReply) {
  const socket = track(net.connect({ host: '127.0.0.1', port }));
  const greeting = readUntil(socket, Buffer.from(expectedGreeting));
  socket.write(`CONNECT ${destination} HTTP/1.1\r\nHost: ${destination}\r\n\r\n`);
  const response = (await greeting).toString();
  assert.match(response, /^HTTP\/1\.1 200 /);
  assert.ok(response.endsWith(expectedGreeting), 'Tunneled greeting is preserved after CONNECT');
  const reply = readUntil(socket, Buffer.from(expectedReply));
  socket.write(payload);
  assert.equal((await reply).toString(), expectedReply);
  socket.destroy();
}

try {
  const requests = [];
  const echoPort = await listen(socket => {
    socket.write('fallback-ready\n');
    socket.on('data', chunk => socket.write(`fallback:${chunk}`));
  });
  const gatewayPort = await listen(socket => {
    let buffered = '';
    function onHeader(chunk) {
      buffered += chunk.toString();
      if (!buffered.includes('\r\n\r\n')) return;
      socket.off('data', onHeader);
      requests.push(buffered);
      if (buffered.startsWith(`CONNECT 127.0.0.1:${echoPort} `)) {
        socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
      } else {
        // Header and tunnel greeting intentionally share one write.
        socket.write('HTTP/1.1 200 Connection established\r\n\r\ngateway-ready\n');
        socket.on('data', chunk => socket.write(`gateway:${chunk}`));
      }
    }
    socket.on('data', onHeader);
  });
  const mixedPort = await unusedPort();
  const config = join(temporary, 'loopback.json');
  await writeFile(config, JSON.stringify({
    log: { level: 'error' },
    inbounds: [{ type: 'mixed', tag: 'test-in', listen: '127.0.0.1', listen_port: mixedPort }],
    outbounds: [
      { type: 'baidu', tag: 'baidu-test', server: '127.0.0.1', server_port: gatewayPort,
        secret: 'dummy-fixture-secret', host: 'fixture.invalid:443', user_agent: 'local-test-agent',
        fallback: 'direct', fallback_host_ttl: 300 },
      { type: 'direct', tag: 'direct' },
    ],
    route: { final: 'baidu-test' },
  }));
  child = spawn(binary, ['run', '-c', config], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  child.on('error', error => { childError = error; });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { logs = (logs + chunk).slice(-16000); });
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (childError || child.exitCode !== null) throw childError || new Error(`Core stopped before ready: ${logs}`);
    ready = await new Promise(accept => {
      const probe = track(net.connect({ host: '127.0.0.1', port: mixedPort }));
      probe.once('connect', () => { probe.destroy(); accept(true); });
      probe.once('error', () => accept(false));
    });
    if (ready) break;
    await delay(50);
  }
  assert.ok(ready, 'Core mixed inbound started');
  await request(mixedPort, 'target.invalid:443', 'gateway-ready\n', 'ping\n', 'gateway:ping\n');
  assert.equal(requests[0], 'CONNECT target.invalid:443 HTTP/1.1\r\nHost: fixture.invalid:443\r\nUser-Agent: local-test-agent\r\nX-T5-Auth: dummy-fixture-secret\r\n\r\n');
  await request(mixedPort, `127.0.0.1:${echoPort}`, 'fallback-ready\n', 'one\n', 'fallback:one\n');
  assert.equal(requests.length, 2, '403 triggered one gateway attempt before fallback');
  await request(mixedPort, `127.0.0.1:${echoPort}`, 'fallback-ready\n', 'two\n', 'fallback:two\n');
  assert.equal(requests.length, 2, 'Remembered destination skipped gateway and used fallback');
  console.log('Compiled core loopback E2E passed: exact request, buffered tunnel data, bidirectional transfer, 403 fallback and cache.');
} finally {
  if (child && child.exitCode === null && !childError) {
    const exited = new Promise(accept => child.once('exit', accept));
    child.kill();
    await Promise.race([exited, delay(5000).then(() => child.kill('SIGKILL'))]);
  }
  for (const socket of sockets) socket.destroy();
  await Promise.all(servers.map(server => new Promise(accept => server.close(accept))));
  await rm(temporary, { recursive: true, force: true });
}
