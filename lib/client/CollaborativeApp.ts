import type { Coordinates, PermissionSet } from '../../types/collaboration';
import CollaborationManager from './CollaborationManager';
import PermissionManager from './PermissionManager';
import WebSocketClient, { type AuthSuccessPayload } from './WebSocketClient';

type AppConfig = {
  wsUrl?: string;
  debug?: boolean;
};

/**
 * Main Application
 * Initializes and coordinates all managers
 */
export default class CollaborativeApp {
  wsClient: WebSocketClient;

  permissions: PermissionManager;

  collaboration: CollaborationManager;

  mouseMoveHandler: ((event: MouseEvent) => void) | null;

  constructor(config: AppConfig = {}) {
    this.wsClient = new WebSocketClient({
      url: config.wsUrl,
      debug: config.debug || false
    });

    this.permissions = new PermissionManager(this.wsClient);
    this.collaboration = new CollaborationManager(this.wsClient, this.permissions);
    this.mouseMoveHandler = null;

    this.setupUICallbacks();
    this.setupEventHandlers();
  }

  connect(token: string, workspaceId: string, username: string, userId: string): void {
    this.wsClient.connect(token, workspaceId, username, userId);
  }

  disconnect(): void {
    this.wsClient.disconnect();
  }

  setupUICallbacks(): void {
    this.permissions.onPermissionsUpdatedCallback = (permissions) => {
      this.updatePermissionUI(permissions);
    };

    this.permissions.onUserListUpdatedCallback = (users) => {
      this.updateUserListUI(users);
    };

    this.permissions.showNotification = (message) => {
      this.showNotification(message, 'info');
    };

    this.permissions.showError = (message) => {
      this.showNotification(message, 'error');
    };

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

  setupEventHandlers(): void {
    this.mouseMoveHandler = (e) => {
      if (this.wsClient.isConnected()) {
        this.collaboration.updateCursorPosition(e.clientX, e.clientY);
      }
    };

    document.addEventListener('mousemove', this.mouseMoveHandler);

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

  startDragging(elementId: string, elementType: string): void {
    this.collaboration.requestLock(elementId, elementType);
  }

  updateDragging(elementId: string, elementType: string, x: number, y: number): boolean {
    if (!this.collaboration.isElementLockedByMe(elementId)) {
      return false;
    }

    if (elementType === 'sprite') {
      this.collaboration.updateSpritePosition(elementId, x, y);
    } else {
      this.collaboration.updateBlockPosition(elementId, { x, y });
    }

    return true;
  }

  stopDragging(elementId: string, finalX: number, finalY: number): void {
    this.collaboration.releaseLock(elementId, { x: finalX, y: finalY });
  }

  destroy(): void {
    if (this.mouseMoveHandler) {
      document.removeEventListener('mousemove', this.mouseMoveHandler);
    }
    this.disconnect();
  }

  updatePermissionUI(permissions: Partial<PermissionSet>): void {
    console.log('Update permission UI:', permissions);
  }

  updateUserListUI(users: Array<{ userId: string; username: string; isOwner: boolean }>): void {
    console.log('Update user list:', users);
  }

  updateConnectionStatus(connected: boolean): void {
    console.log('Connection status:', connected ? 'Connected' : 'Disconnected');
  }

  showNotification(message: string, type: 'info' | 'error' | 'success'): void {
    console.log(`[${type.toUpperCase()}] ${message}`);
  }

  handleLockGranted(elementId: string, version: number): void {
    console.log('Lock granted for:', elementId, version);
  }

  handleLockDenied(elementId: string, lockedBy: string | null): void {
    console.log('Lock denied for:', elementId, 'locked by:', lockedBy);
  }

  updateElementLockUI(elementId: string, isLocked: boolean, lockedBy?: string): void {
    console.log('Element lock status:', elementId, isLocked, lockedBy);
  }

  updateElementPosition(elementId: string, position: Coordinates): void {
    console.log('Update element position:', elementId, position);
  }

  updateBlockPosition(blockId: string, position: Coordinates): void {
    const block = document.getElementById(blockId);
    if (block) {
      block.style.left = `${position.x}px`;
      block.style.top = `${position.y}px`;
    }
  }

  updateSpritePosition(spriteId: string, x: number, y: number): void {
    const sprite = document.getElementById(spriteId);
    if (sprite) {
      sprite.style.left = `${x}px`;
      sprite.style.top = `${y}px`;
    }
  }

  createCursorUI(userId: string): void {
    console.log('Create cursor for:', userId);
  }

  updateCursorUI(userId: string, coords: Coordinates): void {
    console.log('Update cursor:', userId, coords);
  }

  removeCursorUI(userId: string): void {
    console.log('Remove cursor for:', userId);
  }

  onAuthenticated(data: AuthSuccessPayload): void {
    console.log('Workspace joined successfully', data.workspaceId);
  }
}
