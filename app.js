/**
 * Main Application
 * Initializes and coordinates all managers
 */
class CollaborativeApp {
  constructor(config = {}) {
    // Initialize WebSocket client
    this.wsClient = new WebSocketClient({
      url: config.wsUrl,
      debug: config.debug || false
    });

    // Initialize Permission Manager
    this.permissions = new PermissionManager(this.wsClient);

    // Initialize Collaboration Manager
    this.collaboration = new CollaborationManager(this.wsClient, this.permissions);

    // Setup UI callbacks
    this.setupUICallbacks();

    // Setup global event handlers
    this.setupEventHandlers();
  }

  /**
   * Connect to workspace
   */
  connect(token, workspaceId, username) {
    this.wsClient.connect(token, workspaceId, username);
  }

  /**
   * Disconnect from workspace
   */
  disconnect() {
    this.wsClient.disconnect();
  }

  /**
   * Setup UI callbacks
   */
  setupUICallbacks() {
    // Permission UI updates
    this.permissions.onPermissionsUpdatedCallback = (permissions) => {
      this.updatePermissionUI(permissions);
    };

    this.permissions.onUserListUpdatedCallback = (users) => {
      this.updateUserListUI(users);
    };

    // Override notification methods
    this.permissions.showNotification = (message) => {
      this.showNotification(message, 'info');
    };

    this.permissions.showError = (message) => {
      this.showNotification(message, 'error');
    };

    // Collaboration UI updates
    this.collaboration.onLockGranted = (elementId, version) => {
      this.handleLockGranted(elementId, version);
    };

    this.collaboration.onLockDenied = (elementId, lockedBy) => {
      this.handleLockDenied(elementId, lockedBy);
    };

    this.collaboration.onElementLocked = (elementId, lockedBy) => {
      this.updateElementLockUI(elementId, true, lockedBy);
    };

    this.collaboration.onElementUnlocked = (elementId, finalPosition) => {
      this.updateElementLockUI(elementId, false);
      if (finalPosition) {
        this.updateElementPosition(elementId, finalPosition);
      }
    };

    this.collaboration.onBlockMoved = (userId, blockId, position) => {
      if (userId !== this.wsClient.userId) {
        this.updateBlockPosition(blockId, position);
      }
    };

    this.collaboration.onSpriteUpdated = (userId, spriteId, x, y) => {
      if (userId !== this.wsClient.userId) {
        this.updateSpritePosition(spriteId, x, y);
      }
    };

    this.collaboration.onCursorCreated = (userId) => {
      this.createCursorUI(userId);
    };

    this.collaboration.onCursorUpdated = (userId, coords) => {
      this.updateCursorUI(userId, coords);
    };

    this.collaboration.onCursorRemoved = (userId) => {
      this.removeCursorUI(userId);
    };
  }

  /**
   * Setup global event handlers
   */
  setupEventHandlers() {
    // Track mouse movement for cursor sharing
    document.addEventListener('mousemove', (e) => {
      if (this.wsClient.isConnected()) {
        this.collaboration.updateCursorPosition(e.clientX, e.clientY);
      }
    });

    // Handle connection status
    this.wsClient.addEventListener('onOpen', () => {
      this.updateConnectionStatus(true);
    });

    this.wsClient.addEventListener('onClose', () => {
      this.updateConnectionStatus(false);
    });

    this.wsClient.addEventListener('onAuthenticated', (data) => {
      console.log('Authenticated successfully:', data);
      this.onAuthenticated(data);
    });
  }

  /**
   * Helper method to start dragging an element
   */
  startDragging(elementId, elementType) {
    // Request lock first
    this.collaboration.requestLock(elementId, elementType);
  }

  /**
   * Helper method to update element during drag
   */
  updateDragging(elementId, elementType, x, y) {
    // Check if we have the lock
    if (!this.collaboration.isElementLockedByMe(elementId)) {
      return false;
    }

    if (elementType === 'sprite') {
      this.collaboration.updateSpritePosition(elementId, x, y);
    } else {
      this.collaboration.updateBlockPosition(elementId, { x, y });
    }
  }

  /**
   * Helper method to stop dragging
   */
  stopDragging(elementId, finalX, finalY) {
    this.collaboration.releaseLock(elementId, { x: finalX, y: finalY });
  }

  // UI Update Methods (to be implemented in your actual UI)
  updatePermissionUI(permissions) {
    console.log('Update permission UI:', permissions);
    // Update your UI elements based on permissions
  }

  updateUserListUI(users) {
    console.log('Update user list:', users);
    // Update user list in UI
  }

  updateConnectionStatus(connected) {
    console.log('Connection status:', connected ? 'Connected' : 'Disconnected');
    // Update connection indicator
  }

  showNotification(message, type) {
    console.log(`[${type.toUpperCase()}] ${message}`);
    // Show notification in UI
  }

  handleLockGranted(elementId, version) {
    console.log('Lock granted for:', elementId);
    // Enable dragging for element
  }

  handleLockDenied(elementId, lockedBy) {
    console.log('Lock denied for:', elementId, 'locked by:', lockedBy);
    // Show element is locked
  }

  updateElementLockUI(elementId, isLocked, lockedBy) {
    console.log('Element lock status:', elementId, isLocked, lockedBy);
    // Update element visual state
  }

  updateElementPosition(elementId, position) {
    console.log('Update element position:', elementId, position);
    // Update element position in UI
  }

  updateBlockPosition(blockId, position) {
    // Update block position in UI
    const block = document.getElementById(blockId);
    if (block) {
      block.style.left = position.x + 'px';
      block.style.top = position.y + 'px';
    }
  }

  updateSpritePosition(spriteId, x, y) {
    // Update sprite position in UI
    const sprite = document.getElementById(spriteId);
    if (sprite) {
      sprite.style.left = x + 'px';
      sprite.style.top = y + 'px';
    }
  }

  createCursorUI(userId) {
    // Create cursor element in UI
    console.log('Create cursor for:', userId);
  }

  updateCursorUI(userId, coords) {
    // Update cursor position in UI
    console.log('Update cursor:', userId, coords);
  }

  removeCursorUI(userId) {
    // Remove cursor from UI
    console.log('Remove cursor for:', userId);
  }

  onAuthenticated(data) {
    console.log('Workspace joined successfully');
    // Initialize UI after authentication
  }
}

// Initialize the app
const app = new CollaborativeApp({
  wsUrl: `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`,
  debug: true
});

// Export for use
if (typeof module !== 'undefined' && module.exports) {
  module.exports = CollaborativeApp;
}

// Make available globally
window.CollaborativeApp = CollaborativeApp;
window.app = app;