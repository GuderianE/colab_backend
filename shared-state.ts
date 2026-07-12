// Collaborative workspace shared-state — the authoritative in-memory copy of a group's
// project structure during a live session (sprites/blocks as `elements`, per-sprite stage
// `spriteMetrics`, and per-sprite serialized `workspaceSnapshots`).
//
// Extracted from server.ts so the pure helpers can be unit-tested without importing (and thus
// auto-starting) the WebSocket server. Mirrors the permission-manager-backend module split.

export type WorkspaceElementState = {
  elementType: string;
  elementId: string;
  elementData: unknown;
  version: number;
  etag: string;
  firstEditedBy: string;
  firstEditedAt: number;
  updatedBy: string;
  updatedAt: number;
};

export type WorkspaceSpriteMetrics = {
  spriteId: string;
  x: number;
  y: number;
  rotation?: number;
  size?: number;
  visible?: boolean;
  version: number;
  etag: string;
  firstEditedBy: string;
  firstEditedAt: number;
  updatedBy: string;
  updatedAt: number;
};

export type WorkspaceSnapshotState = {
  spriteId: string;
  serializedJson: string;
  blocksJson: unknown;
  version: number;
  etag: string;
  firstEditedBy: string;
  firstEditedAt: number;
  updatedBy: string;
  updatedAt: number;
};

export type WorkspaceSharedState = {
  elements: Map<string, WorkspaceElementState>;
  spriteMetrics: Map<string, WorkspaceSpriteMetrics>;
  workspaceSnapshots: Map<string, WorkspaceSnapshotState>;
};

export type WorkspaceSharedStatePayload = {
  elements: WorkspaceElementState[];
  spriteMetrics: WorkspaceSpriteMetrics[];
  workspaceSnapshots: WorkspaceSnapshotState[];
};

const workspaceSharedState = new Map<string, WorkspaceSharedState>();

// The map key for an element mirrors how incremental updates address it (see server.ts):
// `${elementType}:${elementId}` — sprites/blocks/variables/lists share the `elements` map.
export function elementStateKey(element: Pick<WorkspaceElementState, 'elementType' | 'elementId'>): string {
  return `${element.elementType}:${element.elementId}`;
}

export function ensureWorkspaceSharedState(workspaceId: string): WorkspaceSharedState {
  if (!workspaceSharedState.has(workspaceId)) {
    workspaceSharedState.set(workspaceId, {
      elements: new Map(),
      spriteMetrics: new Map(),
      workspaceSnapshots: new Map()
    });
  }

  return workspaceSharedState.get(workspaceId) as WorkspaceSharedState;
}

export function deleteWorkspaceSharedState(workspaceId: string): void {
  workspaceSharedState.delete(workspaceId);
}

// Inverse of sharedStateToPayload: overwrite the workspace's entire shared-state with the
// given payload. This is a REPLACE, not a merge — any element/metric/snapshot not present in
// the payload is dropped, so a stale entry can never survive an authoritative snapshot (the
// property the single-source-of-truth model depends on). Returns the new state.
export function replaceWorkspaceSharedState(
  workspaceId: string,
  payload: WorkspaceSharedStatePayload
): WorkspaceSharedState {
  const state: WorkspaceSharedState = {
    elements: new Map(payload.elements.map((element) => [elementStateKey(element), element])),
    spriteMetrics: new Map(payload.spriteMetrics.map((metric) => [metric.spriteId, metric])),
    workspaceSnapshots: new Map(payload.workspaceSnapshots.map((snapshot) => [snapshot.spriteId, snapshot]))
  };
  workspaceSharedState.set(workspaceId, state);
  return state;
}

export function sharedStateToPayload(state: WorkspaceSharedState): WorkspaceSharedStatePayload {
  return {
    elements: Array.from(state.elements.values()),
    spriteMetrics: Array.from(state.spriteMetrics.values()),
    workspaceSnapshots: Array.from(state.workspaceSnapshots.values())
  };
}
