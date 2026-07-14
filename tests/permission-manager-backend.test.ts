import test from 'node:test';
import assert from 'node:assert/strict';
import PermissionManagerBackend from '../permission-manager-backend';

test('returns student defaults for unknown workspace', () => {
  const manager = new PermissionManagerBackend();
  const permissions = manager.getUserPermissions('missing', 'student-1');

  assert.equal(permissions.canView, true);
  assert.equal(permissions.canEditBlocks, false);
  assert.equal(permissions.canAccessLevelEditor, false);
  assert.equal(permissions.canEditSounds, false);
  assert.equal(permissions.canRestoreVersions, false);
});

test('global permission update applies to workspace users', () => {
  const manager = new PermissionManagerBackend();
  manager.initializeWorkspace('ws-1');

  assert.equal(manager.updateGlobalPermission('ws-1', 'canEditBlocks', true), true);
  assert.equal(manager.updateGlobalPermission('ws-1', 'canEditSounds', true), true);
  assert.equal(manager.updateGlobalPermission('ws-1', 'canRestoreVersions', true), true);
  const permissions = manager.getUserPermissions('ws-1', 'student-1');
  assert.equal(permissions.canEditBlocks, true);
  assert.equal(permissions.canEditSounds, true);
  assert.equal(permissions.canRestoreVersions, true);
});

test('user override permission wins over global permission', () => {
  const manager = new PermissionManagerBackend();
  manager.initializeWorkspace('ws-1');
  manager.updateGlobalPermission('ws-1', 'canEditBlocks', false);
  manager.updateGlobalPermission('ws-1', 'canEditSounds', false);
  manager.updateGlobalPermission('ws-1', 'canRestoreVersions', false);
  manager.updateUserPermission('ws-1', 'student-1', 'canEditBlocks', true);
  manager.updateUserPermission('ws-1', 'student-1', 'canEditSounds', true);
  manager.updateUserPermission('ws-1', 'student-1', 'canRestoreVersions', true);

  const permissions = manager.getUserPermissions('ws-1', 'student-1');
  assert.equal(permissions.canEditBlocks, true);
  assert.equal(permissions.canEditSounds, true);
  assert.equal(permissions.canRestoreVersions, true);
});

test('teacher/admin role assignment grants elevated permissions', () => {
  const manager = new PermissionManagerBackend();
  manager.initializeWorkspace('ws-1');

  assert.equal(manager.setUserAsTeacher('ws-1', 'teacher-1'), true);
  assert.equal(manager.setUserAsAdmin('ws-1', 'admin-1'), true);

  const teacher = manager.getUserPermissions('ws-1', 'teacher-1');
  const admin = manager.getUserPermissions('ws-1', 'admin-1');

  assert.equal(teacher.canRestoreVersions, true);
  assert.equal(teacher.canEditSounds, true);
  assert.equal(admin.canRestoreVersions, true);
  assert.equal(admin.canEditSounds, true);
  assert.equal(teacher.canChangePermissions, true);
  assert.equal(teacher.canLockWorkspace, false);
  assert.equal(admin.canLockWorkspace, true);
  assert.equal(admin.canManageUsers, true);
});

test('preset modes apply expected behavior', () => {
  const manager = new PermissionManagerBackend();
  manager.initializeWorkspace('ws-1');

  assert.equal(manager.applyPresetMode('ws-1', 'presentation'), true);
  let permissions = manager.getUserPermissions('ws-1', 'student-1');
  assert.equal(permissions.canView, true);
  assert.equal(permissions.canChat, false);
  assert.equal(permissions.canEditBlocks, false);

  assert.equal(manager.applyPresetMode('ws-1', 'work'), true);
  permissions = manager.getUserPermissions('ws-1', 'student-1');
  assert.equal(permissions.canAddBlocks, true);
  assert.equal(permissions.canRunCode, true);

  assert.equal(manager.applyPresetMode('ws-1', 'test'), true);
  permissions = manager.getUserPermissions('ws-1', 'student-1');
  assert.equal(permissions.canRunCode, true);
  assert.equal(permissions.canChat, false);
});

test('invalid permission updates are rejected', () => {
  const manager = new PermissionManagerBackend();
  manager.initializeWorkspace('ws-1');

  assert.equal(manager.updateGlobalPermission('ws-1', 'notAKey', true), false);
  assert.equal(manager.updateUserPermission('ws-1', 'u1', 'canEditBlocks', 'yes'), false);
  assert.equal(manager.applyPresetMode('ws-1', 'unsupported-mode'), false);
});

test('role permission presets expose canRestoreVersions for elevated roles only', () => {
  const manager = new PermissionManagerBackend();

  assert.equal(manager.getRolePermissions('ADMIN').canRestoreVersions, true);
  assert.equal(manager.getRolePermissions('TEACHER').canRestoreVersions, true);
  assert.equal(manager.getRolePermissions('STUDENT').canRestoreVersions, false);
  assert.equal(manager.getRolePermissions('PARENT').canRestoreVersions, false);
});

test('serialize/hydrate round-trips global + user permission state', () => {
  const manager = new PermissionManagerBackend();
  manager.initializeWorkspace('ws-rt');
  manager.updateGlobalPermission('ws-rt', 'canEditBlocks', true);
  manager.updateGlobalPermission('ws-rt', 'canRunCode', true);
  manager.updateUserPermission('ws-rt', 'student-42', 'canChat', false);

  const serialized = manager.serializeWorkspace('ws-rt');
  assert.ok(serialized);
  assert.equal(serialized.globalPermissions.canEditBlocks, true);
  assert.equal(serialized.userPermissions['student-42'].canChat, false);

  // Fresh manager, hydrate from the persisted JSON.
  const restored = new PermissionManagerBackend();
  assert.equal(restored.hydrateWorkspace('ws-rt', serialized), true);
  const global = restored.getUserPermissions('ws-rt', 'someone-else');
  assert.equal(global.canEditBlocks, true);
  assert.equal(global.canRunCode, true);
  const student = restored.getUserPermissions('ws-rt', 'student-42');
  assert.equal(student.canChat, false);
  assert.equal(student.canEditBlocks, true); // inherits the global override
});

test('serializeWorkspace returns null for an unknown workspace', () => {
  const manager = new PermissionManagerBackend();
  assert.equal(manager.serializeWorkspace('nope'), null);
});

test('hydrateWorkspace defensively ignores junk and fills missing global keys with defaults', () => {
  const manager = new PermissionManagerBackend();
  assert.equal(manager.hydrateWorkspace('ws-junk', null), false);
  assert.equal(manager.hydrateWorkspace('ws-junk', 'nope'), false);

  // Partial/garbage blob: only a couple of valid keys, an invalid key, bad types.
  assert.equal(
    manager.hydrateWorkspace('ws-junk', {
      globalPermissions: { canEditBlocks: true, notAKey: true, canChat: 'yes' },
      userPermissions: { u1: { canChat: false, bogus: 1 }, '': { canChat: false } },
      isLocked: 'nope',
    }),
    true,
  );
  const perms = manager.getUserPermissions('ws-junk', 'u1');
  assert.equal(perms.canEditBlocks, true);   // valid stored key
  assert.equal(perms.canView, true);          // default filled for a key absent from blob
  assert.equal(perms.canChat, false);         // valid user override applied
  assert.equal(manager.hasUserOverride('ws-junk', 'u1'), true);
  assert.equal(manager.hasUserOverride('ws-junk', ''), false); // empty userId dropped
});
