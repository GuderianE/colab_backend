/**
 * Backend Permission Manager
 * Handles all permission logic and enforcement server-side
 */
class PermissionManagerBackend {
  constructor() {
    // Store workspace permissions
    this.workspacePermissions = new Map();
    
    // Default permission template
    this.DEFAULT_PERMISSIONS = {
      canView: true,
      canEditBlocks: false,
      canAddBlocks: false,
      canDeleteBlocks: false,
      canEditSprites: false,
      canAddSprites: false,
      canDeleteSprites: false,
      canEditVariables: false,
      canAddVariables: false,
      canDeleteVariables: false,
      canRunCode: false,
      canStopCode: false,
      canChat: true,
      canDraw: false,
      canUploadAssets: false,
      canEditCostumes: false,
      canEditSounds: false,
      canRecordAudio: false,
      canUseCamera: false,
      canShareProject: false,
      canManageUsers: false,
      canChangePermissions: false,
      canKickUsers: false,
      canLockWorkspace: false
    };
  }

  /**
   * Get owner permissions (all permissions enabled)
   */
  getOwnerPermissions() {
    return {
      canView: true,
      canEditBlocks: true,
      canAddBlocks: true,
      canDeleteBlocks: true,
      canEditSprites: true,
      canAddSprites: true,
      canDeleteSprites: true,
      canEditVariables: true,
      canAddVariables: true,
      canDeleteVariables: true,
      canRunCode: true,
      canStopCode: true,
      canChat: true,
      canDraw: true,
      canUploadAssets: true,
      canEditCostumes: true,
      canEditSounds: true,
      canRecordAudio: true,
      canUseCamera: true,
      canShareProject: true,
      canManageUsers: true,
      canChangePermissions: true,
      canKickUsers: true,
      canLockWorkspace: true
    };
  }

  /**
   * Get teacher permissions
   */
  getTeacherPermissions() {
    return {
      ...this.DEFAULT_PERMISSIONS,
      canView: true,
      canEditBlocks: true,
      canAddBlocks: true,
      canDeleteBlocks: true,
      canEditSprites: true,
      canAddSprites: true,
      canDeleteSprites: true,
      canEditVariables: true,
      canAddVariables: true,
      canDeleteVariables: true,
      canRunCode: true,
      canStopCode: true,
      canChat: true,
      canDraw: true,
      canUploadAssets: true,
      canEditCostumes: true,
      canEditSounds: true,
      canChangePermissions: true,
      canManageUsers: true,
      canKickUsers: true
    };
  }

  /**
   * Get default student permissions
   */
  getStudentPermissions() {
    return {
      ...this.DEFAULT_PERMISSIONS,
      canView: true,
      canChat: true
    };
  }

  /**
   * Initialize workspace permissions
   */
  initializeWorkspace(workspaceId, ownerId) {
    this.workspacePermissions.set(workspaceId, {
      ownerId: ownerId,
      globalPermissions: this.getStudentPermissions(),
      userPermissions: new Map(),
      isLocked: false
    });
  }

  /**
   * Get user's effective permissions
   */
  getUserPermissions(workspaceId, userId) {
    const workspace = this.workspacePermissions.get(workspaceId);
    
    // If workspace doesn't exist, return default permissions
    if (!workspace) {
      return this.getStudentPermissions();
    }

    // Owner has all permissions
    if (workspace.ownerId === userId) {
      return this.getOwnerPermissions();
    }

    // Check for user-specific permissions first
    if (workspace.userPermissions.has(userId)) {
      return workspace.userPermissions.get(userId);
    }

    // Otherwise return global workspace permissions
    return workspace.globalPermissions;
  }

  /**
   * Update global permissions for a workspace
   */
  updateGlobalPermission(workspaceId, permission, value) {
    const workspace = this.workspacePermissions.get(workspaceId);
    if (!workspace) return false;

    workspace.globalPermissions[permission] = value;
    return true;
  }

  /**
   * Update specific user's permissions
   */
  updateUserPermission(workspaceId, userId, permission, value) {
    const workspace = this.workspacePermissions.get(workspaceId);
    if (!workspace) return false;

    // Initialize user permissions if not exists
    if (!workspace.userPermissions.has(userId)) {
      workspace.userPermissions.set(userId, { ...workspace.globalPermissions });
    }

    workspace.userPermissions.get(userId)[permission] = value;
    return true;
  }

  /**
   * Set user as teacher
   */
  setUserAsTeacher(workspaceId, userId) {
    const workspace = this.workspacePermissions.get(workspaceId);
    if (!workspace) return false;

    workspace.userPermissions.set(userId, this.getTeacherPermissions());
    return true;
  }

  /**
   * Apply preset modes
   */
  applyPresetMode(workspaceId, mode) {
    const workspace = this.workspacePermissions.get(workspaceId);
    if (!workspace) return false;

    switch(mode) {
      case 'presentation':
        workspace.globalPermissions = {
          ...this.DEFAULT_PERMISSIONS,
          canView: true,
          canChat: false
        };
        break;
      
      case 'work':
        workspace.globalPermissions = {
          ...this.DEFAULT_PERMISSIONS,
          canView: true,
          canEditBlocks: true,
          canAddBlocks: true,
          canEditSprites: true,
          canRunCode: true,
          canChat: true
        };
        break;
      
      case 'test':
      case 'restricted':
        workspace.globalPermissions = {
          ...this.DEFAULT_PERMISSIONS,
          canView: true,
          canRunCode: mode === 'test',
          canChat: false
        };
        break;
    }

    return true;
  }

  /**
   * Check if user has specific permission
   */
  hasPermission(workspaceId, userId, permission) {
  const perms = this.getUserPermissions(workspaceId, userId);
  return !!perms?.[permission];
  }

  /**
   * Clean up workspace
   */
  deleteWorkspace(workspaceId) {
    this.workspacePermissions.delete(workspaceId);
  }
}

module.exports = PermissionManagerBackend;
