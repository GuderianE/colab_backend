/**
 * Frontend Permission Manager
 * Maintains current user's permissions and sends updates to server
 */
class PermissionManager {
  constructor(wsClient) {
    this.wsClient = wsClient;
    this.currentPermissions = {};
    this.users = new Map();

    // UI callbacks (to be overridden by app)
    this.onPermissionsUpdatedCallback = null;
    this.onUserListUpdatedCallback = null;

    // Bind message handlers
    this.bindHandlers();
  }

  bindHandlers() {
    // When authenticated, capture initial permissions and users
    this.wsClient.addEventListener('onAuthenticated', (data) => {
      this.currentPermissions = data.permissions || {};
      this.users = new Map((data.users || []).map(u => [u.userId, u]));
      this.onPermissionsUpdated();
      this.onUserListUpdated();
    });

    // Permissions updated
    this.wsClient.on('permissions_updated', (data) => {
      this.currentPermissions = data.permissions || this.currentPermissions;
      this.onPermissionsUpdated();
    });

    // Users join/leave/update
    this.wsClient.on('user_joined', (data) => {
      this.users.set(data.userId, { userId: data.userId, username: data.username || 'User', isOwner: false, permissions: {} });
      this.onUserListUpdated();
    });
    this.wsClient.on('user_left', (data) => {
      this.users.delete(data.userId);
      this.onUserListUpdated();
    });
    this.wsClient.on('user_updated', (data) => {
      const u = this.users.get(data.userId) || { userId: data.userId };
      u.permissions = data.permissions;
      this.users.set(data.userId, u);
      this.onUserListUpdated();
    });
  }

  // UI notification hooks
  onPermissionsUpdated() {
    if (typeof this.onPermissionsUpdatedCallback === 'function') {
      this.onPermissionsUpdatedCallback(this.currentPermissions);
    }
  }
  onUserListUpdated() {
    if (typeof this.onUserListUpdatedCallback === 'function') {
      this.onUserListUpdatedCallback(Array.from(this.users.values()));
    }
  }

  // Permission checks
  hasPermission(permissionKey) {
    return !!this.currentPermissions[permissionKey];
  }

  // Actions
  requestTeacherRole() {
    this.wsClient.send({ type: 'request_teacher_role' });
  }
  updateGlobalPermission(permission, value) {
    this.wsClient.send({ type: 'update_global_permission', permission, value });
  }
  updateUserPermission(targetUserId, permission, value) {
    this.wsClient.send({ type: 'update_user_permission', targetUserId, permission, value });
  }
  setPresentationMode() {
    this.wsClient.send({ type: 'apply_preset_mode', mode: 'presentation' });
  }
  setWorkMode() {
    this.wsClient.send({ type: 'apply_preset_mode', mode: 'work' });
  }
  setTestMode() {
    this.wsClient.send({ type: 'apply_preset_mode', mode: 'test' });
  }
  setRestrictedMode() {
    this.wsClient.send({ type: 'apply_preset_mode', mode: 'restricted' });
  }

  // UI helper hooks (set by app)
  showNotification(msg) { console.log(msg); }
  showError(msg) { console.error(msg); }
}

// Export for modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = PermissionManager;
}