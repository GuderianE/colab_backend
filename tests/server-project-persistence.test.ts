import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import { createServer, type AddressInfo } from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import WebSocket from 'ws';
import type { UserRole } from '../types/collaboration';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsxCliPath = path.join(repoRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
const joinSecret = new TextEncoder().encode('persist-test-secret');
const INTERNAL_SECRET = 'persist-internal-secret';

type BrokerMessage = { type: string; [key: string]: unknown };
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

// A stub of the platform internal API: serves a seeded project for GET and records PUTs.
type PutRecord = { workspaceId: string; version: number; sharedState: unknown };
function startPlatformStub(seededProjectByWorkspace: Record<string, PutRecord>) {
  const puts: PutRecord[] = [];
  const server = http.createServer((req, res) => {
    if (req.headers['x-internal-proxy-secret'] !== INTERNAL_SECRET) {
      res.writeHead(401).end();
      return;
    }
    const url = new URL(req.url ?? '', 'http://localhost');
    if (url.pathname === '/api/collab/internal/project' && req.method === 'GET') {
      const workspaceId = url.searchParams.get('workspaceId') ?? '';
      const seeded = seededProjectByWorkspace[workspaceId];
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(seeded ?? { workspaceId, version: 0, sharedState: null }));
      return;
    }
    if (url.pathname === '/api/collab/internal/project' && req.method === 'PUT') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        try {
          puts.push(JSON.parse(body) as PutRecord);
        } catch {
          /* ignore */
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }
    // Everything else (e.g. permissions) 404s — the server treats that as "nothing persisted".
    res.writeHead(404).end();
  });
  return { server, puts };
}

async function startColabServer(stubPort: number, retentionMs: number) {
  const port = await getFreePort();
  const child = spawn(process.execPath, [tsxCliPath, 'server.ts'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'development',
      NEXT_TELEMETRY_DISABLED: '1',
      COLAB_JOIN_TOKEN_SECRET: 'persist-test-secret',
      PLATFORM_BASE_URL: `http://127.0.0.1:${stubPort}`,
      CRON_SECRET: INTERNAL_SECRET,
      COLAB_EMPTY_WORKSPACE_RETENTION_MS: String(retentionMs),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out. Output:\n${output}`)), 20_000);
    const onData = (chunk: Buffer | string) => {
      output += chunk.toString();
      if (output.includes('WebSocket server is ready')) {
        cleanup();
        resolve();
      }
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`Server exited (code=${code}). Output:\n${output}`));
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

async function stopColabServer(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  if (child.exitCode === null) {
    child.kill('SIGKILL');
    await once(child, 'exit');
  }
}

async function createJoinTicket(params: AuthParams): Promise<string> {
  ticketCounter += 1;
  return new SignJWT({ workspaceId: params.workspaceId, username: params.username, role: params.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience('colab-backend')
    .setSubject(params.sub)
    .setIssuedAt()
    .setJti(`ticket-${ticketCounter}-${params.sub}`)
    .setExpirationTime('5m')
    .sign(joinSecret);
}

function connectAndAuth(port: number, params: AuthParams): Promise<{ ws: WebSocket; authSuccess: BrokerMessage }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.once('error', reject);
    ws.once('open', async () => {
      const token = await createJoinTicket(params);
      ws.on('message', (raw) => {
        const message = JSON.parse(raw.toString()) as BrokerMessage;
        if (message.type === 'auth_success') {
          resolve({ ws, authSuccess: message });
        }
      });
      ws.send(
        JSON.stringify({ type: 'auth', token, workspace: params.workspaceId, userId: params.sub, username: params.username }),
      );
    });
  });
}

const seededProject = (workspaceId: string, version: number): PutRecord => ({
  workspaceId,
  version,
  sharedState: {
    elements: [
      {
        elementType: 'sprite',
        elementId: 'persisted-sprite',
        elementData: { id: 'persisted-sprite', name: 'Persisted' },
        version: 1,
        etag: 'e',
        firstEditedBy: 'u',
        firstEditedAt: 1,
        updatedBy: 'u',
        updatedAt: 1,
      },
    ],
    spriteMetrics: [],
    workspaceSnapshots: [],
  },
});

test('cold-hydrate: the first joiner receives the persisted project as the authoritative snapshot', async (t) => {
  const workspaceId = 'ws-cold-hydrate';
  const stub = startPlatformStub({ [workspaceId]: seededProject(workspaceId, 5) });
  await new Promise<void>((resolve) => stub.server.listen(0, '127.0.0.1', () => resolve()));
  const stubPort = (stub.server.address() as AddressInfo).port;
  const colab = await startColabServer(stubPort, 120_000);

  t.after(async () => {
    await stopColabServer(colab.process);
    await new Promise<void>((resolve) => stub.server.close(() => resolve()));
  });

  const { ws, authSuccess } = await connectAndAuth(colab.port, {
    sub: 'teacher-1',
    workspaceId,
    username: 'Teacher',
    role: 'TEACHER',
  });

  const sharedState = authSuccess.sharedState as { elements: Array<{ elementId: string }> };
  assert.equal(sharedState.elements.length, 1);
  assert.equal(sharedState.elements[0].elementId, 'persisted-sprite');
  ws.close();
});

test('flush-on-eviction: the final project is persisted when the last member leaves', async (t) => {
  const workspaceId = 'ws-flush';
  // Seed so the hydrated state is non-empty; disconnect then triggers eviction → flush PUT.
  const stub = startPlatformStub({ [workspaceId]: seededProject(workspaceId, 9) });
  await new Promise<void>((resolve) => stub.server.listen(0, '127.0.0.1', () => resolve()));
  const stubPort = (stub.server.address() as AddressInfo).port;
  const colab = await startColabServer(stubPort, 0); // evict immediately when empty

  t.after(async () => {
    await stopColabServer(colab.process);
    await new Promise<void>((resolve) => stub.server.close(() => resolve()));
  });

  const { ws } = await connectAndAuth(colab.port, {
    sub: 'teacher-1',
    workspaceId,
    username: 'Teacher',
    role: 'TEACHER',
  });
  ws.close();

  // Wait for the eviction flush to reach the stub.
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && !stub.puts.some((p) => p.workspaceId === workspaceId)) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const flushed = stub.puts.find((p) => p.workspaceId === workspaceId);
  assert.ok(flushed, `expected a flush PUT for ${workspaceId}; got ${JSON.stringify(stub.puts)}`);
  const flushedState = flushed.sharedState as { elements: Array<{ elementId: string }> };
  assert.equal(flushedState.elements[0].elementId, 'persisted-sprite');
});
