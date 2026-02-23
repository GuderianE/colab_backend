import { type PermissionKey, type PermissionSet, isPermissionKey } from './types/collaboration';

type PresetMode = 'presentation' | 'work' | 'test' | 'restricted';

type WorkspacePermissionState = {
  globalPermissions: PermissionSet;
  userPermissions: Map<string, PermissionSet>;
  isLocked: boolean;
};

/**
 * Backend Permission Manager
 * Handles all permission logic and enforcement server-side
 */
export default class PermissionManagerBackend {
  private workspacePermissions: Map<string, WorkspacePermissionState>;

  private readonly DEFAULT_PERMISSIONS: PermissionSet;

  constructor() {
    this.workspacePermissions = new Map();

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

  getOwnerPermissions(): PermissionSet {
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

  getTeacherPermissions(): PermissionSet {
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

  getStudentPermissions(): PermissionSet {
    return {
      ...this.DEFAULT_PERMISSIONS,
      canView: true,
      canChat: true
    };
  }

  initializeWorkspace(workspaceId: string): void {
    this.workspacePermissions.set(workspaceId, {
      globalPermissions: this.getStudentPermissions(),
      userPermissions: new Map(),
      isLocked: false
    });
  }

  getUserPermissions(workspaceId: string, userId: string): PermissionSet {
    const workspace = this.workspacePermissions.get(workspaceId);

    if (!workspace) {
      return this.getStudentPermissions();
    }

    if (workspace.userPermissions.has(userId)) {
      return workspace.userPermissions.get(userId);
    }

    return workspace.globalPermissions;
  }

  updateGlobalPermission(workspaceId: string, permission: unknown, value: unknown): boolean {
    const workspace = this.workspacePermissions.get(workspaceId);
    if (!workspace || !isPermissionKey(permission) || typeof value !== 'boolean') return false;

    workspace.globalPermissions[permission] = value;
    return true;
  }

  updateUserPermission(
    workspaceId: string,
    userId: string,
    permission: unknown,
    value: unknown
  ): boolean {
    const workspace = this.workspacePermissions.get(workspaceId);
    if (!workspace || !isPermissionKey(permission) || typeof value !== 'boolean') return false;

    if (!workspace.userPermissions.has(userId)) {
      workspace.userPermissions.set(userId, { ...workspace.globalPermissions });
    }

    const userPermissions = workspace.userPermissions.get(userId);
    if (!userPermissions) return false;

    userPermissions[permission] = value;
    return true;
  }

  setUserAsTeacher(workspaceId: string, userId: string): boolean {
    const workspace = this.workspacePermissions.get(workspaceId);
    if (!workspace) return false;

    workspace.userPermissions.set(userId, this.getTeacherPermissions());
    return true;
  }

  setUserAsAdmin(workspaceId: string, userId: string): boolean {
    const workspace = this.workspacePermissions.get(workspaceId);
    if (!workspace) return false;

    workspace.userPermissions.set(userId, this.getOwnerPermissions());
    return true;
  }

  clearUserPermissions(workspaceId: string, userId: string): boolean {
    const workspace = this.workspacePermissions.get(workspaceId);
    if (!workspace) return false;
    workspace.userPermissions.delete(userId);
    return true;
  }

  applyPresetMode(workspaceId: string, mode: unknown): boolean {
    const workspace = this.workspacePermissions.get(workspaceId);
    if (!workspace || typeof mode !== 'string') return false;

    const normalizedMode = mode as PresetMode;

    switch (normalizedMode) {
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
          canRunCode: normalizedMode === 'test',
          canChat: false
        };
        break;

      default:
        return false;
    }

    return true;
  }

  hasPermission(workspaceId: string, userId: string, permission: PermissionKey): boolean {
    const permissions = this.getUserPermissions(workspaceId, userId);
    return !!permissions?.[permission];
  }

  deleteWorkspace(workspaceId: string): void {
    this.workspacePermissions.delete(workspaceId);
  }
}
