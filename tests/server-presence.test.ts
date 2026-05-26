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
const joinSecret = new TextEncoder().encode('presence-test-secret');

type BrokerMessage = {
  type: string;
  [key: string]: unknown;
};

type ServerHandle = {
  port: number;
  process: ChildProcessWithoutNullStreams;
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

async function startServer(): Promise<ServerHandle> {
  const port = await getFreePort();
  const child = spawn(process.execPath, [tsxCliPath, 'server.ts'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'development',
      NEXT_TELEMETRY_DISABLED: '1',
      COLAB_JOIN_TOKEN_SECRET: 'presence-test-secret'
    },
    stdio: ['ignore', 'pipe', 'pipe']
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

  return { port, process: child };
}

async function stopServer(server: ServerHandle): Promise<void> {
  if (server.process.exitCode !== null) {
    return;
  }

  server.process.kill('SIGTERM');
  await Promise.race([
    once(server.process, 'exit'),
    new Promise((resolve) => setTimeout(resolve, 5_000))
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
    role: params.role
  })
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
      if (waiterIndex === -1) {
        return;
      }

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

    this.send({
      type: 'auth',
      token,
      workspace: params.workspaceId,
      userId: params.sub,
      username: params.username
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

  async expectNoMessage(predicate: (message: BrokerMessage) => boolean, timeoutMs = 300): Promise<void> {
    const existing = this.messages.find(predicate);
    if (existing) {
      assert.fail(`Unexpected message: ${JSON.stringify(existing)}`);
    }

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const waiterIndex = this.waiters.findIndex((waiter) => waiter.timer === timer);
        if (waiterIndex >= 0) {
          this.waiters.splice(waiterIndex, 1);
        }
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
    if (this.ws.readyState === WebSocket.CLOSED) {
      return;
    }

    this.ws.close();
    await once(this.ws, 'close');
  }
}

function assertUserPresence(
  users: unknown,
  expected: { userId: string; role: UserRole; username: string; isOwner: boolean }
): void {
  assert.ok(Array.isArray(users));
  const user = users.find(
    (candidate): candidate is Record<string, unknown> =>
      typeof candidate === 'object' &&
      candidate !== null &&
      candidate.userId === expected.userId
  );

  assert.ok(user, `Expected user ${expected.userId} in ${JSON.stringify(users)}`);
  assert.equal(user.role, expected.role);
  assert.equal(user.username, expected.username);
  assert.equal(user.isOwner, expected.isOwner);
  assert.deepEqual(user.coords, { x: 0, y: 0 });
}

function assertRestorePermission(message: BrokerMessage, expected: boolean): void {
  const permissions = message.permissions as Record<string, unknown> | undefined;
  assert.ok(permissions, `Expected permissions on message ${JSON.stringify(message)}`);
  assert.equal(permissions.canRestoreVersions, expected);
}

test('presence broker keeps same-workspace users visible across roles', async (t) => {
  const server = await startServer();
  t.after(async () => {
    await stopServer(server);
  });

  await t.test('admin and teacher in the same workspace see each other', async (t) => {
    const workspaceId = 'workspace-admin-teacher';
    const admin = await TestClient.connect(server.port);
    const teacher = await TestClient.connect(server.port);

    t.after(async () => {
      await Promise.allSettled([admin.close(), teacher.close()]);
    });

    const adminAuth = await admin.auth({
      sub: 'admin-1',
      workspaceId,
      username: 'Admin User',
      role: 'ADMIN'
    });
    assertUserPresence(adminAuth.users, {
      userId: 'admin-1',
      role: 'ADMIN',
      username: 'Admin U.',
      isOwner: true
    });

    const adminSawTeacher = admin.nextMessage((message) => message.type === 'user_joined' && message.userId === 'teacher-1');
    const teacherAuth = await teacher.auth({
      sub: 'teacher-1',
      workspaceId,
      username: 'Teacher User',
      role: 'TEACHER'
    });

    assertUserPresence(teacherAuth.users, {
      userId: 'admin-1',
      role: 'ADMIN',
      username: 'Admin U.',
      isOwner: true
    });
    assertUserPresence(teacherAuth.users, {
      userId: 'teacher-1',
      role: 'TEACHER',
      username: 'Teacher U.',
      isOwner: false
    });

    const joined = await adminSawTeacher;
    assert.equal(joined.role, 'TEACHER');
    assert.equal(joined.username, 'Teacher U.');
    assert.deepEqual(joined.coords, { x: 0, y: 0 });
  });

  await t.test('teacher and teacher in the same workspace see each other', async (t) => {
    const workspaceId = 'workspace-teacher-teacher';
    const teacherOne = await TestClient.connect(server.port);
    const teacherTwo = await TestClient.connect(server.port);

    t.after(async () => {
      await Promise.allSettled([teacherOne.close(), teacherTwo.close()]);
    });

    await teacherOne.auth({
      sub: 'teacher-1',
      workspaceId,
      username: 'Teacher One',
      role: 'TEACHER'
    });

    const teacherOneSawJoin = teacherOne.nextMessage((message) => message.type === 'user_joined' && message.userId === 'teacher-2');
    const teacherTwoAuth = await teacherTwo.auth({
      sub: 'teacher-2',
      workspaceId,
      username: 'Teacher Two',
      role: 'TEACHER'
    });

    assertUserPresence(teacherTwoAuth.users, {
      userId: 'teacher-1',
      role: 'TEACHER',
      username: 'Teacher O.',
      isOwner: false
    });

    const joined = await teacherOneSawJoin;
    assert.equal(joined.role, 'TEACHER');
    assert.equal(joined.userId, 'teacher-2');
  });

  await t.test('student and teacher in the same workspace see each other', async (t) => {
    const workspaceId = 'workspace-student-teacher';
    const student = await TestClient.connect(server.port);
    const teacher = await TestClient.connect(server.port);

    t.after(async () => {
      await Promise.allSettled([student.close(), teacher.close()]);
    });

    await student.auth({
      sub: 'student-1',
      workspaceId,
      username: 'Student One',
      role: 'STUDENT'
    });

    const studentSawTeacher = student.nextMessage((message) => message.type === 'user_joined' && message.userId === 'teacher-1');
    const teacherAuth = await teacher.auth({
      sub: 'teacher-1',
      workspaceId,
      username: 'Teacher User',
      role: 'TEACHER'
    });

    assertUserPresence(teacherAuth.users, {
      userId: 'student-1',
      role: 'STUDENT',
      username: 'Student O.',
      isOwner: false
    });

    const joined = await studentSawTeacher;
    assert.equal(joined.role, 'TEACHER');
    assert.equal(joined.userId, 'teacher-1');
  });

  await t.test('student and student in the same workspace still works', async (t) => {
    const workspaceId = 'workspace-student-student';
    const studentOne = await TestClient.connect(server.port);
    const studentTwo = await TestClient.connect(server.port);

    t.after(async () => {
      await Promise.allSettled([studentOne.close(), studentTwo.close()]);
    });

    await studentOne.auth({
      sub: 'student-1',
      workspaceId,
      username: 'Student One',
      role: 'STUDENT'
    });

    const studentOneSawJoin = studentOne.nextMessage((message) => message.type === 'user_joined' && message.userId === 'student-2');
    const studentTwoAuth = await studentTwo.auth({
      sub: 'student-2',
      workspaceId,
      username: 'Student Two',
      role: 'STUDENT'
    });

    assertUserPresence(studentTwoAuth.users, {
      userId: 'student-1',
      role: 'STUDENT',
      username: 'Student O.',
      isOwner: false
    });

    const joined = await studentOneSawJoin;
    assert.equal(joined.role, 'STUDENT');
    assert.equal(joined.userId, 'student-2');
  });

  await t.test('different workspaces stay isolated', async (t) => {
    const workspaceA = 'workspace-a';
    const workspaceB = 'workspace-b';
    const admin = await TestClient.connect(server.port);
    const teacher = await TestClient.connect(server.port);

    t.after(async () => {
      await Promise.allSettled([admin.close(), teacher.close()]);
    });

    await admin.auth({
      sub: 'admin-1',
      workspaceId: workspaceA,
      username: 'Admin User',
      role: 'ADMIN'
    });

    const teacherAuth = await teacher.auth({
      sub: 'teacher-1',
      workspaceId: workspaceB,
      username: 'Teacher User',
      role: 'TEACHER'
    });

    assert.ok(Array.isArray(teacherAuth.users));
    assert.equal(teacherAuth.users.length, 1);
    assert.equal((teacherAuth.users[0] as Record<string, unknown>).userId, 'teacher-1');
    await admin.expectNoMessage((message) => message.type === 'user_joined' && message.userId === 'teacher-1');
  });

  await t.test('unauthorized join is rejected and not broadcast', async (t) => {
    const workspaceId = 'workspace-unauthorized';
    const student = await TestClient.connect(server.port);
    const intruder = await TestClient.connect(server.port);

    t.after(async () => {
      await Promise.allSettled([student.close(), intruder.close()]);
    });

    await student.auth({
      sub: 'student-1',
      workspaceId,
      username: 'Student User',
      role: 'STUDENT'
    });

    const errorPromise = intruder.nextMessage((message) => message.type === 'error');
    intruder.send({
      type: 'auth',
      token: 'bad-ticket',
      workspace: workspaceId,
      userId: 'intruder-1',
      username: 'Intruder User'
    });

    const errorMessage = await errorPromise;
    assert.equal(errorMessage.message, 'Invalid or expired join ticket');
    await student.expectNoMessage((message) => message.type === 'user_joined' && message.userId === 'intruder-1');
  });

  await t.test('user_left is broadcast to same-workspace participants', async (t) => {
    const workspaceId = 'workspace-leave';
    const teacher = await TestClient.connect(server.port);
    const student = await TestClient.connect(server.port);

    t.after(async () => {
      await Promise.allSettled([teacher.close(), student.close()]);
    });

    await teacher.auth({
      sub: 'teacher-1',
      workspaceId,
      username: 'Teacher User',
      role: 'TEACHER'
    });
    await student.auth({
      sub: 'student-1',
      workspaceId,
      username: 'Student User',
      role: 'STUDENT'
    });

    const leftPromise = teacher.nextMessage((message) => message.type === 'user_left' && message.userId === 'student-1');
    await student.close();
    const leftMessage = await leftPromise;
    assert.equal(leftMessage.userId, 'student-1');
  });

  await t.test('coords updates fan out to same-workspace participants regardless of role', async (t) => {
    const workspaceId = 'workspace-coords';
    const admin = await TestClient.connect(server.port);
    const teacher = await TestClient.connect(server.port);
    const outsider = await TestClient.connect(server.port);

    t.after(async () => {
      await Promise.allSettled([admin.close(), teacher.close(), outsider.close()]);
    });

    await admin.auth({
      sub: 'admin-1',
      workspaceId,
      username: 'Admin User',
      role: 'ADMIN'
    });
    await teacher.auth({
      sub: 'teacher-1',
      workspaceId,
      username: 'Teacher User',
      role: 'TEACHER'
    });
    await outsider.auth({
      sub: 'student-2',
      workspaceId: 'other-workspace',
      username: 'Student Other',
      role: 'STUDENT'
    });

    const teacherSawCoords = teacher.nextMessage((message) => message.type === 'coords_update' && message.userId === 'admin-1');
    admin.send({
      type: 'update_coords',
      coords: { x: 42, y: 24 }
    });

    const coords = await teacherSawCoords;
    assert.deepEqual(coords.coords, { x: 42, y: 24 });
    await outsider.expectNoMessage((message) => message.type === 'coords_update' && message.userId === 'admin-1');
  });
});

test('auth success includes canRestoreVersions for effective role permissions', async (t) => {
  const server = await startServer();
  t.after(async () => {
    await stopServer(server);
  });

  const workspaceId = 'workspace-restore-permissions-auth';
  const teacher = await TestClient.connect(server.port);
  const student = await TestClient.connect(server.port);

  t.after(async () => {
    await Promise.allSettled([teacher.close(), student.close()]);
  });

  const teacherAuth = await teacher.auth({
    sub: 'teacher-restore-1',
    workspaceId,
    username: 'Teacher Restore',
    role: 'TEACHER',
  });
  const studentAuth = await student.auth({
    sub: 'student-restore-1',
    workspaceId,
    username: 'Student Restore',
    role: 'STUDENT',
  });

  assertRestorePermission(teacherAuth, true);
  assertRestorePermission(studentAuth, false);
});

test('permission updates and permission lookup expose canRestoreVersions', async (t) => {
  const server = await startServer();
  t.after(async () => {
    await stopServer(server);
  });

  const workspaceId = 'workspace-restore-permissions-update';
  const teacher = await TestClient.connect(server.port);
  const student = await TestClient.connect(server.port);

  t.after(async () => {
    await Promise.allSettled([teacher.close(), student.close()]);
  });

  await teacher.auth({
    sub: 'teacher-restore-2',
    workspaceId,
    username: 'Teacher Restore',
    role: 'TEACHER',
  });
  await student.auth({
    sub: 'student-restore-2',
    workspaceId,
    username: 'Student Restore',
    role: 'STUDENT',
  });

  const studentUpdate = student.nextMessage(
    (message) => message.type === 'permissions_updated' && message.source === 'user_update'
  );
  teacher.send({
    type: 'update_user_permission',
    targetUserId: 'student-restore-2',
    permission: 'canRestoreVersions',
    value: true,
  });

  const updateMessage = await studentUpdate;
  assertRestorePermission(updateMessage, true);

  const studentTicket = await createJoinTicket({
    sub: 'student-restore-2',
    workspaceId,
    username: 'Student Restore',
    role: 'STUDENT',
  });
  const response = await fetch(`http://127.0.0.1:${server.port}/workspace/${workspaceId}/permissions`, {
    headers: {
      authorization: `Bearer ${studentTicket}`,
    },
  });
  assert.equal(response.status, 200);
  const payload = (await response.json()) as { permissions?: Record<string, unknown> };
  assert.equal(payload.permissions?.canRestoreVersions, true);
});