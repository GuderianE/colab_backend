import assert from 'node:assert/strict';
import test from 'node:test';

import {
  deleteWorkspaceSharedState,
  ensureWorkspaceSharedState,
  replaceWorkspaceSharedState,
  sharedStateToPayload,
  type WorkspaceElementState,
  type WorkspaceSharedStatePayload,
  type WorkspaceSnapshotState,
  type WorkspaceSpriteMetrics
} from '../shared-state';

function element(overrides: Partial<WorkspaceElementState> & Pick<WorkspaceElementState, 'elementType' | 'elementId'>): WorkspaceElementState {
  return {
    elementData: { foo: 'bar' },
    version: 1,
    etag: 'etag',
    firstEditedBy: 'u1',
    firstEditedAt: 100,
    updatedBy: 'u1',
    updatedAt: 100,
    ...overrides
  };
}

function metrics(spriteId: string): WorkspaceSpriteMetrics {
  return {
    spriteId,
    x: 1,
    y: 2,
    rotation: 90,
    size: 100,
    visible: true,
    version: 1,
    etag: 'etag',
    firstEditedBy: 'u1',
    firstEditedAt: 100,
    updatedBy: 'u1',
    updatedAt: 100
  };
}

function snapshot(spriteId: string): WorkspaceSnapshotState {
  return {
    spriteId,
    serializedJson: `{"sprite":"${spriteId}"}`,
    blocksJson: { blocks: {} },
    version: 1,
    etag: 'etag',
    firstEditedBy: 'u1',
    firstEditedAt: 100,
    updatedBy: 'u1',
    updatedAt: 100
  };
}

test('replaceWorkspaceSharedState round-trips a payload through sharedStateToPayload', () => {
  const workspaceId = 'ws-roundtrip';
  const payload: WorkspaceSharedStatePayload = {
    elements: [
      element({ elementType: 'sprite', elementId: 's1' }),
      element({ elementType: 'block', elementId: 'b1' })
    ],
    spriteMetrics: [metrics('s1')],
    workspaceSnapshots: [snapshot('s1')]
  };

  replaceWorkspaceSharedState(workspaceId, payload);
  const roundTripped = sharedStateToPayload(ensureWorkspaceSharedState(workspaceId));

  assert.deepEqual(roundTripped, payload);
  deleteWorkspaceSharedState(workspaceId);
});

test('replaceWorkspaceSharedState keys elements by elementType:elementId and sprite data by spriteId', () => {
  const workspaceId = 'ws-keys';
  replaceWorkspaceSharedState(workspaceId, {
    elements: [element({ elementType: 'sprite', elementId: 's1' })],
    spriteMetrics: [metrics('s1')],
    workspaceSnapshots: [snapshot('s1')]
  });

  const state = ensureWorkspaceSharedState(workspaceId);
  assert.equal(state.elements.get('sprite:s1')?.elementId, 's1');
  assert.equal(state.spriteMetrics.get('s1')?.spriteId, 's1');
  assert.equal(state.workspaceSnapshots.get('s1')?.spriteId, 's1');
  deleteWorkspaceSharedState(workspaceId);
});

test('replaceWorkspaceSharedState is a REPLACE — entries absent from the payload are removed', () => {
  const workspaceId = 'ws-replace';
  // Seed with the OLD project (sprite A).
  replaceWorkspaceSharedState(workspaceId, {
    elements: [element({ elementType: 'sprite', elementId: 'A' })],
    spriteMetrics: [metrics('A')],
    workspaceSnapshots: [snapshot('A')]
  });

  // Replace with the NEW project (sprite B only). Nothing from A may survive.
  replaceWorkspaceSharedState(workspaceId, {
    elements: [element({ elementType: 'sprite', elementId: 'B' })],
    spriteMetrics: [metrics('B')],
    workspaceSnapshots: [snapshot('B')]
  });

  const state = ensureWorkspaceSharedState(workspaceId);
  assert.equal(state.elements.has('sprite:A'), false);
  assert.equal(state.spriteMetrics.has('A'), false);
  assert.equal(state.workspaceSnapshots.has('A'), false);
  assert.equal(state.elements.has('sprite:B'), true);
  assert.equal(state.spriteMetrics.has('B'), true);
  assert.equal(state.workspaceSnapshots.has('B'), true);
  deleteWorkspaceSharedState(workspaceId);
});

test('replaceWorkspaceSharedState with an empty payload clears the workspace', () => {
  const workspaceId = 'ws-empty';
  replaceWorkspaceSharedState(workspaceId, {
    elements: [element({ elementType: 'sprite', elementId: 'A' })],
    spriteMetrics: [metrics('A')],
    workspaceSnapshots: [snapshot('A')]
  });

  replaceWorkspaceSharedState(workspaceId, { elements: [], spriteMetrics: [], workspaceSnapshots: [] });

  const state = ensureWorkspaceSharedState(workspaceId);
  assert.equal(state.elements.size, 0);
  assert.equal(state.spriteMetrics.size, 0);
  assert.equal(state.workspaceSnapshots.size, 0);
  deleteWorkspaceSharedState(workspaceId);
});
