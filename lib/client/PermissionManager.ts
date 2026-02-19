import type { CollaborationMessage, PermissionSet } from '../../types/collaboration';
import type { AuthSuccessPayload } from './WebSocketClient';
import type WebSocketClient from './WebSocketClient';

export type CollaborationUser = {
  userId: string;
  username: string;
  isOwner: boolean;
  permissions: Partial<PermissionSet>;
};

/**
 * Frontend Permission Manager
 * Maintains current user's permissions and sends updates to server
 */
export default class PermissionManager {
  wsClient: WebSocketClient;

  currentPermissions: Partial<PermissionSet>;

  users: Map<string, CollaborationUser>;

  onPermissionsUpdatedCallback: ((permissions: Partial<PermissionSet>) => void) | null;

  onUserListUpdatedCallback: ((users: CollaborationUser[]) => void) | null;

  constructor(wsClient: WebSocketClient) {
    this.wsClient = wsClient;
    this.currentPermissions = {};
    this.users = new Map();

    this.onPermissionsUpdatedCallback = null;
    this.onUserListUpdatedCallback = null;

    this.bindHandlers();
  }

  bindHandlers(): void {
    this.wsClient.addEventListener('onAuthenticated', (data: AuthSuccessPayload) => {
      this.currentPermissions = data.permissions || {};
      this.users = new Map((data.users || []).map((u) => [u.userId, u]));
      this.onPermissionsUpdated();
      this.onUserListUpdated();
    });

    this.wsClient.on('permissions_updated', (data: CollaborationMessage) => {
      const permissions = data.permissions;
      if (permissions && typeof permissions === 'object') {
        this.currentPermissions = permissions as Partial<PermissionSet>;
      }
      this.onPermissionsUpdated();
    });

    this.wsClient.on('user_joined', (data: CollaborationMessage) => {
      const userId = typeof data.userId === 'string' ? data.userId : '';
      if (!userId) return;

      this.users.set(userId, {
        userId,
        username: typeof data.username === 'string' ? data.username : 'User',
        isOwner: false,
        permissions: {}
      });
      this.onUserListUpdated();
    });

    this.wsClient.on('user_left', (data: CollaborationMessage) => {
      const userId = typeof data.userId === 'string' ? data.userId : '';
      if (!userId) return;
      this.users.delete(userId);
      this.onUserListUpdated();
    });

    this.wsClient.on('user_updated', (data: CollaborationMessage) => {
      const userId = typeof data.userId === 'string' ? data.userId : '';
      if (!userId) return;

      const user = this.users.get(userId) || { userId, username: 'User', isOwner: false, permissions: {} };
      if (data.permissions && typeof data.permissions === 'object') {
        user.permissions = data.permissions as Partial<PermissionSet>;
      }
      if (typeof data.username === 'string' && data.username) {
        user.username = data.username;
      }
      this.users.set(userId, user);
      this.onUserListUpdated();
    });
  }

  onPermissionsUpdated(): void {
    if (typeof this.onPermissionsUpdatedCallback === 'function') {
      this.onPermissionsUpdatedCallback(this.currentPermissions);
    }
  }

  onUserListUpdated(): void {
    if (typeof this.onUserListUpdatedCallback === 'function') {
      this.onUserListUpdatedCallback(Array.from(this.users.values()));
    }
  }

  hasPermission(permissionKey: keyof PermissionSet): boolean {
    return !!this.currentPermissions[permissionKey];
  }

  requestTeacherRole(): void {
    this.wsClient.send({ type: 'request_teacher_role' });
  }

  updateGlobalPermission(permission: keyof PermissionSet, value: boolean): void {
    this.wsClient.send({ type: 'update_global_permission', permission, value });
  }

  updateUserPermission(targetUserId: string, permission: keyof PermissionSet, value: boolean): void {
    this.wsClient.send({ type: 'update_user_permission', targetUserId, permission, value });
  }

  updateUsername(username: string): boolean {
    const normalized = username.trim().slice(0, 64);
    if (!normalized) {
      return false;
    }
    return this.wsClient.send({ type: 'update_username', username: normalized });
  }

  setPresentationMode(): void {
    this.wsClient.send({ type: 'apply_preset_mode', mode: 'presentation' });
  }

  setWorkMode(): void {
    this.wsClient.send({ type: 'apply_preset_mode', mode: 'work' });
  }

  setTestMode(): void {
    this.wsClient.send({ type: 'apply_preset_mode', mode: 'test' });
  }

  setRestrictedMode(): void {
    this.wsClient.send({ type: 'apply_preset_mode', mode: 'restricted' });
  }

  onPermissionDenied(action: string, subject: string): void {
    this.showError(`Permission denied: cannot ${action} ${subject}`);
  }

  showNotification(msg: string): void {
    console.log(msg);
  }

  showError(msg: string): void {
    console.error(msg);
  }
}
