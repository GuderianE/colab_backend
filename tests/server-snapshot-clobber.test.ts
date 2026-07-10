import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type AddressInfo } from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import WebSocket from 'ws';
import type { UserRole } from '../types/collaboration';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsxCliPath = path.join(repoRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
const joinSecret = new TextEncoder().encode('snapshot-clobber-secret');

type BrokerMessage = { type: string; [key: string]: unknown };
type ServerHandle = { port: number; process: ChildProcessWithoutNullStreams };
type AuthParams = { sub: string; workspaceId: string; username: string; role: UserRole };

let ticketCounter = 0;

async function getFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const port = (address as AddressInfo).port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

async function startServer(): Promise<ServerHandle> {
  const port = await getFreePort();
  const child = spawn(process.execPath, [tsxCliPath, 'server.ts'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'development',
      NEXT_TELEMETRY_DISABLED: '1',
      COLAB_JOIN_TOKEN_SECRET: 'snapshot-clobber-secret',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  const appendOutput = (chunk: Buffer | string) => {
    output += chunk.toString();
  };
  child.stdout.on('data', appendOutput);
  child.stderr.on('data', appendOutput);

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for server start. Output:\n${output}`));
    }, 20_000);
    const onData = () => {
      if (!output.includes('WebSocket server is ready')) return;
      cleanup();
      resolve();
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`Server exited before startup (code=${code}, signal=${signal}). Output:\n${output}`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off('data', onData);
      child.stderr.off('data', onData);
      child.off('exit', onExit);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', onExit);
  });

  return { port, process: child };
}

async function stopServer(server: ServerHandle): Promise<void> {
  if (server.process.exitCode !== null) return;
  server.process.kill('SIGTERM');
  await Promise.race([once(server.process, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  if (server.process.exitCode === null) {
    server.process.kill('SIGKILL');
    await once(server.process, 'exit');
  }
}

async function createJoinTicket(params: AuthParams): Promise<string> {
  ticketCounter += 1;
  return new SignJWT({ workspaceId: params.workspaceId, username: params.username, role: params.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience('colab-backend')
    .setSubject(params.sub)
    .setIssuedAt()
    .setJti(`ticket-${ticketCounter}-${params.sub}-${params.workspaceId}`)
    .setExpirationTime('5m')
    .sign(joinSecret);
}

class TestClient {
  private readonly ws: WebSocket;
  readonly messages: BrokerMessage[] = [];
  private readonly waiters: Array<{
    predicate: (message: BrokerMessage) => boolean;
    resolve: (message: BrokerMessage) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  private constructor(ws: WebSocket) {
    this.ws = ws;
    this.ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as BrokerMessage;
      this.messages.push(message);
      const waiterIndex = this.waiters.findIndex((waiter) => waiter.predicate(message));
      if (waiterIndex === -1) return;
      const [waiter] = this.waiters.splice(waiterIndex, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    });
  }

  static async connect(port: number): Promise<TestClient> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    return new TestClient(ws);
  }

  send(message: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(message));
  }

  async auth(params: AuthParams): Promise<BrokerMessage> {
    const token = await createJoinTicket(params);
    const authSuccess = this.nextMessage((message) => message.type === 'auth_success');
    this.send({ type: 'auth', token, workspace: params.workspaceId, userId: params.sub, username: params.username });
    return authSuccess;
  }

  nextMessage(predicate: (message: BrokerMessage) => boolean, timeoutMs = 4_000): Promise<BrokerMessage> {
    const queued = this.messages.find(predicate);
    if (queued) return Promise.resolve(queued);
    return new Promise<BrokerMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        const waiterIndex = this.waiters.findIndex((waiter) => waiter.timer === timer);
        if (waiterIndex >= 0) this.waiters.splice(waiterIndex, 1);
        reject(new Error(`Timed out waiting for message. Seen: ${JSON.stringify(this.messages, null, 2)}`));
      }, timeoutMs);
      this.waiters.push({ predicate, resolve, reject, timer });
    });
  }

  async expectNoMessage(predicate: (message: BrokerMessage) => boolean, timeoutMs = 400): Promise<void> {
    const existing = this.messages.find(predicate);
    if (existing) assert.fail(`Unexpected message: ${JSON.stringify(existing)}`);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const waiterIndex = this.waiters.findIndex((waiter) => waiter.timer === timer);
        if (waiterIndex >= 0) this.waiters.splice(waiterIndex, 1);
        resolve();
      }, timeoutMs);
      this.waiters.push({
        predicate,
        resolve: (message) => {
          clearTimeout(timer);
          reject(new Error(`Unexpected message: ${JSON.stringify(message)}`));
        },
        reject,
        timer,
      });
    });
  }

  async close(): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) return;
    this.ws.close();
    await once(this.ws, 'close');
  }
}

// A client that never received a sprite renders it as empty; when it is touched, an EMPTY
// snapshot is emitted for that sprite. The server must never let an empty snapshot replace
// existing non-empty content — that silently destroys the real blocks for everyone. This is
// the data-loss path: a student opening an un-hydrated sprite used to wipe it for the host.
test('an empty snapshot must not overwrite an existing non-empty sprite snapshot', async (t) => {
  const server = await startServer();
  t.after(async () => {
    await stopServer(server);
  });

  const workspaceId = 'workspace-snapshot-clobber';
  const host = await TestClient.connect(server.port);
  const other = await TestClient.connect(server.port);
  t.after(async () => {
    await Promise.allSettled([host.close(), other.close()]);
  });

  await host.auth({ sub: 'host-1', workspaceId, username: 'Host User', role: 'TEACHER' });

  // Host authors the real snapshot for sprite-c (first author -> create is allowed).
  const created = host.nextMessage(
    (m) => m.type === 'workspace_snapshot_accepted' && m.spriteId === 'sprite-c',
  );
  host.send({
    type: 'workspace_snapshot',
    eventId: 'evt-host-1',
    eventType: 'workspace_snapshot',
    seq: 1,
    blockId: 'block-1',
    spriteId: 'sprite-c',
    serializedJson: JSON.stringify({ blocks: { 'block-1': { opcode: 'event_whenflagclicked' } } }),
    blocksJson: { 'block-1': { opcode: 'event_whenflagclicked' } },
  });
  await created;

  // A second participant joins but never tracked sprite-c's etag, then emits an EMPTY
  // snapshot for it with NO if-match — the exact shape of the clobber.
  await other.auth({ sub: 'other-1', workspaceId, username: 'Other User', role: 'TEACHER' });

  const outcome = other.nextMessage(
    (m) =>
      (m.type === 'conflict' && m.entityId === 'sprite-c') ||
      (m.type === 'workspace_snapshot_accepted' && m.spriteId === 'sprite-c'),
  );
  other.send({
    type: 'workspace_snapshot',
    eventId: 'evt-other-1',
    eventType: 'workspace_snapshot',
    seq: 1,
    blockId: 'block-1',
    spriteId: 'sprite-c',
    serializedJson: JSON.stringify({ blocks: {} }),
    blocksJson: {},
  });

  const result = await outcome;
  assert.equal(
    result.type,
    'conflict',
    'server must reject an unconditional overwrite of an existing snapshot, not accept it',
  );

  // And the host must never receive a broadcast that empties sprite-c.
  await host.expectNoMessage((m) => m.type === 'workspace_snapshot' && m.spriteId === 'sprite-c');
});
