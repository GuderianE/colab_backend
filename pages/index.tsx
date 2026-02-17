import Head from 'next/head';
import { useEffect, useRef } from 'react';
import type { Coordinates, PermissionSet } from '../types/collaboration';
import CollaborativeApp from '../lib/client/CollaborativeApp';

const DEMO_TOKEN = 'demo-token-789';
const MANAGED_PERMISSIONS: Array<{ key: keyof PermissionSet; label: string }> = [
  { key: 'canEditBlocks', label: '✏️ Edit Blocks' },
  { key: 'canAddBlocks', label: '➕ Add Blocks' },
  { key: 'canDeleteBlocks', label: '🗑️ Delete Blocks' },
  { key: 'canEditSprites', label: '🎨 Edit Sprites' },
  { key: 'canRunCode', label: '▶️ Run Code' },
  { key: 'canChat', label: '💬 Chat' }
];

const SPRITE_IMAGE =
  'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iODAiIGhlaWdodD0iODAiIHZpZXdCb3g9IjAgMCA4MCA4MCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPGNpcmNsZSBjeD0iNDAiIGN5PSI0MCIgcj0iMzUiIGZpbGw9IiNGRjZCNkIiLz4KPGNpcmNsZSBjeD0iMzAiIGN5PSIzNSIgcj0iNSIgZmlsbD0iYmxhY2siLz4KPGNpcmNsZSBjeD0iNTAiIGN5PSIzNSIgcj0iNSIgZmlsbD0iYmxhY2siLz4KPHBhdGggZD0iTTMwIDUwIFE0MCAgNjAgNTAgNTAiIHN0cm9rZT0iYmxhY2siIHN0cm9rZS13aWR0aD0iMyIgZmlsbD0ibm9uZSIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIi8+Cjwvc3ZnPg==';

type DragState = {
  startX: number;
  startY: number;
  initialX: number;
  initialY: number;
  isDragging: boolean;
  pending: boolean;
  elementType: 'block' | 'sprite';
};

type BlockTemplate = {
  id: string;
  type: string;
  text: string;
  x: number;
  y: number;
};

type BlockPayload = {
  id: string;
  type: string;
  text: string;
  position: Coordinates;
};

type LaunchParams = {
  workspaceId: string;
  username: string;
  userId: string;
  autoJoin: boolean;
};

declare global {
  interface Window {
    app?: CollaborativeApp;
  }
}

function generateWorkspaceId(): string {
  return `workspace-${Math.random().toString(36).slice(2, 11)}`;
}

function parseLaunchParams(): LaunchParams {
  if (typeof window === 'undefined') {
    return { workspaceId: '', username: '', userId: '', autoJoin: false };
  }

  const params = new URLSearchParams(window.location.search);
  const autoJoinRaw = (params.get('autojoin') ?? params.get('autoJoin') ?? '').trim().toLowerCase();

  return {
    workspaceId: (params.get('workspace') ?? params.get('workspaceId') ?? '').trim(),
    username: (params.get('username') ?? params.get('name') ?? '').trim(),
    userId: (params.get('userId') ?? '').trim(),
    autoJoin: autoJoinRaw === '1' || autoJoinRaw === 'true' || autoJoinRaw === 'yes'
  };
}

export default function Home() {
  const appRef = useRef<CollaborativeApp | null>(null);
  const draggingStateRef = useRef<Map<string, DragState>>(new Map());

  const joinWorkspace = () => {
    const workspaceInput = document.getElementById('workspace-input') as HTMLInputElement | null;
    const usernameInput = document.getElementById('username-input') as HTMLInputElement | null;
    const userIdInput = document.getElementById('user-id-input') as HTMLInputElement | null;
    const app = appRef.current;

    if (!workspaceInput || !usernameInput || !userIdInput || !app) return;

    const workspaceId = workspaceInput.value.trim() || generateWorkspaceId();
    const username = usernameInput.value.trim() || 'Anonymous';
    const userId = userIdInput.value.trim();

    if (!userId) {
      app.showNotification('User ID is required (provided by platform)', 'error');
      return;
    }

    app.connect(DEMO_TOKEN, workspaceId, username, userId);
  };

  const copyWorkspaceId = async () => {
    const app = appRef.current;
    const workspaceDisplay = document.getElementById('workspace-display');
    if (!workspaceDisplay || !app) return;

    await navigator.clipboard.writeText(workspaceDisplay.textContent || '');
    app.showNotification('Workspace ID copied to clipboard!', 'success');
  };

  const togglePermissionPanel = () => {
    const panel = document.getElementById('permission-panel');
    if (panel) {
      panel.classList.toggle('open');
    }
  };

  useEffect(() => {
    const app = new CollaborativeApp({
      wsUrl: `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`,
      debug: true
    });

    appRef.current = app;
    window.app = app;

    const draggingState = draggingStateRef.current;

    const makeDraggable = (element: HTMLElement, elementType: 'block' | 'sprite') => {
      element.addEventListener('mousedown', (e: MouseEvent) => {
        e.preventDefault();

        const rect = element.getBoundingClientRect();
        const parent = element.parentElement?.getBoundingClientRect();
        if (!parent) return;

        draggingState.set(element.id, {
          startX: e.clientX,
          startY: e.clientY,
          initialX: rect.left - parent.left,
          initialY: rect.top - parent.top,
          isDragging: false,
          pending: true,
          elementType
        });

        app.collaboration.requestLock(element.id, elementType);
      });
    };

    const createInitialElements = () => {
      if (document.getElementById('block-1')) return;

      const codeWorkspace = document.getElementById('code-workspace');
      const stage = document.getElementById('stage');
      if (!codeWorkspace || !stage) return;

      const blockTypes: BlockTemplate[] = [
        { id: 'block-1', type: 'event', text: 'When 🏁 clicked', x: 50, y: 50 },
        { id: 'block-2', type: 'motion', text: 'Move 10 steps', x: 50, y: 110 },
        { id: 'block-3', type: 'looks', text: 'Say Hello!', x: 50, y: 170 }
      ];

      blockTypes.forEach((blockData) => {
        const block = document.createElement('div');
        block.id = blockData.id;
        block.className = `code-block block-${blockData.type}`;
        block.textContent = blockData.text;
        block.style.left = `${blockData.x}px`;
        block.style.top = `${blockData.y}px`;

        makeDraggable(block, 'block');
        codeWorkspace.appendChild(block);
      });

      const sprite = document.createElement('div');
      sprite.id = 'sprite-1';
      sprite.className = 'sprite';
      sprite.innerHTML = `<img src="${SPRITE_IMAGE}" alt="Sprite">`;
      sprite.style.left = '100px';
      sprite.style.top = '100px';

      makeDraggable(sprite, 'sprite');
      stage.appendChild(sprite);
    };

    const setupPermissionToggles = () => {
      const container = document.getElementById('permission-toggles');
      if (!container) return;

      container.innerHTML = '';

      MANAGED_PERMISSIONS.forEach((perm) => {
        const row = document.createElement('label');
        row.className = 'permission-toggle';

        const label = document.createElement('span');
        label.textContent = perm.label;

        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = !!app.permissions.currentPermissions[perm.key];
        input.addEventListener('change', () => {
          app.permissions.updateGlobalPermission(perm.key, input.checked);
        });

        row.appendChild(label);
        row.appendChild(input);
        container.appendChild(row);
      });
    };

    const buildStudentPermissionToggles = (targetUserId: string) => {
      const container = document.getElementById('student-permission-toggles');
      if (!container) return;

      container.innerHTML = '';
      const user = app.permissions.users.get(targetUserId);

      MANAGED_PERMISSIONS.forEach((perm) => {
        const row = document.createElement('label');
        row.className = 'permission-toggle';

        const label = document.createElement('span');
        label.textContent = perm.label;

        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = user?.permissions ? !!user.permissions[perm.key] : false;
        input.addEventListener('change', () => {
          app.permissions.updateUserPermission(targetUserId, perm.key, input.checked);
        });

        row.appendChild(label);
        row.appendChild(input);
        container.appendChild(row);
      });
    };

    app.updatePermissionUI = (permissions) => {
      const permissionPanel = document.getElementById('permission-panel');
      const permissionToggle = document.getElementById('permission-toggle');

      if (permissions.canChangePermissions) {
        permissionPanel?.classList.remove('hidden');
        permissionToggle?.classList.remove('hidden');
      }

      const paletteBlocks = document.querySelectorAll('.palette-block');
      paletteBlocks.forEach((block) => {
        const element = block as HTMLElement;
        element.style.opacity = permissions.canAddBlocks ? '1' : '0.5';
        element.style.pointerEvents = permissions.canAddBlocks ? 'auto' : 'none';
      });

      const permissionToggles = document.querySelectorAll('#permission-toggles input[type="checkbox"]');
      permissionToggles.forEach((toggle, index) => {
        const permission = MANAGED_PERMISSIONS[index];
        if (permission) {
          (toggle as HTMLInputElement).checked = !!permissions[permission.key];
        }
      });
    };

    app.updateUserListUI = (users) => {
      const userListContent = document.getElementById('user-list-content');
      if (!userListContent) return;

      userListContent.innerHTML = '';
      users.forEach((user) => {
        const userItem = document.createElement('div');
        userItem.className = 'user-item';

        const username = document.createElement('span');
        username.textContent = user.username;

        const role = document.createElement('span');
        role.className = `user-role ${user.isOwner ? 'owner' : ''}`;
        role.textContent = user.isOwner ? 'Owner' : 'Student';

        userItem.appendChild(username);
        userItem.appendChild(role);
        userListContent.appendChild(userItem);
      });

      const userCount = document.getElementById('user-count');
      if (userCount) {
        userCount.textContent = `👥 ${users.length} user${users.length !== 1 ? 's' : ''} online`;
      }

      const select = document.getElementById('student-select') as HTMLSelectElement | null;
      if (select) {
        const myId = app.wsClient.userId;
        const sorted = users.slice().sort((a, b) => (a.isOwner ? 1 : 0) - (b.isOwner ? 1 : 0));
        select.innerHTML = '';

        sorted.forEach((user) => {
          const option = document.createElement('option');
          option.value = user.userId;
          option.textContent = `${user.username}${user.isOwner ? ' (Owner)' : ''}${
            user.userId === myId ? ' (You)' : ''
          }`;
          select.appendChild(option);
        });

        buildStudentPermissionToggles(select.value);
        select.onchange = () => buildStudentPermissionToggles(select.value);
      }
    };

    app.updateConnectionStatus = (connected) => {
      const status = document.querySelector('#status span');
      if (status) {
        status.className = connected ? 'status-connected' : 'status-disconnected';
        status.textContent = connected ? '● Connected' : '● Disconnected';
      }
    };

    app.showNotification = (message, type = 'info') => {
      const notification = document.createElement('div');
      notification.className = `notification ${type}`;
      notification.textContent = message;
      document.body.appendChild(notification);

      setTimeout(() => {
        notification.style.animation = 'slideUp 0.3s ease-out reverse';
        setTimeout(() => notification.remove(), 300);
      }, 3000);
    };

    app.handleLockGranted = (elementId) => {
      const state = draggingState.get(elementId);
      if (state && state.pending) {
        state.isDragging = true;
        state.pending = false;
        const element = document.getElementById(elementId);
        if (element) {
          element.classList.add('dragging');
        }
      }
    };

    app.handleLockDenied = (elementId) => {
      const element = document.getElementById(elementId);
      if (element) {
        element.classList.add('locked-by-other');
        setTimeout(() => {
          element.classList.remove('locked-by-other');
        }, 500);
      }
      draggingState.delete(elementId);
      app.showNotification('Element is being edited by another user', 'error');
    };

    app.updateElementLockUI = (elementId, isLocked, lockedBy) => {
      const element = document.getElementById(elementId);
      if (!element) return;

      if (isLocked && lockedBy !== app.wsClient.userId) {
        element.classList.add('remote-dragging');
      } else {
        element.classList.remove('remote-dragging');
      }
    };

    app.updateBlockPosition = (blockId, position) => {
      const block = document.getElementById(blockId);
      if (block) {
        block.style.left = `${position.x}px`;
        block.style.top = `${position.y}px`;
      }
    };

    app.updateSpritePosition = (spriteId, x, y) => {
      const sprite = document.getElementById(spriteId);
      if (sprite) {
        sprite.style.left = `${x}px`;
        sprite.style.top = `${y}px`;
      }
    };

    app.collaboration.onElementCreated = (elementType, elementData, createdBy) => {
      if (createdBy === app.wsClient.userId || elementType !== 'block') return;

      const codeWorkspace = document.getElementById('code-workspace');
      if (!codeWorkspace) return;

      const payload = elementData as BlockPayload;
      const block = document.createElement('div');
      block.id = payload.id;
      block.className = `code-block block-${payload.type}`;
      block.textContent = payload.text;
      block.style.left = `${payload.position.x}px`;
      block.style.top = `${payload.position.y}px`;

      makeDraggable(block, 'block');
      codeWorkspace.appendChild(block);
    };

    app.createCursorUI = (userId) => {
      const cursor = document.createElement('div');
      cursor.className = 'cursor';
      cursor.id = `cursor-${userId}`;

      const label = document.createElement('div');
      label.className = 'cursor-label';
      const user = app.permissions.users.get(userId);
      label.textContent = user ? user.username : 'User';

      cursor.appendChild(label);
      document.body.appendChild(cursor);
    };

    app.updateCursorUI = (userId, coords) => {
      const cursor = document.getElementById(`cursor-${userId}`);
      if (cursor) {
        cursor.style.left = `${coords.x}px`;
        cursor.style.top = `${coords.y}px`;
      }
    };

    app.removeCursorUI = (userId) => {
      const cursor = document.getElementById(`cursor-${userId}`);
      if (cursor) {
        cursor.remove();
      }
    };

    app.onAuthenticated = (data) => {
      document.getElementById('workspace-selector')?.classList.add('hidden');
      document.getElementById('workspace-info')?.classList.remove('hidden');
      document.getElementById('container')?.classList.remove('hidden');
      document.getElementById('status')?.classList.remove('hidden');
      document.getElementById('toolbar')?.classList.remove('hidden');
      document.getElementById('user-list')?.classList.remove('hidden');

      const workspaceDisplay = document.getElementById('workspace-display');
      if (workspaceDisplay) {
        workspaceDisplay.textContent = data.workspaceId;
      }

      if (data.permissions.canChangePermissions) {
        setupPermissionToggles();
      }

      createInitialElements();
    };

    const handleDragMove = (e: MouseEvent) => {
      draggingState.forEach((state, elementId) => {
        if (!state.isDragging) return;

        const element = document.getElementById(elementId);
        if (!element) return;

        const dx = e.clientX - state.startX;
        const dy = e.clientY - state.startY;

        const newX = state.initialX + dx;
        const newY = state.initialY + dy;

        element.style.left = `${newX}px`;
        element.style.top = `${newY}px`;

        app.collaboration.updateElementPosition(elementId, state.elementType, { x: newX, y: newY });
      });
    };

    const handleMouseUp = () => {
      draggingState.forEach((state, elementId) => {
        if (!state.isDragging) return;

        const element = document.getElementById(elementId);
        if (!element) return;

        element.classList.remove('dragging');
        const finalX = parseInt(element.style.left, 10);
        const finalY = parseInt(element.style.top, 10);
        app.collaboration.releaseLock(elementId, { x: finalX, y: finalY });
      });

      draggingState.clear();
    };

    const handlePaletteDragStart = (e: DragEvent) => {
      if (!app.permissions.hasPermission('canAddBlocks')) {
        e.preventDefault();
        app.showNotification('You do not have permission to add blocks', 'error');
        return;
      }

      const target = e.target as HTMLElement | null;
      if (!target || !e.dataTransfer) return;
      e.dataTransfer.setData('blockType', target.dataset.blockType || '');
      e.dataTransfer.setData('blockText', target.textContent || '');
    };

    const codeWorkspace = document.getElementById('code-workspace');
    const workspaceInput = document.getElementById('workspace-input');
    const usernameInput = document.getElementById('username-input');
    const userIdInput = document.getElementById('user-id-input');
    const paletteBlocks = Array.from(document.querySelectorAll('.palette-block'));
    const launchParams = parseLaunchParams();

    if (workspaceInput instanceof HTMLInputElement && launchParams.workspaceId) {
      workspaceInput.value = launchParams.workspaceId;
    }
    if (usernameInput instanceof HTMLInputElement && launchParams.username) {
      usernameInput.value = launchParams.username;
    }
    if (userIdInput instanceof HTMLInputElement && launchParams.userId) {
      userIdInput.value = launchParams.userId;
      userIdInput.readOnly = true;
    }

    if (launchParams.autoJoin) {
      if (launchParams.workspaceId && launchParams.userId) {
        window.setTimeout(() => {
          joinWorkspace();
        }, 0);
      } else {
        app.showNotification('autojoin requires workspace and userId query params', 'error');
      }
    }

    const handleDrop = (e: DragEvent) => {
      e.preventDefault();
      if (!e.dataTransfer) return;

      const blockType = e.dataTransfer.getData('blockType');
      const blockText = e.dataTransfer.getData('blockText');

      if (!blockType || !codeWorkspace) return;

      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      const blockId = `block-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
      const blockData: BlockPayload = {
        id: blockId,
        type: blockType,
        text: blockText,
        position: { x, y }
      };

      const block = document.createElement('div');
      block.id = blockId;
      block.className = `code-block block-${blockType}`;
      block.textContent = blockText;
      block.style.left = `${x}px`;
      block.style.top = `${y}px`;

      makeDraggable(block, 'block');
      codeWorkspace.appendChild(block);
      app.collaboration.createElement('block', blockData);
    };

    const handleDragOver = (e: DragEvent) => {
      e.preventDefault();
    };

    const handleJoinWithEnter = (event: KeyboardEvent) => {
      if (event.key === 'Enter') {
        joinWorkspace();
      }
    };

    document.addEventListener('mousemove', handleDragMove);
    document.addEventListener('mouseup', handleMouseUp);

    if (codeWorkspace) {
      codeWorkspace.addEventListener('dragover', handleDragOver);
      codeWorkspace.addEventListener('drop', handleDrop);
    }

    paletteBlocks.forEach((block) => {
      block.addEventListener('dragstart', handlePaletteDragStart);
    });

    workspaceInput?.addEventListener('keypress', handleJoinWithEnter as EventListener);
    usernameInput?.addEventListener('keypress', handleJoinWithEnter as EventListener);
    userIdInput?.addEventListener('keypress', handleJoinWithEnter as EventListener);
    (workspaceInput as HTMLElement | null)?.focus();

    return () => {
      document.removeEventListener('mousemove', handleDragMove);
      document.removeEventListener('mouseup', handleMouseUp);
      paletteBlocks.forEach((block) => {
        block.removeEventListener('dragstart', handlePaletteDragStart);
      });
      workspaceInput?.removeEventListener('keypress', handleJoinWithEnter as EventListener);
      usernameInput?.removeEventListener('keypress', handleJoinWithEnter as EventListener);
      userIdInput?.removeEventListener('keypress', handleJoinWithEnter as EventListener);
      if (codeWorkspace) {
        codeWorkspace.removeEventListener('dragover', handleDragOver);
        codeWorkspace.removeEventListener('drop', handleDrop);
      }

      app.destroy();
      delete window.app;
      appRef.current = null;
      draggingState.clear();
    };
  }, []);

  return (
    <>
      <Head>
        <title>Collaborative Scratch-like Demo</title>
        <meta name="description" content="Collaborative scratch backend demo powered by Next.js" />
      </Head>

      <div id="workspace-selector">
        <h2>Join Collaborative Workspace</h2>
        <p>Enter a workspace ID to join an existing session, or create a new one:</p>
        <input type="text" id="workspace-input" placeholder="Enter workspace ID (or leave empty for new)" />
        <input type="text" id="username-input" placeholder="Enter your name" />
        <input type="text" id="user-id-input" placeholder="Platform user ID (required)" />
        <button onClick={joinWorkspace}>Join Workspace</button>
        <p className="workspace-help">Share the workspace ID with others to collaborate in real-time!</p>
      </div>

      <div id="workspace-info" className="hidden">
        Workspace: <code id="workspace-display" />
        <button id="share-button" onClick={copyWorkspaceId}>
          Copy ID
        </button>
        <button id="become-teacher-button" onClick={() => appRef.current?.permissions.requestTeacherRole()}>
          Become Teacher
        </button>
      </div>

      <button id="permission-toggle" className="hidden" onClick={togglePermissionPanel}>
        Permissions
      </button>
      <div id="permission-panel" className="hidden">
        <h3>Quick Controls</h3>
        <div className="quick-actions">
          <button className="quick-btn blue" onClick={() => appRef.current?.permissions.setPresentationMode()}>
            Presentation
          </button>
          <button className="quick-btn green" onClick={() => appRef.current?.permissions.setWorkMode()}>
            Work Time
          </button>
          <button className="quick-btn orange" onClick={() => appRef.current?.permissions.setTestMode()}>
            Test Mode
          </button>
          <button className="quick-btn red" onClick={() => appRef.current?.permissions.setRestrictedMode()}>
            Lock All
          </button>
        </div>
        <h3>Global Permissions</h3>
        <div className="permission-toggles" id="permission-toggles" />
        <div className="section-title">Per-Student Permissions</div>
        <select id="student-select" className="student-select" />
        <div className="permission-toggles" id="student-permission-toggles" />
      </div>

      <div id="user-list" className="hidden">
        <h3>Connected Users</h3>
        <div id="user-list-content" />
      </div>

      <div id="status" className="hidden">
        <span className="status-disconnected">● Disconnected</span>
      </div>

      <div id="container" className="hidden">
        <div id="code-workspace">
          <div id="blocks-palette">
            <div className="palette-title">Blocks</div>
            <div className="palette-block block-event" draggable data-block-type="event">
              When 🏁 clicked
            </div>
            <div className="palette-block block-motion" draggable data-block-type="motion">
              Move 10 steps
            </div>
            <div className="palette-block block-looks" draggable data-block-type="looks">
              Say Hello!
            </div>
            <div className="palette-block block-control" draggable data-block-type="control">
              Wait 1 second
            </div>
          </div>
        </div>

        <div id="stage-area">
          <div id="stage" />
        </div>
      </div>

      <div id="toolbar" className="hidden">
        <span id="user-count">👥 1 user online</span>
      </div>
    </>
  );
}
