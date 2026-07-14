import { PERMISSION_KEYS, type PermissionKey, type PermissionSet, isPermissionKey } from './types/collaboration';
import type { UserRole } from './types/collaboration';

type PresetMode = 'presentation' | 'work' | 'test' | 'restricted';

type WorkspacePermissionState = {
  globalPermissions: PermissionSet;
  userPermissions: Map<string, Partial<PermissionSet>>;
  isLocked: boolean;
};

/** Plain-JSON form of a workspace's permission state, for DB persistence. */
export type SerializedWorkspacePermissionState = {
  globalPermissions: PermissionSet;
  userPermissions: Record<string, Partial<PermissionSet>>;
  isLocked: boolean;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

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
      canRestoreVersions: false,
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
      canAccessLevelEditor: false,
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
      canRestoreVersions: true,
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
      canAccessLevelEditor: true,
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
      canRestoreVersions: true,
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
      canAccessLevelEditor: true,
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

    const overrides = workspace.userPermissions.get(userId);
    if (!overrides) {
      return { ...workspace.globalPermissions };
    }

    return {
      ...workspace.globalPermissions,
      ...overrides,
    };
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

    const userPermissions = workspace.userPermissions.get(userId) ?? {};
    userPermissions[permission] = value;
    workspace.userPermissions.set(userId, userPermissions);
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

  hasUserOverride(workspaceId: string, userId: string): boolean {
    const workspace = this.workspacePermissions.get(workspaceId);
    if (!workspace) return false;
    return workspace.userPermissions.has(userId);
  }

  getRolePermissions(role: UserRole): PermissionSet {
    switch (role) {
      case 'ADMIN':
        return this.getOwnerPermissions();
      case 'TEACHER':
        return this.getTeacherPermissions();
      case 'PARENT':
      case 'STUDENT':
      default:
        return this.getStudentPermissions();
    }
  }

  deleteWorkspace(workspaceId: string): void {
    this.workspacePermissions.delete(workspaceId);
  }

  /**
   * Snapshot a workspace's permission state as plain JSON for DB persistence. Returns
   * null if the workspace has no state (nothing to persist).
   */
  serializeWorkspace(workspaceId: string): SerializedWorkspacePermissionState | null {
    const workspace = this.workspacePermissions.get(workspaceId);
    if (!workspace) return null;
    const userPermissions: Record<string, Partial<PermissionSet>> = {};
    workspace.userPermissions.forEach((overrides, userId) => {
      userPermissions[userId] = { ...overrides };
    });
    return {
      globalPermissions: { ...workspace.globalPermissions },
      userPermissions,
      isLocked: workspace.isLocked,
    };
  }

  /**
   * Replace a workspace's permission state from persisted JSON (defensively — unknown or
   * missing keys are dropped, and any global key absent from the stored blob falls back to
   * the safe default). Returns true if a valid state was applied.
   */
  hydrateWorkspace(workspaceId: string, raw: unknown): boolean {
    if (!isRecord(raw)) return false;

    const globalPermissions: PermissionSet = { ...this.DEFAULT_PERMISSIONS };
    if (isRecord(raw.globalPermissions)) {
      for (const key of PERMISSION_KEYS) {
        const value = raw.globalPermissions[key];
        if (typeof value === 'boolean') {
          globalPermissions[key] = value;
        }
      }
    }

    const userPermissions = new Map<string, Partial<PermissionSet>>();
    if (isRecord(raw.userPermissions)) {
      for (const [userId, overridesRaw] of Object.entries(raw.userPermissions)) {
        if (!userId || !isRecord(overridesRaw)) continue;
        const overrides: Partial<PermissionSet> = {};
        for (const [key, value] of Object.entries(overridesRaw)) {
          if (isPermissionKey(key) && typeof value === 'boolean') {
            overrides[key] = value;
          }
        }
        if (Object.keys(overrides).length > 0) {
          userPermissions.set(userId, overrides);
        }
      }
    }

    this.workspacePermissions.set(workspaceId, {
      globalPermissions,
      userPermissions,
      isLocked: typeof raw.isLocked === 'boolean' ? raw.isLocked : false,
    });
    return true;
  }
}
