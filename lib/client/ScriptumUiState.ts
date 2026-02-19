import type { PermissionSet } from '../../types/collaboration';
import type { CollaborationUser } from './PermissionManager';

export type ScriptumPresenceCircle = {
  userId: string;
  username: string;
  initials: string;
  isSelf: boolean;
  isOwner: boolean;
};

export type ScriptumTopRightState = {
  showPermissionsButton: boolean;
  joinedUsersCount: number;
  circles: ScriptumPresenceCircle[];
};

function toInitials(username: string): string {
  const words = username.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return 'U';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return `${words[0][0] || ''}${words[1][0] || ''}`.toUpperCase();
}

export function buildScriptumTopRightState(
  currentUserId: string | null,
  currentPermissions: Partial<PermissionSet>,
  users: CollaborationUser[]
): ScriptumTopRightState {
  const sortedUsers = users.slice().sort((a, b) => {
    if (a.userId === currentUserId) return -1;
    if (b.userId === currentUserId) return 1;
    if (a.isOwner && !b.isOwner) return -1;
    if (!a.isOwner && b.isOwner) return 1;
    return a.username.localeCompare(b.username);
  });

  return {
    showPermissionsButton: !!currentPermissions.canChangePermissions,
    joinedUsersCount: users.length,
    circles: sortedUsers.map((user) => ({
      userId: user.userId,
      username: user.username,
      initials: toInitials(user.username),
      isSelf: user.userId === currentUserId,
      isOwner: user.isOwner
    }))
  };
}
