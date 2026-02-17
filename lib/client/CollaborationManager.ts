import type { CollaborationMessage, Coordinates, PermissionSet } from '../../types/collaboration';
import type PermissionManager from './PermissionManager';
import type WebSocketClient from './WebSocketClient';

type LockInfo = {
  version: number;
  lockedBy: string;
};

/**
 * Collaboration Manager
 * Handles element operations, locking, and real-time collaboration
 */
export default class CollaborationManager {
  wsClient: WebSocketClient;

  permissionManager: PermissionManager;

  lockedElements: Map<string, LockInfo>;

  elementVersions: Map<string, number>;

  cursors: Map<string, { userId: string }>;

  constructor(wsClient: WebSocketClient, permissionManager: PermissionManager) {
    this.wsClient = wsClient;
    this.permissionManager = permissionManager;

    this.lockedElements = new Map();
    this.elementVersions = new Map();
    this.cursors = new Map();

    this.setupMessageHandlers();
  }

  setupMessageHandlers(): void {
    this.wsClient.on('lock_granted', (data: CollaborationMessage) => {
      const elementId = typeof data.elementId === 'string' ? data.elementId : '';
      const version = Number(data.version ?? 0);
      if (!elementId) return;

      this.lockedElements.set(elementId, {
        version,
        lockedBy: this.wsClient.userId || ''
      });
      this.onLockGranted(elementId, version);
    });

    this.wsClient.on('lock_denied', (data: CollaborationMessage) => {
      const elementId = typeof data.elementId === 'string' ? data.elementId : '';
      const lockedBy = typeof data.lockedBy === 'string' ? data.lockedBy : null;
      if (!elementId) return;
      this.onLockDenied(elementId, lockedBy);
    });

    this.wsClient.on('element_locked', (data: CollaborationMessage) => {
      const elementId = typeof data.elementId === 'string' ? data.elementId : '';
      const version = Number(data.version ?? 0);
      const lockedBy = typeof data.lockedBy === 'string' ? data.lockedBy : '';
      if (!elementId || !lockedBy) return;

      this.lockedElements.set(elementId, {
        version,
        lockedBy
      });
      this.onElementLocked(elementId, lockedBy);
    });

    this.wsClient.on('element_unlocked', (data: CollaborationMessage) => {
      const elementId = typeof data.elementId === 'string' ? data.elementId : '';
      if (!elementId) return;
      this.lockedElements.delete(elementId);
      const finalPosition =
        data.finalPosition && typeof data.finalPosition === 'object'
          ? (data.finalPosition as Coordinates)
          : undefined;
      this.onElementUnlocked(elementId, finalPosition);
    });

    this.wsClient.on('block_move', (data: CollaborationMessage) => {
      this.onBlockMoved(
        typeof data.userId === 'string' ? data.userId : '',
        typeof data.blockId === 'string' ? data.blockId : '',
        data.position as Coordinates
      );
    });

    this.wsClient.on('sprite_update', (data: CollaborationMessage) => {
      this.onSpriteUpdated(
        typeof data.userId === 'string' ? data.userId : '',
        typeof data.spriteId === 'string' ? data.spriteId : '',
        Number(data.x ?? 0),
        Number(data.y ?? 0)
      );
    });

    this.wsClient.on('coords_update', (data: CollaborationMessage) => {
      const userId = typeof data.userId === 'string' ? data.userId : '';
      if (!userId) return;
      this.updateCursor(userId, (data.coords as Coordinates) || { x: 0, y: 0 });
    });

    this.wsClient.on('element_created', (data: CollaborationMessage) => {
      this.onElementCreated(
        typeof data.elementType === 'string' ? data.elementType : '',
        data.elementData,
        typeof data.createdBy === 'string' ? data.createdBy : ''
      );
    });

    this.wsClient.on('element_deleted', (data: CollaborationMessage) => {
      this.onElementDeleted(
        typeof data.elementId === 'string' ? data.elementId : '',
        typeof data.elementType === 'string' ? data.elementType : '',
        typeof data.deletedBy === 'string' ? data.deletedBy : ''
      );
    });

    this.wsClient.on('user_updated', (data: CollaborationMessage) => {
      if (!this.permissionManager.users) return;
      const userId = typeof data.userId === 'string' ? data.userId : '';
      if (!userId) return;
      const user = this.permissionManager.users.get(userId);
      if (user && data.permissions && typeof data.permissions === 'object') {
        user.permissions = data.permissions as Partial<PermissionSet>;
        this.permissionManager.onUserListUpdated();
      }
    });
  }

  requestLock(elementId: string, elementType: string): boolean {
    let permissionNeeded: keyof PermissionSet = 'canEditBlocks';
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
      elementId,
      elementType
    });
  }

  releaseLock(elementId: string, finalPosition: Coordinates): boolean {
    if (!this.lockedElements.has(elementId)) {
      return false;
    }

    this.lockedElements.delete(elementId);

    return this.wsClient.send({
      type: 'release_lock',
      elementId,
      finalPosition
    });
  }

  updateElementPosition(elementId: string, elementType: string, position: Coordinates): boolean {
    if (elementType === 'sprite') {
      return this.updateSpritePosition(elementId, position.x, position.y);
    }
    return this.updateBlockPosition(elementId, position);
  }

  updateBlockPosition(blockId: string, position: Coordinates): boolean {
    if (!this.permissionManager.hasPermission('canEditBlocks')) {
      return false;
    }

    const lockInfo = this.lockedElements.get(blockId);

    return this.wsClient.send({
      type: 'block_move',
      blockId,
      position,
      version: lockInfo ? lockInfo.version : 0
    });
  }

  updateSpritePosition(spriteId: string, x: number, y: number): boolean {
    if (!this.permissionManager.hasPermission('canEditSprites')) {
      return false;
    }

    const lockInfo = this.lockedElements.get(spriteId);

    return this.wsClient.send({
      type: 'sprite_update',
      spriteId,
      x,
      y,
      version: lockInfo ? lockInfo.version : 0
    });
  }

  createElement(elementType: string, elementData: unknown): boolean {
    let permissionNeeded: keyof PermissionSet = 'canAddBlocks';
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
      elementType,
      elementData
    });
  }

  deleteElement(elementId: string, elementType: string): boolean {
    let permissionNeeded: keyof PermissionSet = 'canDeleteBlocks';
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
      elementId,
      elementType
    });
  }

  updateCursorPosition(x: number, y: number): boolean {
    return this.wsClient.send({
      type: 'update_coords',
      coords: { x, y }
    });
  }

  runCode(scriptId: string): boolean {
    if (!this.permissionManager.hasPermission('canRunCode')) {
      this.permissionManager.onPermissionDenied('run', 'code');
      return false;
    }

    return this.wsClient.send({
      type: 'run_code',
      scriptId
    });
  }

  isElementLocked(elementId: string): boolean {
    return this.lockedElements.has(elementId);
  }

  isElementLockedByMe(elementId: string): boolean {
    const lock = this.lockedElements.get(elementId);
    return !!lock && lock.lockedBy === this.wsClient.userId;
  }

  getLockInfo(elementId: string): LockInfo | undefined {
    return this.lockedElements.get(elementId);
  }

  updateCursor(userId: string, coords: Coordinates): void {
    if (!this.cursors.has(userId) && userId !== this.wsClient.userId) {
      this.createCursor(userId);
    }

    const cursor = this.cursors.get(userId);
    if (cursor) {
      this.onCursorUpdated(userId, coords);
    }
  }

  createCursor(userId: string): void {
    this.cursors.set(userId, { userId });
    this.onCursorCreated(userId);
  }

  removeCursor(userId: string): void {
    if (this.cursors.has(userId)) {
      this.cursors.delete(userId);
      this.onCursorRemoved(userId);
    }
  }

  onLockGranted(_elementId: string, _version: number): void {}

  onLockDenied(_elementId: string, _lockedBy: string | null): void {}

  onElementLocked(_elementId: string, _lockedBy: string): void {}

  onElementUnlocked(_elementId: string, _finalPosition?: Coordinates): void {}

  onBlockMoved(_userId: string, _blockId: string, _position: Coordinates): void {}

  onSpriteUpdated(_userId: string, _spriteId: string, _x: number, _y: number): void {}

  onElementCreated(_elementType: string, _elementData: unknown, _createdBy: string): void {}

  onElementDeleted(_elementId: string, _elementType: string, _deletedBy: string): void {}

  onCursorCreated(_userId: string): void {}

  onCursorUpdated(_userId: string, _coords: Coordinates): void {}

  onCursorRemoved(_userId: string): void {}
}
