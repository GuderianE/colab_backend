import assert from 'node:assert/strict';
import test from 'node:test';

import {
  deleteWorkspaceSharedState,
  ensureWorkspaceSharedState,
  getWorkspaceSharedStateVersion,
  parseSharedStatePayload,
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

test('parseSharedStatePayload accepts a well-formed payload and round-trips through replace', () => {
  const workspaceId = 'ws-parse-ok';
  const raw = {
    elements: [element({ elementType: 'sprite', elementId: 's1' })],
    spriteMetrics: [metrics('s1')],
    workspaceSnapshots: [snapshot('s1')]
  };

  const parsed = parseSharedStatePayload(raw);
  assert.notEqual(parsed, null);
  replaceWorkspaceSharedState(workspaceId, parsed as WorkspaceSharedStatePayload);
  assert.equal(ensureWorkspaceSharedState(workspaceId).elements.get('sprite:s1')?.elementId, 's1');
  deleteWorkspaceSharedState(workspaceId);
});

test('parseSharedStatePayload treats missing arrays as empty', () => {
  const parsed = parseSharedStatePayload({ elements: [element({ elementType: 'sprite', elementId: 's1' })] });
  assert.notEqual(parsed, null);
  assert.equal((parsed as WorkspaceSharedStatePayload).elements.length, 1);
  assert.deepEqual((parsed as WorkspaceSharedStatePayload).spriteMetrics, []);
  assert.deepEqual((parsed as WorkspaceSharedStatePayload).workspaceSnapshots, []);
});

test('parseSharedStatePayload rejects non-object input (fail-closed)', () => {
  assert.equal(parseSharedStatePayload(null), null);
  assert.equal(parseSharedStatePayload('nope'), null);
  assert.equal(parseSharedStatePayload(42), null);
});

test('parseSharedStatePayload rejects a payload whose arrays are the wrong type', () => {
  assert.equal(parseSharedStatePayload({ elements: 'not-an-array' }), null);
  assert.equal(parseSharedStatePayload({ spriteMetrics: {} }), null);
});

test('parseSharedStatePayload rejects entries missing their id fields (fail-closed)', () => {
  assert.equal(parseSharedStatePayload({ elements: [{ elementType: 'sprite' }] }), null); // no elementId
  assert.equal(parseSharedStatePayload({ elements: [{ elementId: 's1' }] }), null); // no elementType
  assert.equal(parseSharedStatePayload({ spriteMetrics: [{ x: 1, y: 2 }] }), null); // no spriteId
  assert.equal(parseSharedStatePayload({ workspaceSnapshots: [{ serializedJson: '{}' }] }), null); // no spriteId
});

test('a fresh workspace shared-state starts at version 0', () => {
  const workspaceId = 'ws-version-fresh';
  ensureWorkspaceSharedState(workspaceId);
  assert.equal(getWorkspaceSharedStateVersion(workspaceId), 0);
  deleteWorkspaceSharedState(workspaceId);
});

test('replaceWorkspaceSharedState advances the version on each replace', () => {
  const workspaceId = 'ws-version-advance';
  const payload: WorkspaceSharedStatePayload = { elements: [], spriteMetrics: [], workspaceSnapshots: [] };

  replaceWorkspaceSharedState(workspaceId, payload);
  assert.equal(getWorkspaceSharedStateVersion(workspaceId), 1);
  replaceWorkspaceSharedState(workspaceId, payload);
  assert.equal(getWorkspaceSharedStateVersion(workspaceId), 2);
  deleteWorkspaceSharedState(workspaceId);
});

test('replaceWorkspaceSharedState can adopt an explicit version (cold-hydrate)', () => {
  const workspaceId = 'ws-version-hydrate';
  const payload: WorkspaceSharedStatePayload = { elements: [], spriteMetrics: [], workspaceSnapshots: [] };

  replaceWorkspaceSharedState(workspaceId, payload, { version: 42 });
  assert.equal(getWorkspaceSharedStateVersion(workspaceId), 42);
  // A subsequent live replace advances from the hydrated version, not from 0.
  replaceWorkspaceSharedState(workspaceId, payload);
  assert.equal(getWorkspaceSharedStateVersion(workspaceId), 43);
  deleteWorkspaceSharedState(workspaceId);
});

test('getWorkspaceSharedStateVersion is 0 for an unknown workspace', () => {
  assert.equal(getWorkspaceSharedStateVersion('ws-never-seen'), 0);
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
