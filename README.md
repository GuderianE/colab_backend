# colab_backend

A Node.js WebSocket server for multi-user collaboration with real-time coordinate synchronization.

## Features

- **WebSocket-based real-time communication**
- **Token-based authentication**
- **Unique user ID generation** (UUID v4)
- **Workspace management** - Users can be assigned to different workspaces
- **Real-time coordinate broadcasting** - See user positions in real-time
- **User presence tracking** - Know when users join or leave

## Installation

```bash
npm install
```

## Running the Server

```bash
npm start
```

The server will start on port 3000 by default (or the PORT environment variable if set).

## Demo

Once the server is running, open your browser to:
- **http://localhost:3000/** - Interactive demo page with visual cursor tracking
- **http://localhost:3000/health** - Health check endpoint

To test multi-user collaboration:
1. Open the demo page in multiple browser windows or tabs
2. Each window will receive a unique user ID
3. Move your mouse over the canvas to see real-time coordinate updates
4. Watch as other users' cursors appear and move in real-time

## WebSocket Protocol

### Authentication

First, connect to the WebSocket server and send an authentication message:

```json
{
  "type": "auth",
  "token": "valid-token-123",
  "workspace": "my-workspace-id"
}
```

**Response on success:**
```json
{
  "type": "auth_success",
  "userId": "generated-uuid",
  "workspaceId": "my-workspace-id",
  "users": [
    { "userId": "user-id-1", "coords": { "x": 100, "y": 200 } },
    { "userId": "user-id-2", "coords": { "x": 300, "y": 400 } }
  ]
}
```

### Update Coordinates

Send coordinate updates to broadcast your position to other users:

```json
{
  "type": "update_coords",
  "x": 150,
  "y": 250
}
```

**Other users will receive:**
```json
{
  "type": "coords_update",
  "userId": "sender-user-id",
  "coords": { "x": 150, "y": 250 }
}
```

### Custom Actions

Send custom actions to other users in the workspace:

```json
{
  "type": "action",
  "action": {
    "type": "draw",
    "data": "..."
  }
}
```

### User Events

**When a user joins:**
```json
{
  "type": "user_joined",
  "userId": "new-user-id",
  "coords": { "x": 0, "y": 0 }
}
```

**When a user leaves:**
```json
{
  "type": "user_left",
  "userId": "leaving-user-id"
}
```

## HTTP Endpoints

### Health Check
```
GET /health
```

Returns server status and number of active workspaces.

### Workspace Info
```
GET /workspace/:id
```

Returns information about a specific workspace, including connected users.

## Valid Tokens

For testing, the following tokens are valid:
- `valid-token-123`
- `test-token-456`
- `demo-token-789`

**Note:** In production, tokens should be validated against a database.

## Example Client Usage

```javascript
const ws = new WebSocket('ws://localhost:3000');

ws.onopen = () => {
  // Authenticate
  ws.send(JSON.stringify({
    type: 'auth',
    token: 'valid-token-123',
    workspace: 'project-1'
  }));
};

ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  
  if (message.type === 'auth_success') {
    console.log('Connected as user:', message.userId);
    console.log('Other users:', message.users);
    
    // Send coordinate updates
    ws.send(JSON.stringify({
      type: 'update_coords',
      x: 100,
      y: 200
    }));
  }
  
  if (message.type === 'coords_update') {
    console.log(`User ${message.userId} moved to:`, message.coords);
  }
  
  if (message.type === 'user_joined') {
    console.log(`User ${message.userId} joined`);
  }
  
  if (message.type === 'user_left') {
    console.log(`User ${message.userId} left`);
  }
};
```

## Architecture

- **Express.js**: HTTP server for health checks and API endpoints
- **ws**: WebSocket library for real-time communication
- **uuid**: Generates unique user identifiers
- **Workspaces**: Isolated collaboration spaces - messages are only broadcast within the same workspace

## Testing

Run the automated test client to verify all functionality:

```bash
node test-client.js
```

This will simulate two clients connecting, authenticating, and exchanging coordinate updates.

## Files

- `server.js` - Main WebSocket server implementation
- `demo.html` - Interactive browser-based demo
- `test-client.js` - Automated test client for validation
- `package.json` - Node.js dependencies and scripts
