export const PERMISSION_KEYS = [
  'canView',
  'canEditBlocks',
  'canAddBlocks',
  'canDeleteBlocks',
  'canEditSprites',
  'canAddSprites',
  'canDeleteSprites',
  'canEditVariables',
  'canAddVariables',
  'canDeleteVariables',
  'canRunCode',
  'canStopCode',
  'canChat',
  'canDraw',
  'canUploadAssets',
  'canEditCostumes',
  'canEditSounds',
  'canRecordAudio',
  'canUseCamera',
  'canShareProject',
  'canManageUsers',
  'canChangePermissions',
  'canKickUsers',
  'canLockWorkspace'
] as const;

export type PermissionKey = (typeof PERMISSION_KEYS)[number];
export type PermissionSet = Record<PermissionKey, boolean>;

export type Coordinates = {
  x: number;
  y: number;
};

export type WorkspaceUser = {
  userId: string;
  username: string;
  permissions: PermissionSet;
  isOwner: boolean;
  coords?: Coordinates;
};

export type CollaborationMessage = {
  type: string;
  [key: string]: unknown;
};

export const isPermissionKey = (value: unknown): value is PermissionKey => {
  return typeof value === 'string' && PERMISSION_KEYS.includes(value as PermissionKey);
};
