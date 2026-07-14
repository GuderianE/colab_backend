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
const joinSecret = new TextEncoder().encode('replace-test-secret');

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
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
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
      COLAB_JOIN_TOKEN_SECRET: 'replace-test-secret'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let output = '';
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for server start. Output:\n${output}`)), 20_000);
    const onData = (chunk: Buffer | string) => {
      output += chunk.toString();
      if (output.includes('WebSocket server is ready')) {
        cleanup();
        resolve();
      }
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
  private readonly waiters: Array<{ predicate: (m: BrokerMessage) => boolean; resolve: (m: BrokerMessage) => void; timer: NodeJS.Timeout }> = [];

  private constructor(ws: WebSocket) {
    this.ws = ws;
    this.ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as BrokerMessage;
      this.messages.push(message);
      const idx = this.waiters.findIndex((w) => w.predicate(message));
      if (idx === -1) return;
      const [waiter] = this.waiters.splice(idx, 1);
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
    const authSuccess = this.nextMessage((m) => m.type === 'auth_success');
    this.send({ type: 'auth', token, workspace: params.workspaceId, userId: params.sub, username: params.username });
    return authSuccess;
  }

  nextMessage(predicate: (m: BrokerMessage) => boolean, timeoutMs = 4_000): Promise<BrokerMessage> {
    const queued = this.messages.find(predicate);
    if (queued) return Promise.resolve(queued);
    return new Promise<BrokerMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.timer === timer);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(new Error(`Timed out waiting for message. Seen: ${JSON.stringify(this.messages, null, 2)}`));
      }, timeoutMs);
      this.waiters.push({ predicate, resolve, timer });
    });
  }

  async expectNoMessage(predicate: (m: BrokerMessage) => boolean, timeoutMs = 400): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const existing = this.messages.find(predicate);
      if (existing) {
        reject(new Error(`Unexpected message: ${JSON.stringify(existing)}`));
        return;
      }
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.timer === timer);
        if (idx >= 0) this.waiters.splice(idx, 1);
        resolve();
      }, timeoutMs);
      this.waiters.push({
        predicate,
        resolve: () => {
          clearTimeout(timer);
          reject(new Error('Unexpected message received'));
        },
        timer
      });
    });
  }

  async close(): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) return;
    this.ws.close();
    await once(this.ws, 'close');
  }
}

function buildPayload(spriteId: string) {
  const meta = { version: 1, etag: 'e', firstEditedBy: 'u', firstEditedAt: 1, updatedBy: 'u', updatedAt: 1 };
  return {
    elements: [{ elementType: 'sprite', elementId: spriteId, elementData: { name: spriteId }, ...meta }],
    spriteMetrics: [{ spriteId, x: 0, y: 0, ...meta }],
    workspaceSnapshots: [{ spriteId, serializedJson: `{"s":"${spriteId}"}`, blocksJson: {}, ...meta }]
  };
}

test('replace_shared_state broadcasts the authoritative full state and is host-gated', async (t) => {
  const server = await startServer();
  t.after(async () => {
    await stopServer(server);
  });

  await t.test('a teacher replace broadcasts shared_state to other members and acks the sender', async (t) => {
    const workspaceId = 'ws-replace-teacher';
    const teacher = await TestClient.connect(server.port);
    const student = await TestClient.connect(server.port);
    t.after(async () => {
      await Promise.allSettled([teacher.close(), student.close()]);
    });

    await teacher.auth({ sub: 'teacher-1', workspaceId, username: 'Teacher', role: 'TEACHER' });
    await student.auth({ sub: 'student-1', workspaceId, username: 'Student', role: 'STUDENT' });

    const studentSees = student.nextMessage((m) => m.type === 'shared_state');
    const teacherAck = teacher.nextMessage((m) => m.type === 'replace_shared_state_accepted');

    teacher.send({ type: 'replace_shared_state', sharedState: buildPayload('imported-sprite') });

    const broadcast = await studentSees;
    await teacherAck;

    const sharedState = broadcast.sharedState as { elements: Array<{ elementId: string }> };
    assert.equal(sharedState.elements.length, 1);
    assert.equal(sharedState.elements[0].elementId, 'imported-sprite');
  });

  await t.test('a student replace is rejected and not broadcast', async (t) => {
    const workspaceId = 'ws-replace-student';
    const teacher = await TestClient.connect(server.port);
    const student = await TestClient.connect(server.port);
    t.after(async () => {
      await Promise.allSettled([teacher.close(), student.close()]);
    });

    await teacher.auth({ sub: 'teacher-2', workspaceId, username: 'Teacher', role: 'TEACHER' });
    await student.auth({ sub: 'student-2', workspaceId, username: 'Student', role: 'STUDENT' });

    const studentError = student.nextMessage((m) => m.type === 'error');
    const teacherSeesNothing = teacher.expectNoMessage((m) => m.type === 'shared_state');

    student.send({ type: 'replace_shared_state', sharedState: buildPayload('sneaky-sprite') });

    await studentError;
    await teacherSeesNothing;
  });
});
