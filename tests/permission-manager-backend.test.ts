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
