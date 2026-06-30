// Diagnostic / reproduction tests for the reported flakiness:
//   "some users can connect, others can't; it drops connections and does not reconnect."
//
// These drive the REAL server over ws and probe the connect/reconnect paths the
// existing lifecycle suite does not cover. They are evidence first: a pass tells us
// the backend honours that path, a failure pins a backend root cause.

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

type BrokerMessage = { type: string;[key: string]: unknown };

type ServerHandle = {
    port: number;
    process: ChildProcessWithoutNullStreams;
    getOutput: () => string;
};

type AuthParams = { sub: string; workspaceId: string; username: string; role: UserRole };

let ticketCounter = 0;

async function getFreePort(): Promise<number> {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address() as AddressInfo;
    const port = address.port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return port;
}

async function startServer(heartbeatIntervalMs = 5_000): Promise<ServerHandle> {
    const port = await getFreePort();
    const child = spawn(process.execPath, [tsxCliPath, 'server.ts'], {
        cwd: repoRoot,
        env: {
            ...process.env,
            PORT: String(port),
            NODE_ENV: 'development',
            NEXT_TELEMETRY_DISABLED: '1',
            COLAB_JOIN_TOKEN_SECRET: 'lifecycle-test-secret',
            COLAB_AUTH_TIMEOUT_MS: '1000',
            COLAB_HEARTBEAT_INTERVAL_MS: String(heartbeatIntervalMs),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    child.stdout.on('data', (c: Buffer) => { output += c.toString(); });
    child.stderr.on('data', (c: Buffer) => { output += c.toString(); });

    await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Timed out starting server. Output:\n${output}`)), 20_000);
        const onData = () => {
            if (!output.includes('WebSocket server is ready')) return;
            cleanup();
            resolve();
        };
        const onExit = (code: number | null) => { cleanup(); reject(new Error(`Server exited (code=${code}). Output:\n${output}`)); };
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

    return { port, process: child, getOutput: () => output };
}

async function stopServer(server: ServerHandle): Promise<void> {
    if (server.process.exitCode !== null) return;
    server.process.kill('SIGTERM');
    await Promise.race([once(server.process, 'exit'), new Promise((r) => setTimeout(r, 5_000))]);
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
        .setJti(`repro-ticket-${ticketCounter}-${params.sub}`)
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
            const i = this.waiters.findIndex((w) => w.predicate(message));
            if (i === -1) return;
            const [w] = this.waiters.splice(i, 1);
            clearTimeout(w.timer);
            w.resolve(message);
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

    send(message: Record<string, unknown>): void { this.ws.send(JSON.stringify(message)); }

    sendAuthWithToken(token: string, params: AuthParams): Promise<BrokerMessage> {
        const settled = this.nextEither(
            (m) => m.type === 'auth_success',
            (m) => m.type === 'error',
        );
        this.send({ type: 'auth', token, workspace: params.workspaceId, userId: params.sub, username: params.username });
        return settled;
    }

    async auth(params: AuthParams): Promise<BrokerMessage> {
        const token = await createJoinTicket(params);
        return this.sendAuthWithToken(token, params);
    }

    nextEither(a: (m: BrokerMessage) => boolean, b: (m: BrokerMessage) => boolean, timeoutMs = 4_000): Promise<BrokerMessage> {
        const predicate = (m: BrokerMessage) => a(m) || b(m);
        const queued = this.messages.find(predicate);
        if (queued) return Promise.resolve(queued);
        return new Promise<BrokerMessage>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`Timed out. Seen: ${JSON.stringify(this.messages)}`)), timeoutMs);
            this.waiters.push({ predicate, resolve, timer });
        });
    }

    nextMessage(predicate: (m: BrokerMessage) => boolean, timeoutMs = 4_000): Promise<BrokerMessage> {
        const queued = this.messages.find(predicate);
        if (queued) return Promise.resolve(queued);
        return new Promise<BrokerMessage>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`Timed out. Seen: ${JSON.stringify(this.messages)}`)), timeoutMs);
            this.waiters.push({ predicate, resolve, timer });
        });
    }

    rawClose(code?: number, reason?: string): void { this.ws.close(code, reason); }

    // Simulate an abrupt network drop (no close handshake / close frame).
    terminate(): void { this.ws.terminate(); }

    async dispose(): Promise<void> {
        if (this.ws.readyState === WebSocket.CLOSED) return;
        this.ws.close();
        await once(this.ws, 'close');
    }
}

async function workspaceUserCount(port: number, workspaceId: string): Promise<number> {
    const res = await fetch(`http://127.0.0.1:${port}/workspace/${encodeURIComponent(workspaceId)}`);
    if (res.status === 404) return 0;
    const body = (await res.json()) as { userCount?: number };
    return typeof body.userCount === 'number' ? body.userCount : 0;
}

// PROBE 1: After a drop, a fresh ticket reconnect must succeed.
test('a dropped user can reconnect with a fresh join ticket', async (t) => {
    const server = await startServer();
    t.after(() => stopServer(server));

    const first = await TestClient.connect(server.port);
    const a1 = await first.auth({ sub: 'u-recon', workspaceId: 'ws-recon', username: 'Recon', role: 'STUDENT' });
    assert.equal(a1.type, 'auth_success');

    first.terminate();
    await first.dispose().catch(() => undefined);

    const second = await TestClient.connect(server.port);
    t.after(() => second.dispose().catch(() => undefined));
    const a2 = await second.auth({ sub: 'u-recon', workspaceId: 'ws-recon', username: 'Recon', role: 'STUDENT' });
    assert.equal(a2.type, 'auth_success', `reconnect rejected: ${JSON.stringify(a2)}`);
});

// PROBE 2: Page-reload path reuses the SAME ticket. Must be accepted (same user+workspace).
test('a dropped user can reconnect by reusing the same join ticket', async (t) => {
    const server = await startServer();
    t.after(() => stopServer(server));

    const params: AuthParams = { sub: 'u-reuse', workspaceId: 'ws-reuse', username: 'Reuse', role: 'STUDENT' };
    const token = await createJoinTicket(params);

    const first = await TestClient.connect(server.port);
    const a1 = await first.sendAuthWithToken(token, params);
    assert.equal(a1.type, 'auth_success');
    first.terminate();
    await first.dispose().catch(() => undefined);

    const second = await TestClient.connect(server.port);
    t.after(() => second.dispose().catch(() => undefined));
    const a2 = await second.sendAuthWithToken(token, params);
    assert.equal(a2.type, 'auth_success', `same-ticket reconnect rejected: ${JSON.stringify(a2)}`);
});

// PROBE 3: Two users connecting concurrently to one workspace both authenticate and see each other.
test('two users connecting concurrently to one workspace both authenticate', async (t) => {
    const server = await startServer();
    t.after(() => stopServer(server));

    const a = await TestClient.connect(server.port);
    const b = await TestClient.connect(server.port);
    t.after(() => Promise.allSettled([a.dispose(), b.dispose()]));

    const [ra, rb] = await Promise.all([
        a.auth({ sub: 'u-a', workspaceId: 'ws-concurrent', username: 'Aaa', role: 'STUDENT' }),
        b.auth({ sub: 'u-b', workspaceId: 'ws-concurrent', username: 'Bbb', role: 'STUDENT' }),
    ]);
    assert.equal(ra.type, 'auth_success', `user A failed: ${JSON.stringify(ra)}`);
    assert.equal(rb.type, 'auth_success', `user B failed: ${JSON.stringify(rb)}`);

    // Whoever joined first must observe the other's user_joined.
    await a.nextMessage((m) => m.type === 'user_joined' && m.userId === 'u-b').catch(async () => {
        await b.nextMessage((m) => m.type === 'user_joined' && m.userId === 'u-a');
    });
});

// PROBE 4: Closing during the auth await must not leave a ghost session in the room.
test('closing during auth does not leave a ghost session in the workspace', async (t) => {
    const server = await startServer();
    t.after(() => stopServer(server));

    // Fire auth then immediately close, racing the server's `await verifyJoinTicket`.
    for (let i = 0; i < 8; i += 1) {
        const ghost = await TestClient.connect(server.port);
        const params: AuthParams = { sub: `ghost-${i}`, workspaceId: 'ws-ghost', username: `Ghost ${i}`, role: 'STUDENT' };
        const token = await createJoinTicket(params);
        ghost.send({ type: 'auth', token, workspace: params.workspaceId, userId: params.sub, username: params.username });
        // Close on the same tick as sending auth.
        ghost.rawClose(1001, 'left during auth');
        await ghost.dispose().catch(() => undefined);
    }

    // Give the server time to process any late auth continuations.
    await new Promise((r) => setTimeout(r, 300));

    // A real user joins; the room should contain only them (count === 1), no ghosts.
    const real = await TestClient.connect(server.port);
    t.after(() => real.dispose().catch(() => undefined));
    await real.auth({ sub: 'real-user', workspaceId: 'ws-ghost', username: 'Real', role: 'STUDENT' });

    const count = await workspaceUserCount(server.port, 'ws-ghost');
    assert.equal(count, 1, `expected only the real user, found ${count} (ghost sessions leaked)`);
});
