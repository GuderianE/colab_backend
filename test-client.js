const WebSocket = require('ws');

// Test configuration
const SERVER_URL = 'ws://localhost:3000';
const TOKEN = 'valid-token-123';
const WORKSPACE = 'test-workspace';

console.log('=== Testing WebSocket Collaboration Server ===\n');

// Create first client
console.log('[Client 1] Connecting...');
const client1 = new WebSocket(SERVER_URL);
let client1UserId = null;

client1.on('open', () => {
  console.log('[Client 1] Connected, authenticating...');
  
  // Authenticate
  client1.send(JSON.stringify({
    type: 'auth',
    token: TOKEN,
    workspace: WORKSPACE
  }));
});

client1.on('message', (data) => {
  const message = JSON.parse(data);
  console.log('[Client 1] Received:', JSON.stringify(message, null, 2));
  
  if (message.type === 'auth_success') {
    client1UserId = message.userId;
    
    // Send coordinate update after 1 second
    setTimeout(() => {
      console.log('[Client 1] Sending coordinate update...');
      client1.send(JSON.stringify({
        type: 'update_coords',
        x: 100,
        y: 200
      }));
    }, 1000);
    
    // Create second client after 2 seconds
    setTimeout(() => {
      createClient2();
    }, 2000);
  }
});

client1.on('error', (error) => {
  console.error('[Client 1] Error:', error.message);
});

client1.on('close', () => {
  console.log('[Client 1] Connection closed');
});

// Create second client
function createClient2() {
  console.log('\n[Client 2] Connecting...');
  const client2 = new WebSocket(SERVER_URL);
  let client2UserId = null;
  
  client2.on('open', () => {
    console.log('[Client 2] Connected, authenticating...');
    
    // Authenticate to same workspace
    client2.send(JSON.stringify({
      type: 'auth',
      token: 'test-token-456',
      workspace: WORKSPACE
    }));
  });
  
  client2.on('message', (data) => {
    const message = JSON.parse(data);
    console.log('[Client 2] Received:', JSON.stringify(message, null, 2));
    
    if (message.type === 'auth_success') {
      client2UserId = message.userId;
      
      // Send coordinate update after 1 second
      setTimeout(() => {
        console.log('[Client 2] Sending coordinate update...');
        client2.send(JSON.stringify({
          type: 'update_coords',
          x: 300,
          y: 400
        }));
        
        // Test workspace endpoint
        testWorkspaceEndpoint();
        
        // Close connections after testing
        setTimeout(() => {
          console.log('\n=== Test Complete ===');
          client1.close();
          client2.close();
          setTimeout(() => process.exit(0), 500);
        }, 2000);
      }, 1000);
    }
  });
  
  client2.on('error', (error) => {
    console.error('[Client 2] Error:', error.message);
  });
  
  client2.on('close', () => {
    console.log('[Client 2] Connection closed');
  });
}

// Test HTTP workspace endpoint
function testWorkspaceEndpoint() {
  const http = require('http');
  
  console.log('\n[HTTP] Testing workspace endpoint...');
  
  http.get(`http://localhost:3000/workspace/${WORKSPACE}`, (res) => {
    let data = '';
    
    res.on('data', (chunk) => {
      data += chunk;
    });
    
    res.on('end', () => {
      console.log('[HTTP] Workspace info:', JSON.parse(data));
    });
  }).on('error', (error) => {
    console.error('[HTTP] Error:', error.message);
  });
}
