import http from 'node:http';
import express from 'express';
import next from 'next';
import WebSocket, { WebSocketServer } from 'ws';
import { jwtVerify, type JWTPayload } from 'jose';
import PermissionManagerBackend from './permission-manager-backend';
import type { Coordinates, PermissionSet } from './types/collaboration';

type ClientState = {
  id: string;
  username: string;
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
const permissionManager = new PermissionManagerBackend();

type JoinTicketPayload = JWTPayload & {
  workspaceId?: unknown;
  username?: unknown;
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
    const ticketId = typeof payload.jti === 'string' ? payload.jti.trim() : '';
    const expiresAt = typeof payload.exp === 'number' ? payload.exp : 0;
    if (!userId || !workspaceId || !ticketId || !expiresAt) {
      return null;
    }
    return { userId, workspaceId, username, ticketId, expiresAt };
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

            if (!workspaces.has(workspaceId)) {
              workspaces.set(workspaceId, new Map());
              workspaceLocks.set(workspaceId, new Map());
            }

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

            const isOwner = workspaceUsers.size === 0;
            if (isOwner) {
              permissionManager.initializeWorkspace(workspaceId, userId);
            }

            const usernameFromClient = typeof data.username === 'string' ? data.username.trim().slice(0, 64) : '';
            const username = ticketClaims.username || usernameFromClient || 'User';
            const user: ClientState = {
              id: userId,
              username,
              ws,
              permissions: isOwner
                ? permissionManager.getOwnerPermissions()
                : permissionManager.getUserPermissions(workspaceId, userId),
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
                isOwner,
                users: Array.from(workspaceUsers.values()).map((u) => ({
                  userId: u.id,
                  username: u.username,
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
                username: user.username
              });
            } else {
              broadcastToWorkspace(workspaceId, userId, {
                type: 'user_joined',
                userId,
                username: user.username,
                coords: { x: 0, y: 0 }
              });
            }

            return;
          }

          case 'request_teacher_role': {
            if (!isAuthenticated || !workspaceId || !userId) return;

            permissionManager.setUserAsTeacher(workspaceId, userId);
            const updatedPerms = permissionManager.getUserPermissions(workspaceId, userId);
            const wsUsers = workspaces.get(workspaceId);

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
              permissions: updatedPerms
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
                  permissions: p
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
                permissions: p
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
          const blockId = typeof data.blockId === 'string' ? data.blockId : '';
          const position = data.position;
          const parentId = data.parentId;
          const attachedTo = data.attachedTo;
          const locks = workspaceLocks.get(workspaceId);
          const lockInfo = locks?.get(blockId);
          if (lockInfo && lockInfo.lockedBy !== userId) return;

          broadcastToWorkspace(workspaceId, userId, {
            type: 'block_move',
            userId,
            blockId,
            position,
            parentId,
            attachedTo
          });
        }

        if (type === 'sprite_update') {
          const spriteId = typeof data.spriteId === 'string' ? data.spriteId : '';
          const locks = workspaceLocks.get(workspaceId);
          const lockInfo = locks?.get(spriteId);
          if (lockInfo && lockInfo.lockedBy !== userId) return;

          broadcastToWorkspace(workspaceId, userId, {
            type: 'sprite_update',
            userId,
            spriteId,
            x: data.x,
            y: data.y,
            rotation: data.rotation,
            size: data.size,
            visible: data.visible
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
          broadcastToWorkspace(workspaceId, userId, {
            type: 'element_created',
            elementType: data.elementType,
            elementData: data.elementData,
            createdBy: userId
          });
        }

        if (type === 'delete_element') {
          broadcastToWorkspace(workspaceId, userId, {
            type: 'element_deleted',
            elementId: data.elementId,
            elementType: data.elementType,
            deletedBy: userId
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
            workspaces.delete(workspaceId);
            workspaceLocks.delete(workspaceId);
            permissionManager.deleteWorkspace(workspaceId);
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
