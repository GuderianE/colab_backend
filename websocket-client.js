/**
 * WebSocket Connection Manager
 * Handles connection, authentication, and message routing
 */
class WebSocketClient {
  constructor(config = {}) {
    this.ws = null;
    this.config = {
      url: config.url || `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`,
      reconnectDelay: config.reconnectDelay || 2000,
      maxReconnectAttempts: config.maxReconnectAttempts || 10,
      debug: config.debug || false
    };
    
    this.userId = null;
    this.workspaceId = null;
    this.isAuthenticated = false;
    this.reconnectAttempts = 0;
    
    // Message handlers registry
    this.messageHandlers = new Map();
    
    // Event listeners
    this.eventListeners = {
      onOpen: [],
      onClose: [],
      onError: [],
      onAuthenticated: [],
      onMessage: []
    };
  }

  /**
   * Connect to WebSocket server
   */
  connect(token, workspaceId, username) {
    if (this.config.debug) console.log('Connecting to WebSocket server...');
    
    this.workspaceId = workspaceId;
    
    try {
      this.ws = new WebSocket(this.config.url);
      
      this.ws.onopen = () => {
        this.reconnectAttempts = 0;
        if (this.config.debug) console.log('WebSocket connected');
        
        // Authenticate immediately
        this.authenticate(token, workspaceId, username);
        
        // Trigger open event listeners
        this.eventListeners.onOpen.forEach(handler => handler());
      };
      
      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          this.handleMessage(data);
        } catch (error) {
          console.error('Failed to parse message:', error);
        }
      };
      
      this.ws.onclose = () => {
        this.isAuthenticated = false;
        if (this.config.debug) console.log('WebSocket disconnected');
        
        // Trigger close event listeners
        this.eventListeners.onClose.forEach(handler => handler());
        
        // Auto-reconnect
        if (this.reconnectAttempts < this.config.maxReconnectAttempts) {
          this.reconnectAttempts++;
          setTimeout(() => {
            if (this.config.debug) console.log(`Reconnecting... (attempt ${this.reconnectAttempts})`);
            this.connect(token, workspaceId, username);
          }, this.config.reconnectDelay);
        }
      };
      
      this.ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        this.eventListeners.onError.forEach(handler => handler(error));
      };
      
    } catch (error) {
      console.error('Failed to create WebSocket connection:', error);
      throw error;
    }
  }

  /**
   * Authenticate with the server
   */
  authenticate(token, workspaceId, username) {
    this.send({
      type: 'auth',
      token: token,
      workspace: workspaceId,
      username: username
    });
  }

  /**
   * Handle incoming messages
   */
  handleMessage(data) {
    // Handle authentication response
    if (data.type === 'auth_success') {
      this.userId = data.userId;
      this.isAuthenticated = true;
      this.eventListeners.onAuthenticated.forEach(handler => handler(data));
    }
    
    // Call registered message handler
    const handler = this.messageHandlers.get(data.type);
    if (handler) {
      handler(data);
    }
    
    // Call general message listeners
    this.eventListeners.onMessage.forEach(handler => handler(data));
  }

  /**
   * Send message to server
   */
  send(data) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('WebSocket is not connected');
      return false;
    }
    
    try {
      this.ws.send(JSON.stringify(data));
      if (this.config.debug) console.log('Sent:', data);
      return true;
    } catch (error) {
      console.error('Failed to send message:', error);
      return false;
    }
  }

  /**
   * Register a message handler for a specific message type
   */
  on(messageType, handler) {
    this.messageHandlers.set(messageType, handler);
  }

  /**
   * Remove a message handler
   */
  off(messageType) {
    this.messageHandlers.delete(messageType);
  }

  /**
   * Add event listener
   */
  addEventListener(event, handler) {
    if (this.eventListeners[event]) {
      this.eventListeners[event].push(handler);
    }
  }

  /**
   * Remove event listener
   */
  removeEventListener(event, handler) {
    if (this.eventListeners[event]) {
      const index = this.eventListeners[event].indexOf(handler);
      if (index > -1) {
        this.eventListeners[event].splice(index, 1);
      }
    }
  }

  /**
   * Check if connected and authenticated
   */
  isConnected() {
    return this.ws && this.ws.readyState === WebSocket.OPEN && this.isAuthenticated;
  }

  /**
   * Disconnect from server
   */
  disconnect() {
    if (this.ws) {
      this.reconnectAttempts = this.config.maxReconnectAttempts; // Prevent auto-reconnect
      this.ws.close();
      this.ws = null;
    }
  }

  /**
   * Get current state
   */
  getState() {
    return {
      userId: this.userId,
      workspaceId: this.workspaceId,
      isAuthenticated: this.isAuthenticated,
      isConnected: this.isConnected()
    };
  }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = WebSocketClient;
}