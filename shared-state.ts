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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

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

// Defensively coerce an untrusted message body into a WorkspaceSharedStatePayload before it is
// allowed to REPLACE the authoritative state. Fail-closed: any structural problem (not an
// object, an array field of the wrong type, or an entry missing its identifying id) returns
// null so the caller rejects the replace and keeps the current project rather than wiping it to
// garbage. Metadata fields are normalized with safe defaults (the identifiers are what matter
// for keying and REPLACE semantics).
export function parseSharedStatePayload(raw: unknown): WorkspaceSharedStatePayload | null {
  if (!isRecord(raw)) return null;

  const elementsRaw = raw.elements ?? [];
  const spriteMetricsRaw = raw.spriteMetrics ?? [];
  const workspaceSnapshotsRaw = raw.workspaceSnapshots ?? [];
  if (!Array.isArray(elementsRaw) || !Array.isArray(spriteMetricsRaw) || !Array.isArray(workspaceSnapshotsRaw)) {
    return null;
  }

  const elements: WorkspaceElementState[] = [];
  for (const entry of elementsRaw) {
    if (!isRecord(entry)) return null;
    const elementType = nonEmptyString(entry.elementType);
    const elementId = nonEmptyString(entry.elementId);
    if (!elementType || !elementId) return null;
    elements.push({
      elementType,
      elementId,
      elementData: entry.elementData,
      version: asNumber(entry.version),
      etag: asString(entry.etag),
      firstEditedBy: asString(entry.firstEditedBy),
      firstEditedAt: asNumber(entry.firstEditedAt),
      updatedBy: asString(entry.updatedBy),
      updatedAt: asNumber(entry.updatedAt)
    });
  }

  const spriteMetrics: WorkspaceSpriteMetrics[] = [];
  for (const entry of spriteMetricsRaw) {
    if (!isRecord(entry)) return null;
    const spriteId = nonEmptyString(entry.spriteId);
    if (!spriteId) return null;
    spriteMetrics.push({
      spriteId,
      x: asNumber(entry.x),
      y: asNumber(entry.y),
      rotation: typeof entry.rotation === 'number' ? entry.rotation : undefined,
      size: typeof entry.size === 'number' ? entry.size : undefined,
      visible: typeof entry.visible === 'boolean' ? entry.visible : undefined,
      version: asNumber(entry.version),
      etag: asString(entry.etag),
      firstEditedBy: asString(entry.firstEditedBy),
      firstEditedAt: asNumber(entry.firstEditedAt),
      updatedBy: asString(entry.updatedBy),
      updatedAt: asNumber(entry.updatedAt)
    });
  }

  const workspaceSnapshots: WorkspaceSnapshotState[] = [];
  for (const entry of workspaceSnapshotsRaw) {
    if (!isRecord(entry)) return null;
    const spriteId = nonEmptyString(entry.spriteId);
    if (!spriteId) return null;
    workspaceSnapshots.push({
      spriteId,
      serializedJson: asString(entry.serializedJson),
      blocksJson: entry.blocksJson,
      version: asNumber(entry.version),
      etag: asString(entry.etag),
      firstEditedBy: asString(entry.firstEditedBy),
      firstEditedAt: asNumber(entry.firstEditedAt),
      updatedBy: asString(entry.updatedBy),
      updatedAt: asNumber(entry.updatedAt)
    });
  }

  return { elements, spriteMetrics, workspaceSnapshots };
}

export function sharedStateToPayload(state: WorkspaceSharedState): WorkspaceSharedStatePayload {
  return {
    elements: Array.from(state.elements.values()),
    spriteMetrics: Array.from(state.spriteMetrics.values()),
    workspaceSnapshots: Array.from(state.workspaceSnapshots.values())
  };
}
