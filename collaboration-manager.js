/**
 * Collaboration Manager
 * Handles element operations, locking, and real-time collaboration
 */
class CollaborationManager {
  constructor(wsClient, permissionManager) {
    this.wsClient = wsClient;
    this.permissionManager = permissionManager;
    
    // Track locked elements and versions
    this.lockedElements = new Map();
    this.elementVersions = new Map();
    
    // Track cursors
    this.cursors = new Map();
    
    // Setup message handlers
    this.setupMessageHandlers();
  }

  /**
   * Setup message handlers for collaboration
   */
  setupMessageHandlers() {
    // Handle lock responses
    this.wsClient.on('lock_granted', (data) => {
      this.lockedElements.set(data.elementId, {
        version: data.version,
        lockedBy: this.wsClient.userId
      });
      this.onLockGranted(data.elementId, data.version);
    });

    this.wsClient.on('lock_denied', (data) => {
      this.onLockDenied(data.elementId, data.lockedBy);
    });

    this.wsClient.on('element_locked', (data) => {
      this.lockedElements.set(data.elementId, {
        version: data.version,
        lockedBy: data.lockedBy
      });
      this.onElementLocked(data.elementId, data.lockedBy);
    });

    this.wsClient.on('element_unlocked', (data) => {
      this.lockedElements.delete(data.elementId);
      this.onElementUnlocked(data.elementId, data.finalPosition);
    });

    // Handle position updates
    this.wsClient.on('block_move', (data) => {
      this.onBlockMoved(data.userId, data.blockId, data.position);
    });

    this.wsClient.on('sprite_update', (data) => {
      this.onSpriteUpdated(data.userId, data.spriteId, data.x, data.y);
    });

    // Handle cursor updates
    this.wsClient.on('coords_update', (data) => {
      this.updateCursor(data.userId, data.coords);
    });

    // Handle element operations
    this.wsClient.on('element_created', (data) => {
      this.onElementCreated(data.elementType, data.elementData, data.createdBy);
    });

    this.wsClient.on('element_deleted', (data) => {
      this.onElementDeleted(data.elementId, data.elementType, data.deletedBy);
    });

    // Handle user updates
    this.wsClient.on('user_updated', (data) => {
      if (this.permissionManager.users) {
        const user = this.permissionManager.users.get(data.userId);
        if (user) {
          user.permissions = data.permissions;
          this.permissionManager.onUserListUpdated();
        }
      }
    });
  }

  /**
   * Request lock on an element before editing
   */
  requestLock(elementId, elementType) {
    // Check permission first
    let permissionNeeded = 'canEditBlocks';
    if (elementType === 'sprite') {
      permissionNeeded = 'canEditSprites';
    } else if (elementType === 'variable') {
      permissionNeeded = 'canEditVariables';
    }

    if (!this.permissionManager.hasPermission(permissionNeeded)) {
      this.permissionManager.onPermissionDenied('edit', elementType);
      return false;
    }

    return this.wsClient.send({
      type: 'request_lock',
      elementId: elementId,
      elementType: elementType
    });
  }

  /**
   * Release lock on an element after editing
   */
  releaseLock(elementId, finalPosition) {
    if (!this.lockedElements.has(elementId)) {
      return false;
    }

    this.lockedElements.delete(elementId);
    
    return this.wsClient.send({
      type: 'release_lock',
      elementId: elementId,
      finalPosition: finalPosition
    });
  }

  /**
   * Update element position (combined method)
   */
  updateElementPosition(elementId, elementType, position) {
    if (elementType === 'sprite') {
      return this.updateSpritePosition(elementId, position.x, position.y);
    } else {
      return this.updateBlockPosition(elementId, position);
    }
  }

  /**
   * Update block position
   */
  updateBlockPosition(blockId, position) {
    if (!this.permissionManager.hasPermission('canEditBlocks')) {
      return false;
    }

    const lockInfo = this.lockedElements.get(blockId);
    
    return this.wsClient.send({
      type: 'block_move',
      blockId: blockId,
      position: position,
      version: lockInfo ? lockInfo.version : 0
    });
  }

  /**
   * Update sprite position
   */
  updateSpritePosition(spriteId, x, y) {
    if (!this.permissionManager.hasPermission('canEditSprites')) {
      return false;
    }

    const lockInfo = this.lockedElements.get(spriteId);
    
    return this.wsClient.send({
      type: 'sprite_update',
      spriteId: spriteId,
      x: x,
      y: y,
      version: lockInfo ? lockInfo.version : 0
    });
  }

  /**
   * Create new element
   */
  createElement(elementType, elementData) {
    let permissionNeeded = 'canAddBlocks';
    if (elementType === 'sprite') {
      permissionNeeded = 'canAddSprites';
    } else if (elementType === 'variable') {
      permissionNeeded = 'canAddVariables';
    }

    if (!this.permissionManager.hasPermission(permissionNeeded)) {
      this.permissionManager.onPermissionDenied('create', elementType);
      return false;
    }

    return this.wsClient.send({
      type: 'create_element',
      elementType: elementType,
      elementData: elementData
    });
  }

  /**
   * Delete element
   */
  deleteElement(elementId, elementType) {
    let permissionNeeded = 'canDeleteBlocks';
    if (elementType === 'sprite') {
      permissionNeeded = 'canDeleteSprites';
    } else if (elementType === 'variable') {
      permissionNeeded = 'canDeleteVariables';
    }

    if (!this.permissionManager.hasPermission(permissionNeeded)) {
      this.permissionManager.onPermissionDenied('delete', elementType);
      return false;
    }

    return this.wsClient.send({
      type: 'delete_element',
      elementId: elementId,
      elementType: elementType
    });
  }

  /**
   * Update cursor position
   */
  updateCursorPosition(x, y) {
    return this.wsClient.send({
      type: 'update_coords',
      coords: { x, y }
    });
  }

  /**
   * Run code
   */
  runCode(scriptId) {
    if (!this.permissionManager.hasPermission('canRunCode')) {
      this.permissionManager.onPermissionDenied('run', 'code');
      return false;
    }

    return this.wsClient.send({
      type: 'run_code',
      scriptId: scriptId
    });
  }

  /**
   * Check if element is locked
   */
  isElementLocked(elementId) {
    return this.lockedElements.has(elementId);
  }

  /**
   * Check if element is locked by current user
   */
  isElementLockedByMe(elementId) {
    const lock = this.lockedElements.get(elementId);
    return lock && lock.lockedBy === this.wsClient.userId;
  }

  /**
   * Get lock info for element
   */
  getLockInfo(elementId) {
    return this.lockedElements.get(elementId);
  }

  // Cursor management
  updateCursor(userId, coords) {
    if (!this.cursors.has(userId) && userId !== this.wsClient.userId) {
      this.createCursor(userId);
    }
    
    const cursor = this.cursors.get(userId);
    if (cursor) {
      this.onCursorUpdated(userId, coords);
    }
  }

  createCursor(userId) {
    this.cursors.set(userId, { userId });
    this.onCursorCreated(userId);
  }

  removeCursor(userId) {
    if (this.cursors.has(userId)) {
      this.cursors.delete(userId);
      this.onCursorRemoved(userId);
    }
  }

  // Override these methods in your implementation
  onLockGranted(elementId, version) {}
  onLockDenied(elementId, lockedBy) {}
  onElementLocked(elementId, lockedBy) {}
  onElementUnlocked(elementId, finalPosition) {}
  onBlockMoved(userId, blockId, position) {}
  onSpriteUpdated(userId, spriteId, x, y) {}
  onElementCreated(elementType, elementData, createdBy) {}
  onElementDeleted(elementId, elementType, deletedBy) {}
  onCursorCreated(userId) {}
  onCursorUpdated(userId, coords) {}
  onCursorRemoved(userId) {}
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = CollaborationManager;
}