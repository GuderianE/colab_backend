import http from 'node:http';
import express from 'express';
import next from 'next';
import WebSocket, { WebSocketServer } from 'ws';
import { jwtVerify, type JWTPayload } from 'jose';
import PermissionManagerBackend from './permission-manager-backend';
import type { Coordinates, PermissionSet, UserRole } from './types/collaboration';

type ClientState = {
  id: string;
  username: string;
  role: UserRole;
  ws: SocketWithCleanupFlag;
  permissions: PermissionSet;
  isOwner: boolean;
  coords?: Coordinates;
};

type SocketWithCleanupFlag = WebSocket & {
  __skipCleanup?: boolean;
};

const dev = process.env.NODE_ENV !== 'production';
const PORT = process.env.PORT || 4000;
const nextApp = next({ dev });
const handle = nextApp.getRequestHandler();

const workspaces = new Map<string, Map<string, ClientState>>();
const workspaceLocks = new Map<string, Map<string, { lockedBy: string; version: number }>>();
const workspaceCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

type WorkspaceElementState = {
  elementType: string;
  elementId: string;
  elementData: unknown;
  version: number;
  etag: string;
  firstEditedBy: string;
  firstEditedAt: number;
  updatedBy: string;
  updatedAt: number;
};

type WorkspaceSpriteMetrics = {
  spriteId: string;
  x: number;
  y: number;
  rotation?: number;
  size?: number;
  visible?: boolean;
  version: number;
  etag: string;
  firstEditedBy: string;
  firstEditedAt: number;
  updatedBy: string;
  updatedAt: number;
};

type WorkspaceSnapshotState = {
  spriteId: string;
  serializedJson: string;
  version: number;
  etag: string;
  firstEditedBy: string;
  firstEditedAt: number;
  updatedBy: string;
  updatedAt: number;
};

type WorkspaceSharedState = {
  elements: Map<string, WorkspaceElementState>;
  spriteMetrics: Map<string, WorkspaceSpriteMetrics>;
  workspaceSnapshots: Map<string, WorkspaceSnapshotState>;
};

const workspaceSharedState = new Map<string, WorkspaceSharedState>();
const permissionManager = new PermissionManagerBackend();
const EMPTY_WORKSPACE_RETENTION_MS_RAW = Number(process.env.COLAB_EMPTY_WORKSPACE_RETENTION_MS);
const EMPTY_WORKSPACE_RETENTION_MS =
  Number.isFinite(EMPTY_WORKSPACE_RETENTION_MS_RAW) && EMPTY_WORKSPACE_RETENTION_MS_RAW >= 0
    ? Math.floor(EMPTY_WORKSPACE_RETENTION_MS_RAW)
    : 120_000;

type JoinTicketPayload = JWTPayload & {
  workspaceId?: unknown;
  username?: unknown;
  role?: unknown;
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null;
};

function resolveJoinSecret(): string {
  const configured = process.env.COLAB_JOIN_TOKEN_SECRET?.trim();
  if (configured) return configured;

  const shared = process.env.CRON_SECRET?.trim();
  if (shared) return shared;

  if (process.env.NODE_ENV !== 'production') {
    return 'dev-colab-join-secret';
  }

  return '';
}

const JOIN_SECRET = resolveJoinSecret();
const joinSecretKey = JOIN_SECRET ? new TextEncoder().encode(JOIN_SECRET) : null;
if (!joinSecretKey) {
  console.error('COLAB_JOIN_TOKEN_SECRET (or CRON_SECRET) is not configured; join tickets will be rejected.');
}

const consumedTicketIds = new Map<string, number>();

function pruneConsumedTicketIds(nowSeconds: number): void {
  consumedTicketIds.forEach((expiresAt, ticketId) => {
    if (expiresAt <= nowSeconds) {
      consumedTicketIds.delete(ticketId);
    }
  });
}

async function verifyJoinTicket(token: string): Promise<{
  userId: string;
  workspaceId: string;
  username: string;
  role: UserRole;
  ticketId: string;
  expiresAt: number;
} | null> {
  if (!joinSecretKey) {
    return null;
  }

  try {
    const { payload } = await jwtVerify(token, joinSecretKey, {
      algorithms: ['HS256'],
      audience: 'colab-backend',
    });
    const typed = payload as JoinTicketPayload;
    const userId = normalizeUserId(payload.sub);
    const workspaceId = normalizeWorkspaceId(typed.workspaceId);
    const username = typeof typed.username === 'string' ? typed.username.trim().slice(0, 64) : '';
    const role = normalizeUserRole(typed.role);
    const ticketId = typeof payload.jti === 'string' ? payload.jti.trim() : '';
    const expiresAt = typeof payload.exp === 'number' ? payload.exp : 0;
    if (!userId || !workspaceId || !ticketId || !expiresAt) {
      return null;
    }
    return { userId, workspaceId, username, role, ticketId, expiresAt };
  } catch {
    return null;
  }
}

function broadcastToWorkspace(workspaceId: string, senderId: string | null, message: unknown): void {
  const workspace = workspaces.get(workspaceId);
  if (!workspace) return;

  workspace.forEach((client, userId) => {
    if (userId !== senderId && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify(message));
    }
  });
}

function getWorkspaceUsers(workspaceId: string) {
  const workspace = workspaces.get(workspaceId);
  if (!workspace) return [];

  const users: Array<{ userId: string; coords: Coordinates }> = [];
  workspace.forEach((client, userId) => {
    users.push({
      userId,
      coords: client.coords || { x: 0, y: 0 }
    });
  });
  return users;
}

function normalizeUserId(value: unknown): string {
  if (typeof value !== 'string') return '';
  const normalized = value.trim();
  if (!normalized) return '';
  if (normalized.length > 128) return '';
  return normalized;
}

function normalizeWorkspaceId(value: unknown): string {
  if (typeof value !== 'string') return '';
  const normalized = value.trim();
  if (!normalized) return '';
  if (normalized.length > 128) return '';
  return normalized;
}

function normalizeUserRole(value: unknown): UserRole {
  if (typeof value !== 'string') return 'STUDENT';
  const normalized = value.trim().toUpperCase();
  if (
    normalized === 'ADMIN' ||
    normalized === 'TEACHER' ||
    normalized === 'STUDENT' ||
    normalized === 'PARENT'
  ) {
    return normalized;
  }
  return 'STUDENT';
}

function normalizeFiniteNumber(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeEtag(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function resolveIfMatch(data: Record<string, unknown>): string | null {
  const fromIfMatch = normalizeEtag(data.ifMatch);
  if (fromIfMatch) return fromIfMatch;
  const fromEtag = normalizeEtag(data.etag);
  if (fromEtag) return fromEtag;
  return null;
}

function buildEntityEtag(entityKey: string, version: number): string {
  return `W/"${entityKey}:${version}"`;
}

function ifMatchSatisfied(submittedIfMatch: string | null, currentEtag?: string): boolean {
  if (!submittedIfMatch) return true;
  if (submittedIfMatch === '*') return true;
  return submittedIfMatch === currentEtag;
}

function ifMatchSatisfiedAny(submittedIfMatch: string | null, currentEtags: Array<string | undefined>): boolean {
  if (!submittedIfMatch) return true;
  if (submittedIfMatch === '*') return true;
  return currentEtags.some((candidate) => candidate === submittedIfMatch);
}

function sendEtagConflict(
  ws: WebSocket,
  params: {
    entityType: string;
    entityId: string;
    ifMatch: string | null;
    currentEtag?: string;
    firstEditedBy?: string;
    firstEditedAt?: number;
  }
): void {
  ws.send(
    JSON.stringify({
      type: 'conflict',
      reason: 'etag_mismatch',
      entityType: params.entityType,
      entityId: params.entityId,
      ifMatch: params.ifMatch,
      currentEtag: params.currentEtag,
      firstEditedBy: params.firstEditedBy,
      firstEditedAt: params.firstEditedAt
    })
  );
}

function ensureWorkspaceSharedState(workspaceId: string): WorkspaceSharedState {
  if (!workspaceSharedState.has(workspaceId)) {
    workspaceSharedState.set(workspaceId, {
      elements: new Map(),
      spriteMetrics: new Map(),
      workspaceSnapshots: new Map()
    });
  }

  return workspaceSharedState.get(workspaceId) as WorkspaceSharedState;
}

function clearWorkspaceCleanupTimer(workspaceId: string): void {
  const existing = workspaceCleanupTimers.get(workspaceId);
  if (!existing) return;
  clearTimeout(existing);
  workspaceCleanupTimers.delete(workspaceId);
}

function deleteWorkspaceState(workspaceId: string): void {
  clearWorkspaceCleanupTimer(workspaceId);
  workspaces.delete(workspaceId);
  workspaceLocks.delete(workspaceId);
  workspaceSharedState.delete(workspaceId);
  permissionManager.deleteWorkspace(workspaceId);
}

function scheduleWorkspaceCleanup(workspaceId: string): void {
  clearWorkspaceCleanupTimer(workspaceId);
  const timer = setTimeout(() => {
    const workspace = workspaces.get(workspaceId);
    if (workspace && workspace.size > 0) {
      workspaceCleanupTimers.delete(workspaceId);
      return;
    }
    deleteWorkspaceState(workspaceId);
  }, EMPTY_WORKSPACE_RETENTION_MS);
  workspaceCleanupTimers.set(workspaceId, timer);
}

function resolveElementIdFromPayload(elementType: string, elementData: unknown, fallbackId?: unknown): string {
  if (typeof fallbackId === 'string' && fallbackId.trim()) {
    return fallbackId.trim();
  }

  if (!isRecord(elementData)) {
    return '';
  }

  const candidateKeys = ['id', 'elementId', 'spriteId', 'blockId', 'variableId'];
  for (const key of candidateKeys) {
    const candidate = elementData[key];
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }

  if (elementType === 'sprite') {
    const name = elementData.name;
    if (typeof name === 'string' && name.trim()) {
      return name.trim();
    }
  }

  return '';
}

function sharedStateToPayload(state: WorkspaceSharedState): {
  elements: WorkspaceElementState[];
  spriteMetrics: WorkspaceSpriteMetrics[];
  workspaceSnapshots: WorkspaceSnapshotState[];
} {
  return {
    elements: Array.from(state.elements.values()),
    spriteMetrics: Array.from(state.spriteMetrics.values()),
    workspaceSnapshots: Array.from(state.workspaceSnapshots.values())
  };
}

nextApp.prepare().then(() => {
  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (incomingWs) => {
    const ws = incomingWs as SocketWithCleanupFlag;
    let userId: string | null = null;
    let workspaceId: string | null = null;
    let isAuthenticated = false;

    console.log('New WebSocket connection established');

    ws.on('message', async (message) => {
      try {
        const parsed = JSON.parse(message.toString()) as unknown;
        if (!isRecord(parsed)) {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }));
          return;
        }
        const data = parsed as Record<string, unknown>;
        const type = typeof data.type === 'string' ? data.type : '';

        switch (type) {
          case 'auth': {
            const token = typeof data.token === 'string' ? data.token.trim() : '';
            if (!token) {
              ws.send(JSON.stringify({ type: 'error', message: 'Missing join ticket' }));
              ws.close(4003, 'Missing join ticket');
              return;
            }

            const ticketClaims = await verifyJoinTicket(token);
            if (!ticketClaims) {
              ws.send(JSON.stringify({ type: 'error', message: 'Invalid or expired join ticket' }));
              ws.close(4003, 'Invalid join ticket');
              return;
            }

            pruneConsumedTicketIds(Math.floor(Date.now() / 1000));
            if (consumedTicketIds.has(ticketClaims.ticketId)) {
              ws.send(JSON.stringify({ type: 'error', message: 'Join ticket has already been used' }));
              ws.close(4003, 'Replay detected');
              return;
            }

            const providedWorkspace = normalizeWorkspaceId(data.workspace);
            if (providedWorkspace && providedWorkspace !== ticketClaims.workspaceId) {
              ws.send(JSON.stringify({ type: 'error', message: 'Workspace mismatch in join ticket' }));
              ws.close(4003, 'Workspace mismatch');
              return;
            }

            const providedUserId = normalizeUserId(data.userId);
            if (providedUserId && providedUserId !== ticketClaims.userId) {
              ws.send(JSON.stringify({ type: 'error', message: 'User mismatch in join ticket' }));
              ws.close(4003, 'User mismatch');
              return;
            }

            consumedTicketIds.set(ticketClaims.ticketId, ticketClaims.expiresAt);

            userId = ticketClaims.userId;
            workspaceId = ticketClaims.workspaceId;
            isAuthenticated = true;
            clearWorkspaceCleanupTimer(workspaceId);

            if (!workspaces.has(workspaceId)) {
              workspaces.set(workspaceId, new Map());
              workspaceLocks.set(workspaceId, new Map());
              permissionManager.initializeWorkspace(workspaceId);
            }
            ensureWorkspaceSharedState(workspaceId);

            const workspaceUsers = workspaces.get(workspaceId) as Map<string, ClientState>;
            const existingUser = workspaceUsers.get(userId);
            const isReplacement = !!existingUser;

            if (existingUser && existingUser.ws !== ws) {
              existingUser.ws.__skipCleanup = true;
              try {
                existingUser.ws.close(4001, 'Reconnected with same userId');
              } catch (error) {
                console.warn('Failed to close replaced socket', error);
              }
            }

            const usernameFromClient = typeof data.username === 'string' ? data.username.trim().slice(0, 64) : '';
            const username = ticketClaims.username || usernameFromClient || 'User';
            const role = ticketClaims.role;
            if (role === 'ADMIN') {
              permissionManager.setUserAsAdmin(workspaceId, userId);
            } else if (role === 'TEACHER') {
              permissionManager.setUserAsTeacher(workspaceId, userId);
            } else {
              permissionManager.clearUserPermissions(workspaceId, userId);
            }

            const isOwner = role === 'ADMIN';
            const user: ClientState = {
              id: userId,
              username,
              role,
              ws,
              permissions: permissionManager.getUserPermissions(workspaceId, userId),
              isOwner
            };

            workspaceUsers.set(userId, user);

            console.log(`User ${userId} joined workspace ${workspaceId}`);

            ws.send(
              JSON.stringify({
                type: 'auth_success',
                userId,
                workspaceId,
                permissions: user.permissions,
                role: user.role,
                isOwner,
                sharedState: sharedStateToPayload(ensureWorkspaceSharedState(workspaceId)),
                users: Array.from(workspaceUsers.values()).map((u) => ({
                  userId: u.id,
                  username: u.username,
                  role: u.role,
                  permissions: u.permissions,
                  isOwner: u.isOwner
                }))
              })
            );

            if (isReplacement) {
              broadcastToWorkspace(workspaceId, userId, {
                type: 'user_updated',
                userId,
                permissions: user.permissions,
                username: user.username,
                role: user.role,
                isOwner: user.isOwner
              });
            } else {
              broadcastToWorkspace(workspaceId, userId, {
                type: 'user_joined',
                userId,
                username: user.username,
                role: user.role,
                permissions: user.permissions,
                isOwner: user.isOwner,
                coords: { x: 0, y: 0 }
              });
            }

            return;
          }

          case 'request_shared_state': {
            if (!isAuthenticated || !workspaceId) return;
            ws.send(
              JSON.stringify({
                type: 'shared_state',
                sharedState: sharedStateToPayload(ensureWorkspaceSharedState(workspaceId))
              })
            );
            break;
          }

          case 'request_teacher_role': {
            if (!isAuthenticated || !workspaceId || !userId) return;

            const wsUsers = workspaces.get(workspaceId);
            const currentClient = wsUsers?.get(userId);
            if (!currentClient) return;
            if (currentClient.role === 'ADMIN') {
              permissionManager.setUserAsAdmin(workspaceId, userId);
            } else if (currentClient.role === 'TEACHER') {
              permissionManager.setUserAsTeacher(workspaceId, userId);
            } else {
              ws.send(JSON.stringify({ type: 'error', message: 'Role escalation denied' }));
              return;
            }

            const updatedPerms = permissionManager.getUserPermissions(workspaceId, userId);

            if (wsUsers?.has(userId)) wsUsers.get(userId)!.permissions = updatedPerms;

            ws.send(
              JSON.stringify({
                type: 'permissions_updated',
                permissions: updatedPerms,
                source: 'role_change'
              })
            );

            broadcastToWorkspace(workspaceId, userId, {
              type: 'user_updated',
              userId,
              permissions: updatedPerms,
              role: currentClient.role,
              isOwner: currentClient.isOwner
            });
            break;
          }

          case 'update_username': {
            if (!isAuthenticated || !workspaceId || !userId) return;

            const nextUsername = typeof data.username === 'string' ? data.username.trim().slice(0, 64) : '';
            if (!nextUsername) {
              ws.send(JSON.stringify({ type: 'error', message: 'Username is required' }));
              return;
            }

            const wsUsers = workspaces.get(workspaceId);
            const client = wsUsers?.get(userId);
            if (!client) return;

            client.username = nextUsername;

            ws.send(
              JSON.stringify({
                type: 'user_updated',
                userId,
                username: nextUsername
              })
            );

            broadcastToWorkspace(workspaceId, userId, {
              type: 'user_updated',
              userId,
              username: nextUsername,
              role: client.role,
              isOwner: client.isOwner
            });
            break;
          }

          case 'update_global_permission': {
            if (!isAuthenticated || !workspaceId || !userId) return;

            const canChange = permissionManager.hasPermission(
              workspaceId,
              userId,
              'canChangePermissions'
            );
            if (!canChange) return;

            permissionManager.updateGlobalPermission(workspaceId, data.permission, data.value);

            const wsUsers = workspaces.get(workspaceId);
            if (wsUsers) {
              wsUsers.forEach((u) => {
                const p = permissionManager.getUserPermissions(workspaceId as string, u.id);
                u.permissions = p;
                if (u.ws.readyState === WebSocket.OPEN) {
                  u.ws.send(
                    JSON.stringify({ type: 'permissions_updated', permissions: p, source: 'global_update' })
                  );
                }

                broadcastToWorkspace(workspaceId as string, null, {
                  type: 'user_updated',
                  userId: u.id,
                  permissions: p,
                  role: u.role,
                  isOwner: u.isOwner
                });
              });
            }
            break;
          }

          case 'update_user_permission': {
            if (!isAuthenticated || !workspaceId || !userId) return;

            const canChange = permissionManager.hasPermission(
              workspaceId,
              userId,
              'canChangePermissions'
            );
            if (!canChange) return;

            const targetUserId = typeof data.targetUserId === 'string' ? data.targetUserId : '';
            if (!targetUserId) return;

            permissionManager.updateUserPermission(workspaceId, targetUserId, data.permission, data.value);

            const wsUsers = workspaces.get(workspaceId);
            const targetClient = wsUsers?.get(targetUserId);
            if (targetClient) {
              const p = permissionManager.getUserPermissions(workspaceId, targetUserId);
              targetClient.permissions = p;
              if (targetClient.ws.readyState === WebSocket.OPEN) {
                targetClient.ws.send(
                  JSON.stringify({ type: 'permissions_updated', permissions: p, source: 'user_update' })
                );
              }

              broadcastToWorkspace(workspaceId, null, {
                type: 'user_updated',
                userId: targetUserId,
                permissions: p,
                role: targetClient.role,
                isOwner: targetClient.isOwner
              });
            }
            break;
          }

          case 'apply_preset_mode': {
            if (!isAuthenticated || !workspaceId || !userId) return;

            const canChange = permissionManager.hasPermission(
              workspaceId,
              userId,
              'canChangePermissions'
            );
            if (!canChange) return;

            const mode = data.mode;
            permissionManager.applyPresetMode(workspaceId, mode);

            const wsUsers = workspaces.get(workspaceId);
            if (wsUsers) {
              wsUsers.forEach((u) => {
                const p = permissionManager.getUserPermissions(workspaceId as string, u.id);
                u.permissions = p;
                if (u.ws.readyState === WebSocket.OPEN) {
                  u.ws.send(
                    JSON.stringify({
                      type: 'permissions_updated',
                      permissions: p,
                      source: 'preset_update',
                      mode
                    })
                  );
                }
              });
            }
            break;
          }

          case 'request_lock': {
            if (!isAuthenticated || !workspaceId || !userId) return;

            const elementId = typeof data.elementId === 'string' ? data.elementId : '';
            const elementType = typeof data.elementType === 'string' ? data.elementType : 'block';
            const locks = workspaceLocks.get(workspaceId);
            if (!locks || !elementId) return;

            let permKey: keyof PermissionSet = 'canEditBlocks';
            if (elementType === 'sprite') {
              permKey = 'canEditSprites';
            } else if (elementType === 'variable') {
              permKey = 'canEditVariables';
            }

            if (!permissionManager.hasPermission(workspaceId, userId, permKey)) {
              ws.send(
                JSON.stringify({ type: 'lock_denied', elementId, lockedBy: null, reason: 'forbidden' })
              );
              return;
            }

            const existing = locks.get(elementId);
            if (existing?.lockedBy && existing.lockedBy !== userId) {
              ws.send(JSON.stringify({ type: 'lock_denied', elementId, lockedBy: existing.lockedBy }));
              return;
            }

            const version = (existing?.version || 0) + 1;
            locks.set(elementId, { lockedBy: userId, version });

            ws.send(JSON.stringify({ type: 'lock_granted', elementId, version }));
            broadcastToWorkspace(workspaceId, userId, {
              type: 'element_locked',
              elementId,
              lockedBy: userId,
              version
            });
            break;
          }

          case 'release_lock': {
            if (!isAuthenticated || !workspaceId || !userId) return;

            const elementId = typeof data.elementId === 'string' ? data.elementId : '';
            const finalPosition = isRecord(data.finalPosition)
              ? ({
                  x: Number(data.finalPosition.x ?? 0),
                  y: Number(data.finalPosition.y ?? 0)
                } as Coordinates)
              : undefined;

            const locks = workspaceLocks.get(workspaceId);
            if (!locks || !elementId) return;
            const existing = locks.get(elementId);

            if (existing && existing.lockedBy === userId) {
              locks.delete(elementId);
              broadcastToWorkspace(workspaceId, userId, {
                type: 'element_unlocked',
                elementId,
                finalPosition
              });
            }
            break;
          }
          default:
            break;
        }

        if (!isAuthenticated || !workspaceId || !userId) {
          ws.send(JSON.stringify({ type: 'error', message: 'Not authenticated' }));
          return;
        }

        if (type === 'update_coords') {
          const coords = isRecord(data.coords) ? data.coords : null;
          const x = Number(coords?.x ?? data.x ?? 0);
          const y = Number(coords?.y ?? data.y ?? 0);

          const workspace = workspaces.get(workspaceId);
          if (workspace?.has(userId)) {
            workspace.get(userId)!.coords = { x, y };
            broadcastToWorkspace(workspaceId, userId, {
              type: 'coords_update',
              userId,
              coords: { x, y }
            });
          }
        }

        if (type === 'element_drag') {
          const elementId = typeof data.elementId === 'string' ? data.elementId : '';
          const elementType = typeof data.elementType === 'string' ? data.elementType : '';
          const position = isRecord(data.position) ? data.position : null;
          const isDragging = Boolean(data.isDragging);

          broadcastToWorkspace(workspaceId, userId, {
            type: 'element_drag',
            userId,
            elementId,
            elementType,
            position,
            isDragging
          });
        }

        if (type === 'block_move') {
          if (!permissionManager.hasPermission(workspaceId, userId, 'canEditBlocks')) {
            return;
          }
          const blockId = typeof data.blockId === 'string' ? data.blockId : '';
          const position = data.position;
          const parentId = data.parentId;
          const attachedTo = data.attachedTo;
          const locks = workspaceLocks.get(workspaceId);
          const lockInfo = locks?.get(blockId);
          if (lockInfo && lockInfo.lockedBy !== userId) return;
          let blockState: WorkspaceElementState | null = null;

          if (blockId) {
            const state = ensureWorkspaceSharedState(workspaceId);
            const elementKey = `block:${blockId}`;
            const existingElement = state.elements.get(elementKey);
            const submittedIfMatch = resolveIfMatch(data);
            if (!ifMatchSatisfied(submittedIfMatch, existingElement?.etag)) {
              sendEtagConflict(ws, {
                entityType: 'block',
                entityId: blockId,
                ifMatch: submittedIfMatch,
                currentEtag: existingElement?.etag,
                firstEditedBy: existingElement?.firstEditedBy,
                firstEditedAt: existingElement?.firstEditedAt
              });
              return;
            }

            const version = (existingElement?.version ?? 0) + 1;
            const etag = buildEntityEtag(elementKey, version);
            const firstEditedBy = existingElement?.firstEditedBy ?? userId;
            const firstEditedAt = existingElement?.firstEditedAt ?? Date.now();
            state.elements.set(elementKey, {
              elementType: 'block',
              elementId: blockId,
              elementData: {
                id: blockId,
                position,
                parentId,
                attachedTo
              },
              version,
              etag,
              firstEditedBy,
              firstEditedAt,
              updatedBy: userId,
              updatedAt: Date.now()
            });
            blockState = state.elements.get(elementKey) || null;
          }

          broadcastToWorkspace(workspaceId, userId, {
            type: 'block_move',
            userId,
            blockId,
            position,
            parentId,
            attachedTo,
            etag: blockState?.etag,
            version: blockState?.version,
            firstEditedBy: blockState?.firstEditedBy,
            firstEditedAt: blockState?.firstEditedAt
          });
        }

        if (type === 'block_focus') {
          const blockId = typeof data.blockId === 'string' ? data.blockId.trim() : '';
          const focused = Boolean(data.focused) && Boolean(blockId);
          broadcastToWorkspace(workspaceId, userId, {
            type: 'block_focus',
            userId,
            blockId,
            focused
          });
        }

        if (type === 'sprite_update') {
          const spriteId = typeof data.spriteId === 'string' ? data.spriteId : '';
          const locks = workspaceLocks.get(workspaceId);
          const lockInfo = locks?.get(spriteId);
          if (lockInfo && lockInfo.lockedBy !== userId) return;

          const x = normalizeFiniteNumber(data.x);
          const y = normalizeFiniteNumber(data.y);
          const rotation = normalizeFiniteNumber(data.rotation);
          const size = normalizeFiniteNumber(data.size);
          const visible = typeof data.visible === 'boolean' ? data.visible : undefined;
          const direction = normalizeFiniteNumber(data.direction);
          const name = typeof data.name === 'string' ? data.name : undefined;
          const rotationStyle = typeof data.rotationStyle === 'string' ? data.rotationStyle : undefined;
          const currentCostume = normalizeFiniteNumber(data.currentCostume);
          const volume = normalizeFiniteNumber(data.volume);
          const layerOrder = normalizeFiniteNumber(data.layerOrder);
          let spriteMetrics: WorkspaceSpriteMetrics | null = null;

          if (spriteId) {
            const state = ensureWorkspaceSharedState(workspaceId);
            const previousMetrics = state.spriteMetrics.get(spriteId);
            const existingSpriteElement = state.elements.get(`sprite:${spriteId}`);
            const submittedIfMatch = resolveIfMatch(data);
            const comparableEtag = previousMetrics?.etag ?? existingSpriteElement?.etag;
            if (!ifMatchSatisfiedAny(submittedIfMatch, [previousMetrics?.etag, existingSpriteElement?.etag])) {
              sendEtagConflict(ws, {
                entityType: 'sprite',
                entityId: spriteId,
                ifMatch: submittedIfMatch,
                currentEtag: comparableEtag,
                firstEditedBy: previousMetrics?.firstEditedBy ?? existingSpriteElement?.firstEditedBy,
                firstEditedAt: previousMetrics?.firstEditedAt ?? existingSpriteElement?.firstEditedAt
              });
              return;
            }

            const baseVersion = Math.max(previousMetrics?.version ?? 0, existingSpriteElement?.version ?? 0);
            const version = baseVersion + 1;
            const etag = buildEntityEtag(`sprite-metrics:${spriteId}`, version);
            const firstEditedBy =
              previousMetrics?.firstEditedBy ?? existingSpriteElement?.firstEditedBy ?? userId;
            const firstEditedAt =
              previousMetrics?.firstEditedAt ?? existingSpriteElement?.firstEditedAt ?? Date.now();
            const nextMetrics: WorkspaceSpriteMetrics = {
              spriteId,
              x: x ?? previousMetrics?.x ?? 0,
              y: y ?? previousMetrics?.y ?? 0,
              ...(rotation !== null
                ? { rotation }
                : previousMetrics?.rotation !== undefined
                ? { rotation: previousMetrics.rotation }
                : {}),
              ...(size !== null
                ? { size }
                : previousMetrics?.size !== undefined
                ? { size: previousMetrics.size }
                : {}),
              ...(visible !== undefined
                ? { visible }
                : previousMetrics?.visible !== undefined
                ? { visible: previousMetrics.visible }
                : {}),
              version,
              etag,
              firstEditedBy,
              firstEditedAt,
              updatedBy: userId,
              updatedAt: Date.now()
            };
            state.spriteMetrics.set(spriteId, nextMetrics);
            spriteMetrics = nextMetrics;

            const existingSprite = state.elements.get(`sprite:${spriteId}`);
            if (existingSprite && isRecord(existingSprite.elementData)) {
              const nextSpriteData: Record<string, unknown> = {
                ...existingSprite.elementData
              };
              if (x !== null) nextSpriteData.x = x;
              if (y !== null) nextSpriteData.y = y;
              if (rotation !== null) nextSpriteData.rotation = rotation;
              if (size !== null) nextSpriteData.size = size;
              if (visible !== undefined) nextSpriteData.visible = visible;
              if (direction !== null) nextSpriteData.direction = direction;
              if (name !== undefined) nextSpriteData.name = name;
              if (rotationStyle !== undefined) nextSpriteData.rotationStyle = rotationStyle;
              if (currentCostume !== null) nextSpriteData.currentCostume = currentCostume;
              if (volume !== null) nextSpriteData.volume = volume;
              if (layerOrder !== null) nextSpriteData.layerOrder = layerOrder;
              const elementVersion = (existingSprite.version ?? 0) + 1;
              state.elements.set(`sprite:${spriteId}`, {
                ...existingSprite,
                elementData: nextSpriteData,
                version: elementVersion,
                etag: buildEntityEtag(`sprite:${spriteId}`, elementVersion),
                firstEditedBy: existingSprite.firstEditedBy ?? userId,
                firstEditedAt: existingSprite.firstEditedAt ?? Date.now(),
                updatedBy: userId,
                updatedAt: Date.now()
              });
            }
          }

          broadcastToWorkspace(workspaceId, userId, {
            type: 'sprite_update',
            userId,
            spriteId,
            x: x ?? data.x,
            y: y ?? data.y,
            rotation: rotation ?? data.rotation,
            size: size ?? data.size,
            visible,
            direction: direction ?? data.direction,
            name,
            rotationStyle,
            currentCostume: currentCostume ?? data.currentCostume,
            volume: volume ?? data.volume,
            layerOrder: layerOrder ?? data.layerOrder,
            etag: spriteMetrics?.etag,
            version: spriteMetrics?.version,
            firstEditedBy: spriteMetrics?.firstEditedBy,
            firstEditedAt: spriteMetrics?.firstEditedAt
          });
        }

        if (type === 'stack_move') {
          broadcastToWorkspace(workspaceId, userId, {
            type: 'stack_move',
            userId,
            stackId: data.stackId,
            blocks: data.blocks,
            position: data.position
          });
        }

        if (type === 'action') {
          broadcastToWorkspace(workspaceId, userId, {
            type: 'action',
            userId,
            action: data.action
          });
        }

        if (type === 'create_element') {
          const elementType = typeof data.elementType === 'string' ? data.elementType : '';
          const elementId = resolveElementIdFromPayload(elementType, data.elementData, data.elementId);
          let elementState: WorkspaceElementState | null = null;
          let spriteMetricState: WorkspaceSpriteMetrics | null = null;
          if (elementType && elementId) {
            const state = ensureWorkspaceSharedState(workspaceId);
            const elementKey = `${elementType}:${elementId}`;
            const existingElement = state.elements.get(elementKey);
            const submittedIfMatch = resolveIfMatch(data);
            if (!ifMatchSatisfied(submittedIfMatch, existingElement?.etag)) {
              sendEtagConflict(ws, {
                entityType: elementType,
                entityId: elementId,
                ifMatch: submittedIfMatch,
                currentEtag: existingElement?.etag,
                firstEditedBy: existingElement?.firstEditedBy,
                firstEditedAt: existingElement?.firstEditedAt
              });
              return;
            }

            const version = (existingElement?.version ?? 0) + 1;
            const etag = buildEntityEtag(elementKey, version);
            const firstEditedBy = existingElement?.firstEditedBy ?? userId;
            const firstEditedAt = existingElement?.firstEditedAt ?? Date.now();
            state.elements.set(elementKey, {
              elementType,
              elementId,
              elementData: data.elementData,
              version,
              etag,
              firstEditedBy,
              firstEditedAt,
              updatedBy: userId,
              updatedAt: Date.now()
            });
            elementState = state.elements.get(elementKey) || null;

            if (elementType === 'sprite' && isRecord(data.elementData)) {
              const x = normalizeFiniteNumber(data.elementData.x);
              const y = normalizeFiniteNumber(data.elementData.y);
              const rotation = normalizeFiniteNumber(data.elementData.rotation);
              const size = normalizeFiniteNumber(data.elementData.size);
              const visible =
                typeof data.elementData.visible === 'boolean' ? data.elementData.visible : undefined;
              const existingMetrics = state.spriteMetrics.get(elementId);
              const metricsVersion = (existingMetrics?.version ?? 0) + 1;
              const metricsFirstEditedBy = existingMetrics?.firstEditedBy ?? userId;
              const metricsFirstEditedAt = existingMetrics?.firstEditedAt ?? Date.now();
              state.spriteMetrics.set(elementId, {
                spriteId: elementId,
                x: x ?? 0,
                y: y ?? 0,
                ...(rotation !== null ? { rotation } : {}),
                ...(size !== null ? { size } : {}),
                ...(visible !== undefined ? { visible } : {}),
                version: metricsVersion,
                etag: buildEntityEtag(`sprite-metrics:${elementId}`, metricsVersion),
                firstEditedBy: metricsFirstEditedBy,
                firstEditedAt: metricsFirstEditedAt,
                updatedBy: userId,
                updatedAt: Date.now()
              });
              spriteMetricState = state.spriteMetrics.get(elementId) || null;
            }
          }

          broadcastToWorkspace(workspaceId, userId, {
            type: 'element_created',
            elementType,
            elementId,
            elementData: data.elementData,
            createdBy: userId,
            etag: elementState?.etag,
            version: elementState?.version,
            firstEditedBy: elementState?.firstEditedBy,
            firstEditedAt: elementState?.firstEditedAt,
            spriteMetricsEtag: spriteMetricState?.etag,
            spriteMetricsVersion: spriteMetricState?.version,
            spriteMetricsFirstEditedBy: spriteMetricState?.firstEditedBy,
            spriteMetricsFirstEditedAt: spriteMetricState?.firstEditedAt
          });
        }

        if (type === 'delete_element') {
          const elementType = typeof data.elementType === 'string' ? data.elementType : '';
          const elementId = resolveElementIdFromPayload(elementType, data.elementData, data.elementId);
          let deletedFromEtag: string | undefined;
          let firstEditedBy: string | undefined;
          let firstEditedAt: number | undefined;
          if (elementType && elementId) {
            const state = ensureWorkspaceSharedState(workspaceId);
            const elementKey = `${elementType}:${elementId}`;
            const existingElement = state.elements.get(elementKey);
            const existingSpriteMetrics =
              elementType === 'sprite' ? state.spriteMetrics.get(elementId) : undefined;
            const submittedIfMatch = resolveIfMatch(data);
            const comparableEtag = existingElement?.etag ?? existingSpriteMetrics?.etag;
            if (!ifMatchSatisfiedAny(submittedIfMatch, [existingElement?.etag, existingSpriteMetrics?.etag])) {
              sendEtagConflict(ws, {
                entityType: elementType,
                entityId: elementId,
                ifMatch: submittedIfMatch,
                currentEtag: comparableEtag,
                firstEditedBy: existingElement?.firstEditedBy,
                firstEditedAt: existingElement?.firstEditedAt
              });
              return;
            }

            deletedFromEtag = existingElement?.etag;
            firstEditedBy = existingElement?.firstEditedBy;
            firstEditedAt = existingElement?.firstEditedAt;
            state.elements.delete(elementKey);
            if (elementType === 'sprite') {
              state.spriteMetrics.delete(elementId);
              state.workspaceSnapshots.delete(elementId);
            }
          }

          broadcastToWorkspace(workspaceId, userId, {
            type: 'element_deleted',
            elementId,
            elementType,
            deletedBy: userId,
            deletedFromEtag,
            firstEditedBy,
            firstEditedAt
          });
        }

        if (type === 'workspace_snapshot') {
          const spriteId = typeof data.spriteId === 'string' ? data.spriteId.trim() : '';
          const serializedJson = typeof data.serializedJson === 'string' ? data.serializedJson : '';
          if (!spriteId || !serializedJson) {
            return;
          }

          if (serializedJson.length > 2_000_000) {
            ws.send(JSON.stringify({ type: 'error', message: 'Workspace snapshot too large' }));
            return;
          }

          if (!permissionManager.hasPermission(workspaceId, userId, 'canEditBlocks')) {
            return;
          }

          const state = ensureWorkspaceSharedState(workspaceId);
          const existingSnapshot = state.workspaceSnapshots.get(spriteId);
          const submittedIfMatch = resolveIfMatch(data);
          if (!ifMatchSatisfied(submittedIfMatch, existingSnapshot?.etag)) {
            sendEtagConflict(ws, {
              entityType: 'workspace_snapshot',
              entityId: spriteId,
              ifMatch: submittedIfMatch,
              currentEtag: existingSnapshot?.etag,
              firstEditedBy: existingSnapshot?.firstEditedBy,
              firstEditedAt: existingSnapshot?.firstEditedAt
            });
            return;
          }

          const version = (existingSnapshot?.version ?? 0) + 1;
          const etag = buildEntityEtag(`workspace-snapshot:${spriteId}`, version);
          const firstEditedBy = existingSnapshot?.firstEditedBy ?? userId;
          const firstEditedAt = existingSnapshot?.firstEditedAt ?? Date.now();
          state.workspaceSnapshots.set(spriteId, {
            spriteId,
            serializedJson,
            version,
            etag,
            firstEditedBy,
            firstEditedAt,
            updatedBy: userId,
            updatedAt: Date.now()
          });

          broadcastToWorkspace(workspaceId, userId, {
            type: 'workspace_snapshot',
            userId,
            spriteId,
            serializedJson,
            version,
            etag,
            firstEditedBy,
            firstEditedAt
          });
        }
      } catch (error) {
        console.error('Error processing message:', error);
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }));
      }
    });

    ws.on('close', () => {
      if (ws.__skipCleanup) {
        return;
      }

      if (isAuthenticated && workspaceId && userId) {
        const workspace = workspaces.get(workspaceId);
        if (workspace) {
          workspace.delete(userId);

          const locks = workspaceLocks.get(workspaceId);
          if (locks) {
            Array.from(locks.entries()).forEach(([elementId, info]) => {
              if (info.lockedBy === userId) {
                locks.delete(elementId);
                broadcastToWorkspace(workspaceId, userId, { type: 'element_unlocked', elementId });
              }
            });
          }

          if (workspace.size === 0) {
            scheduleWorkspaceCleanup(workspaceId);
          } else {
            broadcastToWorkspace(workspaceId, userId, {
              type: 'user_left',
              userId
            });
          }
        }

        console.log(`User ${userId} left workspace ${workspaceId}`);
      }
    });

    ws.on('error', (error) => {
      console.error('WebSocket error:', error);
    });
  });

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      workspaces: workspaces.size,
      timestamp: new Date().toISOString()
    });
  });

  app.get('/workspace/:id', (req, res) => {
    const wsId = req.params.id;
    const workspace = workspaces.get(wsId);

    if (!workspace) {
      return res.status(404).json({ error: 'Workspace not found' });
    }

    return res.json({
      workspaceId: wsId,
      users: getWorkspaceUsers(wsId),
      userCount: workspace.size
    });
  });

  app.use((req, res) => handle(req, res));

  server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    console.log('WebSocket server is ready');
  });
});
