const express = require('express');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

// Create HTTP server
const server = app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

// Create WebSocket server
const wss = new WebSocketServer({ server });

// Store workspaces and connected clients
// workspaces = { workspaceId: { userId: { ws, coords, userData } } }
const workspaces = new Map();

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

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data);

      // Handle authentication
      if (message.type === 'auth') {
        const { token, workspace } = message;

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
        }

        // Add user to workspace
        workspaces.get(workspaceId).set(userId, {
          ws: ws,
          coords: { x: 0, y: 0 }
        });

        console.log(`User ${userId} joined workspace ${workspaceId}`);

        // Send success response with user ID
        ws.send(JSON.stringify({
          type: 'auth_success',
          userId: userId,
          workspaceId: workspaceId,
          users: getWorkspaceUsers(workspaceId)
        }));

        // Notify other users in the workspace
        broadcastToWorkspace(workspaceId, userId, {
          type: 'user_joined',
          userId: userId,
          coords: { x: 0, y: 0 }
        });

        return;
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
      if (message.type === 'update_coords') {
        const { x, y } = message;

        // Update user's coordinates
        const workspace = workspaces.get(workspaceId);
        if (workspace && workspace.has(userId)) {
          workspace.get(userId).coords = { x, y };

          // Broadcast coordinates to other users in the workspace
          broadcastToWorkspace(workspaceId, userId, {
            type: 'coords_update',
            userId: userId,
            coords: { x, y }
          });
        }
      }

      // Handle custom messages/actions
      if (message.type === 'action') {
        // Broadcast action to other users in the workspace
        broadcastToWorkspace(workspaceId, userId, {
          type: 'action',
          userId: userId,
          action: message.action
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

        // Clean up empty workspaces
        if (workspace.size === 0) {
          workspaces.delete(workspaceId);
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
