const express = require('express');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const PermissionManagerBackend = require('./permission-manager-backend');

const app = express();
const PORT = process.env.PORT || 4000;

// Serve static files (for demo page)
app.use(express.static(path.join(__dirname)));

// Create HTTP server
const server = app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

// Create WebSocket server
const wss = new WebSocketServer({ server });

// Store workspaces and connected clients
// workspaces = { workspaceId: { userId: { ws, coords, userData } } }
const workspaces = new Map();
// Store element locks per workspace: workspaceId -> Map(elementId -> { lockedBy, version })
const workspaceLocks = new Map();
// Permissions
const permissionManager = new PermissionManagerBackend();

// Valid tokens (in production, this should be in a database)
const validTokens = new Set(['valid-token-123', 'test-token-456', 'demo-token-789']);

// Helper function to broadcast to all clients in a workspace except sender
function broadcastToWorkspace(workspaceId, senderId, message) {
  const workspace = workspaces.get(workspaceId);
  if (!workspace) return;

  workspace.forEach((client, userId) => {
    if (userId !== senderId && client.ws.readyState === 1) { // OPEN state
      client.ws.send(JSON.stringify(message));
    }
  });
}

// Helper function to get all users in a workspace
function getWorkspaceUsers(workspaceId) {
  const workspace = workspaces.get(workspaceId);
  if (!workspace) return [];

  const users = [];
  workspace.forEach((client, userId) => {
    users.push({
      userId: userId,
      coords: client.coords || { x: 0, y: 0 }
    });
  });
  return users;
}

wss.on('connection', (ws) => {
  let userId = null;
  let workspaceId = null;
  let isAuthenticated = false;

  console.log('New WebSocket connection established');

  // Handle client messages
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      
    // Handle different message types
    switch(data.type) {
      case 'auth': {
        const { token, workspace } = data;

              // Validate token
              if (!validTokens.has(token)) {
                ws.send(JSON.stringify({
                  type: 'error',
                  message: 'Invalid token'
                }));
                ws.close();
                return;
              }

              // Generate unique user ID
              userId = uuidv4();
              workspaceId = workspace || 'default';
              isAuthenticated = true;

              // Initialize workspace if it doesn't exist
              if (!workspaces.has(workspaceId)) {
                workspaces.set(workspaceId, new Map());
                workspaceLocks.set(workspaceId, new Map());
              }

              // After successful auth, check if this is the first user (owner)
              const isOwner = workspaces.get(workspaceId).size === 0;
              if (isOwner) {
                // Initialize permissions for workspace with this owner
                permissionManager.initializeWorkspace(workspaceId, userId);
              }
              
              // Add user to workspace
              const user = {
                  id: userId,
                  username: data.username || 'Anonymous',
                  ws: ws,
                  permissions: isOwner ? permissionManager.getOwnerPermissions() : permissionManager.getUserPermissions(workspaceId, userId),
                  isOwner: isOwner
              };
              
              workspaces.get(workspaceId).set(userId, user);

              console.log(`User ${userId} joined workspace ${workspaceId}`);

              // Send success response with user ID
              ws.send(JSON.stringify({
                type: 'auth_success',
                userId: userId,
                workspaceId: workspaceId,
                permissions: user.permissions,
                isOwner: isOwner,
                users: Array.from(workspaces.get(workspaceId).values()).map(u => ({
                    userId: u.id,
                    username: u.username,
                    permissions: u.permissions,
                    isOwner: u.isOwner
                }))
              }));

              // Notify other users in the workspace
              broadcastToWorkspace(workspaceId, userId, {
                type: 'user_joined',
                userId: userId,
                username: user.username,
                coords: { x: 0, y: 0 }
              });

              return;
            }
          case 'request_teacher_role': {
              if (!isAuthenticated) return;
              // Grant teacher permissions to the requesting user
              permissionManager.setUserAsTeacher(workspaceId, userId);
              const updatedPerms = permissionManager.getUserPermissions(workspaceId, userId);
              // Update server copy
              const wsUsers = workspaces.get(workspaceId);
              if (wsUsers?.has(userId)) wsUsers.get(userId).permissions = updatedPerms;
              // Send updated permissions to requester
              ws.send(JSON.stringify({
                  type: 'permissions_updated',
                  permissions: updatedPerms,
                  source: 'role_change'
              }));
              // Notify others of the updated user
              broadcastToWorkspace(workspaceId, userId, {
                  type: 'user_updated',
                  userId: userId,
                  permissions: updatedPerms
              });
              break;
            }
          case 'update_global_permission': {
              if (!isAuthenticated) return;
              // Only users with permission can change
              const canChange = permissionManager.hasPermission(workspaceId, userId, 'canChangePermissions');
              if (!canChange) return;
              const { permission, value } = data;
              permissionManager.updateGlobalPermission(workspaceId, permission, value);
              // Recalculate and push effective permissions to each client
              const wsUsers = workspaces.get(workspaceId);
              if (wsUsers) {
                wsUsers.forEach(u => {
                  const p = permissionManager.getUserPermissions(workspaceId, u.id);
                  u.permissions = p;
                  if (u.ws.readyState === 1) {
                    u.ws.send(JSON.stringify({ type: 'permissions_updated', permissions: p, source: 'global_update' }));
                  }
                  // Notify everyone about this user's updated effective permissions
                  broadcastToWorkspace(workspaceId, null, {
                    type: 'user_updated',
                    userId: u.id,
                    permissions: p
                  });
                });
              }
              break;
            }
          case 'update_user_permission': {
              if (!isAuthenticated) return;
              const canChange = permissionManager.hasPermission(workspaceId, userId, 'canChangePermissions');
              if (!canChange) return;
              const { targetUserId, permission, value } = data;
              permissionManager.updateUserPermission(workspaceId, targetUserId, permission, value);
              // Update server copy and notify
              const wsUsers = workspaces.get(workspaceId);
              const targetClient = wsUsers?.get(targetUserId);
              if (targetClient) {
                const p = permissionManager.getUserPermissions(workspaceId, targetUserId);
                targetClient.permissions = p;
                if (targetClient.ws.readyState === 1) {
                  targetClient.ws.send(JSON.stringify({ type: 'permissions_updated', permissions: p, source: 'user_update' }));
                }
                // Broadcast user_updated so lists reflect the change
                broadcastToWorkspace(workspaceId, null, {
                  type: 'user_updated',
                  userId: targetUserId,
                  permissions: p
                });
              }
              break;
            }
          case 'apply_preset_mode': {
              if (!isAuthenticated) return;
              const canChange = permissionManager.hasPermission(workspaceId, userId, 'canChangePermissions');
              if (!canChange) return;
              const { mode } = data;
              permissionManager.applyPresetMode(workspaceId, mode);
              const wsUsers = workspaces.get(workspaceId);
              if (wsUsers) {
                wsUsers.forEach(u => {
                  const p = permissionManager.getUserPermissions(workspaceId, u.id);
                  u.permissions = p;
                  if (u.ws.readyState === 1) {
                    u.ws.send(JSON.stringify({ type: 'permissions_updated', permissions: p, source: 'preset_update', mode }));
                  }
                });
              }
              break;
            }
          case 'request_lock': {
              if (!isAuthenticated) return;
              const { elementId, elementType } = data;
              const locks = workspaceLocks.get(workspaceId);
              if (!locks) return;
              // Permission check
              let permKey = 'canEditBlocks';
              if (elementType === 'sprite') {
                permKey = 'canEditSprites';
              } else if (elementType === 'variable') {
                permKey = 'canEditVariables';
              }
              if (!permissionManager.hasPermission(workspaceId, userId, permKey)) {
                ws.send(JSON.stringify({ type: 'lock_denied', elementId, lockedBy: null, reason: 'forbidden' }));
                return;
              }
              const existing = locks.get(elementId);
              if (existing?.lockedBy && existing.lockedBy !== userId) {
                ws.send(JSON.stringify({ type: 'lock_denied', elementId, lockedBy: existing.lockedBy }));
                return;
              }
              const version = (existing?.version || 0) + 1;
              locks.set(elementId, { lockedBy: userId, version });
              // Notify requester
              ws.send(JSON.stringify({ type: 'lock_granted', elementId, version }));
              // Notify others
              broadcastToWorkspace(workspaceId, userId, { type: 'element_locked', elementId, lockedBy: userId, version });
              break;
            }
          case 'release_lock': {
              if (!isAuthenticated) return;
              const { elementId, finalPosition } = data;
              const locks = workspaceLocks.get(workspaceId);
              if (!locks) return;
              const existing = locks.get(elementId);
              if (existing && existing.lockedBy === userId) {
                locks.delete(elementId);
                broadcastToWorkspace(workspaceId, userId, { type: 'element_unlocked', elementId, finalPosition });
              }
              break;
            }
          }
    
          // Check if user is authenticated for other message types
          if (!isAuthenticated) {
            ws.send(JSON.stringify({
              type: 'error',
              message: 'Not authenticated'
            }));
            return;
          }

          // Handle coordinate updates
          if (data.type === 'update_coords') {
        const { coords } = data;
        const x = coords?.x ?? data.x;
        const y = coords?.y ?? data.y;

            // Update user's coordinates
            const workspace = workspaces.get(workspaceId);
            if (workspace?.has(userId)) {
              workspace.get(userId).coords = { x, y };

              // Broadcast coordinates to other users in the workspace
              broadcastToWorkspace(workspaceId, userId, {
                type: 'coords_update',
                userId: userId,
                coords: { x, y }
              });
            }
          }

          // Handle block/sprite drag operations
          if (data.type === 'element_drag') {
            const { elementId, elementType, position, isDragging } = data;
            
            broadcastToWorkspace(workspaceId, userId, {
              type: 'element_drag',
              userId: userId,
              elementId: elementId,
              elementType: elementType,
              position: position,
              isDragging: isDragging
            });
          }

          // Handle block position updates (for code blocks)
          if (data.type === 'block_move') {
            const { blockId, position, parentId, attachedTo } = data;
            // Allow only the lock owner to move
            const locks = workspaceLocks.get(workspaceId);
            const l = locks?.get(blockId);
            if (l && l.lockedBy !== userId) return;
            
            broadcastToWorkspace(workspaceId, userId, {
              type: 'block_move',
              userId: userId,
              blockId: blockId,
              position: position,
              parentId: parentId,
              attachedTo: attachedTo
            });
          }

          // Handle sprite position/property updates (for stage sprites)
          if (data.type === 'sprite_update') {
      const { spriteId, x, y, rotation, size, visible } = data;
            // Allow only the lock owner to move
            const locks = workspaceLocks.get(workspaceId);
            const l = locks?.get(spriteId);
            if (l && l.lockedBy !== userId) return;
            
            broadcastToWorkspace(workspaceId, userId, {
              type: 'sprite_update',
              userId: userId,
              spriteId: spriteId,
              x: x,
              y: y,
              rotation: rotation,
              size: size,
              visible: visible
            });
          }

          // Handle block stack movements (when moving connected blocks)
          if (data.type === 'stack_move') {
            const { stackId, blocks, position } = data;
            
            broadcastToWorkspace(workspaceId, userId, {
              type: 'stack_move',
              userId: userId,
              stackId: stackId,
              blocks: blocks,           // array of block IDs in the stack
              position: position        // new position of the stack
            });
          }

          // Handle custom messages/actions
          if (data.type === 'action') {
            // Broadcast action to other users in the workspace
            broadcastToWorkspace(workspaceId, userId, {
              type: 'action',
              userId: userId,
              action: data.action
            });
          }

          // Handle element creation/deletion
          if (data.type === 'create_element') {
            const { elementType, elementData } = data;
            broadcastToWorkspace(workspaceId, userId, {
              type: 'element_created',
              elementType,
              elementData,
              createdBy: userId
            });
          }
          if (data.type === 'delete_element') {
            const { elementId, elementType } = data;
            broadcastToWorkspace(workspaceId, userId, {
              type: 'element_deleted',
              elementId,
              elementType,
              deletedBy: userId
            });
          }
      } catch (error) {
      console.error('Error processing message:', error);
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Invalid message format'
      }));
    }
  });

  ws.on('close', () => {
    if (isAuthenticated && workspaceId && userId) {
      // Remove user from workspace
      const workspace = workspaces.get(workspaceId);
      if (workspace) {
        workspace.delete(userId);
        // Release locks held by this user
        const locks = workspaceLocks.get(workspaceId);
        if (locks) {
          Array.from(locks.entries()).forEach(([elementId, info]) => {
            if (info.lockedBy === userId) {
              locks.delete(elementId);
              broadcastToWorkspace(workspaceId, userId, { type: 'element_unlocked', elementId });
            }
          });
        }

        // Clean up empty workspaces
        if (workspace.size === 0) {
          workspaces.delete(workspaceId);
          workspaceLocks.delete(workspaceId);
          permissionManager.deleteWorkspace(workspaceId);
        } else {
          // Notify other users
          broadcastToWorkspace(workspaceId, userId, {
            type: 'user_left',
            userId: userId
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

// Basic HTTP endpoint for health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    workspaces: workspaces.size,
    timestamp: new Date().toISOString()
  });
});

// Root endpoint - redirect to demo page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'demo.html'));
});

// Endpoint to get workspace info
app.get('/workspace/:id', (req, res) => {
  const workspaceId = req.params.id;
  const workspace = workspaces.get(workspaceId);

  if (!workspace) {
    return res.status(404).json({ error: 'Workspace not found' });
  }

  res.json({
    workspaceId: workspaceId,
    users: getWorkspaceUsers(workspaceId),
    userCount: workspace.size
  });
});

console.log('WebSocket server is ready');
