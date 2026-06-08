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
const joinSecret = new TextEncoder().encode('lifecycle-test-secret');

type BrokerMessage = {
  type: string;
  [key: string]: unknown;
};

type ServerHandle = {
  port: number;
  process: ChildProcessWithoutNullStreams;
  getOutput: () => string;
  waitForOutput: (needle: string, timeoutMs?: number) => Promise<string>;
};

type StartServerOptions = {
  authTimeoutMs?: number;
  heartbeatIntervalMs?: number;
};

type AuthParams = {
  sub: string;
  workspaceId: string;
  username: string;
  role: UserRole;
};

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
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

  return port;
}

async function startServer(options: StartServerOptions = {}): Promise<ServerHandle> {
  const port = await getFreePort();
  const child = spawn(process.execPath, [tsxCliPath, 'server.ts'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'development',
      NEXT_TELEMETRY_DISABLED: '1',
      COLAB_JOIN_TOKEN_SECRET: 'lifecycle-test-secret',
      ...(options.authTimeoutMs !== undefined
        ? { COLAB_AUTH_TIMEOUT_MS: String(options.authTimeoutMs) }
        : {}),
      ...(options.heartbeatIntervalMs !== undefined
        ? { COLAB_HEARTBEAT_INTERVAL_MS: String(options.heartbeatIntervalMs) }
        : {}),
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
      if (!output.includes('WebSocket server is ready')) {
        return;
      }

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

  return {
    port,
    process: child,
    getOutput: () => output,
    waitForOutput: async (needle: string, timeoutMs = 4_000) => {
      if (output.includes(needle)) {
        return output;
      }

      return new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => {
          cleanup();
          reject(new Error(`Timed out waiting for output ${needle}. Output:\n${output}`));
        }, timeoutMs);

        const onData = () => {
          if (!output.includes(needle)) {
            return;
          }

          cleanup();
          resolve(output);
        };

        const cleanup = () => {
          clearTimeout(timeout);
          child.stdout.off('data', onData);
          child.stderr.off('data', onData);
        };

        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
      });
    },
  };
}

async function stopServer(server: ServerHandle): Promise<void> {
  if (server.process.exitCode !== null) {
    return;
  }

  server.process.kill('SIGTERM');
  await Promise.race([
    once(server.process, 'exit'),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);

  if (server.process.exitCode === null) {
    server.process.kill('SIGKILL');
    await once(server.process, 'exit');
  }
}

async function createJoinTicket(params: AuthParams): Promise<string> {
  ticketCounter += 1;
  return new SignJWT({
    workspaceId: params.workspaceId,
    username: params.username,
    role: params.role,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience('colab-backend')
    .setSubject(params.sub)
    .setIssuedAt()
    .setJti(`lifecycle-ticket-${ticketCounter}-${params.sub}-${params.workspaceId}`)
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
      if (waiterIndex === -1) {
        return;
      }

      const [waiter] = this.waiters.splice(waiterIndex, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    });
  }

  static async connect(port: number, options: { autoPong?: boolean } = {}): Promise<TestClient> {
    const wsOptions = options.autoPong === undefined
      ? undefined
      : ({ autoPong: options.autoPong } as ConstructorParameters<typeof WebSocket>[1]);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, wsOptions);
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

    this.send({
      type: 'auth',
      token,
      workspace: params.workspaceId,
      userId: params.sub,
      username: params.username,
    });

    return authSuccess;
  }

  nextMessage(predicate: (message: BrokerMessage) => boolean, timeoutMs = 4_000): Promise<BrokerMessage> {
    const queued = this.messages.find(predicate);
    if (queued) {
      return Promise.resolve(queued);
    }

    return new Promise<BrokerMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        const waiterIndex = this.waiters.findIndex((waiter) => waiter.timer === timer);
        if (waiterIndex >= 0) {
          this.waiters.splice(waiterIndex, 1);
        }
        reject(new Error(`Timed out waiting for message. Seen: ${JSON.stringify(this.messages, null, 2)}`));
      }, timeoutMs);

      this.waiters.push({ predicate, resolve, reject, timer });
    });
  }

  async waitForClose(timeoutMs = 4_000): Promise<{ code: number; reason: string }> {
    if (this.ws.readyState === WebSocket.CLOSED) {
      return { code: 1005, reason: '' };
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('Timed out waiting for socket close'));
      }, timeoutMs);

      const onClose = (code: number, reason: Buffer) => {
        cleanup();
        resolve({ code, reason: reason.toString('utf8') });
      };

      const cleanup = () => {
        clearTimeout(timeout);
        this.ws.off('close', onClose);
      };

      this.ws.once('close', onClose);
    });
  }

  isOpen(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }

  close(code?: number, reason?: string): void {
    this.ws.close(code, reason);
  }

  async dispose(): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) {
      return;
    }

    this.ws.close();
    await once(this.ws, 'close');
  }
}

test('unauthenticated sockets are closed after auth timeout with structured logs', async (t) => {
  const server = await startServer({ authTimeoutMs: 150, heartbeatIntervalMs: 5_000 });
  t.after(async () => {
    await stopServer(server);
  });

  const client = await TestClient.connect(server.port);
  t.after(async () => {
    await client.dispose().catch(() => undefined);
  });

  const closed = await client.waitForClose();
  assert.equal(closed.code, 4003);
  assert.equal(closed.reason, 'Auth timeout');

  const timeoutLog = await server.waitForOutput('"event":"auth_timeout_termination"');
  assert.match(timeoutLog, /"authTimeoutMs":150/);

  const closeLog = await server.waitForOutput('"event":"connection_closed"');
  assert.match(closeLog, /"code":4003/);
  assert.match(closeLog, /"reason":"Auth timeout"/);
});

test('invalid join tickets fail auth and log the failure reason', async (t) => {
  const server = await startServer({ authTimeoutMs: 500, heartbeatIntervalMs: 5_000 });
  t.after(async () => {
    await stopServer(server);
  });

  const client = await TestClient.connect(server.port);
  t.after(async () => {
    await client.dispose().catch(() => undefined);
  });

  client.send({
    type: 'auth',
    token: 'not-a-real-token',
    workspace: 'ws-invalid',
    userId: 'user-invalid',
    username: 'Invalid User',
  });

  const closed = await client.waitForClose();
  assert.equal(closed.code, 4003);
  assert.equal(closed.reason, 'Invalid join ticket');

  const output = await server.waitForOutput('"event":"auth_failure"');
  assert.match(output, /"reason":"invalid_join_ticket"/);
});

test('authenticated sockets clear the auth timeout and survive heartbeat when ponging', async (t) => {
  const server = await startServer({ authTimeoutMs: 150, heartbeatIntervalMs: 100 });
  t.after(async () => {
    await stopServer(server);
  });

  const client = await TestClient.connect(server.port);
  t.after(async () => {
    await client.dispose().catch(() => undefined);
  });

  await client.auth({
    sub: 'student-alive',
    workspaceId: 'ws-alive',
    username: 'Alive Student',
    role: 'STUDENT',
  });

  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(client.isOpen(), true);
  assert.equal(server.getOutput().includes('"event":"auth_timeout_termination"'), false);
  assert.equal(server.getOutput().includes('"event":"heartbeat_termination"'), false);
});

test('normal client close logs code and reason', async (t) => {
  const server = await startServer({ authTimeoutMs: 1_000, heartbeatIntervalMs: 5_000 });
  t.after(async () => {
    await stopServer(server);
  });

  const client = await TestClient.connect(server.port);

  await client.auth({
    sub: 'student-close',
    workspaceId: 'ws-close',
    username: 'Close Student',
    role: 'STUDENT',
  });

  client.close(1000, 'Client done');
  const closed = await client.waitForClose();
  assert.equal(closed.code, 1000);
  assert.equal(closed.reason, 'Client done');

  const output = await server.waitForOutput('"event":"connection_closed"');
  assert.match(output, /"code":1000/);
  assert.match(output, /"reason":"Client done"/);
});

test('duplicate connections are logged without changing session policy', async (t) => {
  const server = await startServer({ authTimeoutMs: 1_000, heartbeatIntervalMs: 5_000 });
  t.after(async () => {
    await stopServer(server);
  });

  const clientA = await TestClient.connect(server.port);
  const clientB = await TestClient.connect(server.port);
  t.after(async () => {
    await Promise.allSettled([clientA.dispose(), clientB.dispose()]);
  });

  await clientA.auth({
    sub: 'student-dup',
    workspaceId: 'ws-dup',
    username: 'Dup Student',
    role: 'STUDENT',
  });
  await clientB.auth({
    sub: 'student-dup',
    workspaceId: 'ws-dup',
    username: 'Dup Student',
    role: 'STUDENT',
  });

  const output = await server.waitForOutput('"event":"duplicate_connection_detected"');
  assert.match(output, /"duplicateSessionCount":2/);
});

test('heartbeat terminates authenticated sockets that stop answering protocol pings', async (t) => {
  const server = await startServer({ authTimeoutMs: 1_000, heartbeatIntervalMs: 100 });
  t.after(async () => {
    await stopServer(server);
  });

  const client = await TestClient.connect(server.port, { autoPong: false });
  t.after(async () => {
    await client.dispose().catch(() => undefined);
  });

  await client.auth({
    sub: 'student-dead',
    workspaceId: 'ws-dead',
    username: 'Dead Student',
    role: 'STUDENT',
  });

  const closed = await client.waitForClose();
  assert.equal(closed.code, 1006);

  const output = await server.waitForOutput('"event":"heartbeat_termination"');
  assert.match(output, /"heartbeatIntervalMs":100/);
});