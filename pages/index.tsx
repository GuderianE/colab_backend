import Head from 'next/head';
import { useEffect, useRef } from 'react';
import type { Coordinates, PermissionSet } from '../types/collaboration';
import CollaborativeApp from '../lib/client/CollaborativeApp';

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
  ticket: string;
  autoJoin: boolean;
  overlay: boolean;
};

declare global {
  interface Window {
    app?: CollaborativeApp;
  }
}

function generateWorkspaceId(): string {
  return `workspace-${Math.random().toString(36).slice(2, 11)}`;
}

function resolveWebSocketUrl(): string {
  if (typeof window === 'undefined') {
    return 'ws://localhost:4000/ws';
  }
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = window.location.host;
  const path = window.location.pathname.startsWith('/api/collab') ? '/api/collab/ws' : '/ws';
  return `${protocol}//${host}${path}`;
}

function parseLaunchParams(): LaunchParams {
  if (typeof window === 'undefined') {
    return { workspaceId: '', username: '', userId: '', ticket: '', autoJoin: false, overlay: false };
  }

  const params = new URLSearchParams(window.location.search);
  const parseBooleanParam = (raw: string) => ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
  const autoJoinRaw = (params.get('autojoin') ?? params.get('autoJoin') ?? '').trim();
  const overlayRaw = (params.get('overlay') ?? params.get('embedded') ?? '').trim();

  return {
    workspaceId: (params.get('workspace') ?? params.get('workspaceId') ?? '').trim(),
    username: (params.get('username') ?? params.get('name') ?? '').trim(),
    userId: (params.get('userId') ?? '').trim(),
    ticket: (params.get('ticket') ?? '').trim(),
    autoJoin: parseBooleanParam(autoJoinRaw),
    overlay: parseBooleanParam(overlayRaw)
  };
}

export default function Home() {
  const appRef = useRef<CollaborativeApp | null>(null);
  const draggingStateRef = useRef<Map<string, DragState>>(new Map());

  const joinWorkspace = () => {
    const workspaceInput = document.getElementById('workspace-input') as HTMLInputElement | null;
    const usernameInput = document.getElementById('username-input') as HTMLInputElement | null;
    const userIdInput = document.getElementById('user-id-input') as HTMLInputElement | null;
    const ticketInput = document.getElementById('ticket-input') as HTMLInputElement | null;
    const app = appRef.current;

    if (!workspaceInput || !usernameInput || !userIdInput || !ticketInput || !app) return;

    const workspaceId = workspaceInput.value.trim() || generateWorkspaceId();
    const username = usernameInput.value.trim() || 'Anonymous';
    const userId = userIdInput.value.trim();
    const ticket = ticketInput.value.trim();

    if (!ticket) {
      app.showNotification('Join ticket is required (issued by platform)', 'error');
      return;
    }

    app.connect(ticket, workspaceId, username, userId);
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
    const launchParams = parseLaunchParams();
    const app = new CollaborativeApp({
      wsUrl: resolveWebSocketUrl(),
      debug: true
    });

    appRef.current = app;
    window.app = app;

    const draggingState = draggingStateRef.current;

    if (launchParams.overlay) {
      document.body.classList.add('overlay-mode');
      document.getElementById('__next')?.classList.add('overlay-mode');
    }

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

    const getAvatarInitials = (username: string) => {
      const parts = username.trim().split(/\s+/).filter(Boolean);
      if (parts.length === 0) return 'U';
      if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
      return `${parts[0][0] || ''}${parts[1][0] || ''}`.toUpperCase();
    };

    const getAvatarColor = (userId: string) => {
      let hash = 0;
      for (let i = 0; i < userId.length; i += 1) {
        hash = (hash * 31 + userId.charCodeAt(i)) | 0;
      }
      const hue = Math.abs(hash) % 360;
      return `hsl(${hue}, 62%, 46%)`;
    };

    app.updatePermissionUI = (permissions) => {
      const permissionPanel = document.getElementById('permission-panel');
      const permissionToggle = document.getElementById('permission-toggle');
      const ownerControls = document.getElementById('owner-controls');
      const readOnlyNotice = document.getElementById('permission-readonly-note');
      const studentSelect = document.getElementById('student-select') as HTMLSelectElement | null;
      const canChangePermissions = !!permissions.canChangePermissions;

      if (canChangePermissions) {
        permissionPanel?.classList.remove('hidden');
        permissionToggle?.classList.remove('hidden');
      } else {
        permissionPanel?.classList.add('hidden');
        permissionPanel?.classList.remove('open');
        permissionToggle?.classList.add('hidden');
      }
      if (canChangePermissions && document.getElementById('permission-toggles')?.childElementCount === 0) {
        setupPermissionToggles();
      }
      if (ownerControls) {
        ownerControls.classList.toggle('hidden', !canChangePermissions);
      }
      if (readOnlyNotice) {
        readOnlyNotice.classList.add('hidden');
      }
      if (studentSelect) {
        studentSelect.disabled = !canChangePermissions;
      }

      const modeButtons = document.querySelectorAll('.quick-btn');
      modeButtons.forEach((btn) => {
        const button = btn as HTMLButtonElement;
        button.disabled = !canChangePermissions;
      });

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
          const input = toggle as HTMLInputElement;
          input.checked = !!permissions[permission.key];
          input.disabled = !canChangePermissions;
        }
      });

      const studentPermissionToggles = document.querySelectorAll(
        '#student-permission-toggles input[type="checkbox"]'
      );
      studentPermissionToggles.forEach((toggle) => {
        (toggle as HTMLInputElement).disabled = !canChangePermissions;
      });
    };

    app.updateUserListUI = (users) => {
      const myId = app.wsClient.userId;
      const circles = document.getElementById('presence-circles');
      if (circles) {
        circles.innerHTML = '';
        const sorted = users
          .slice()
          .sort((a, b) => {
            if (a.userId === myId) return -1;
            if (b.userId === myId) return 1;
            if (a.isOwner && !b.isOwner) return -1;
            if (!a.isOwner && b.isOwner) return 1;
            return a.username.localeCompare(b.username);
          });

        sorted.forEach((user) => {
          const circle = document.createElement('button');
          circle.type = 'button';
          circle.className = 'presence-circle';
          if (user.isOwner) {
            circle.classList.add('owner');
          }

          circle.style.background = getAvatarColor(user.userId);
          circle.textContent = getAvatarInitials(user.username);
          circle.title = `${user.username}${user.isOwner ? ' (Owner)' : ''}${
            user.userId === myId ? ' (You)' : ''
          }`;

          if (user.userId === myId) {
            circle.classList.add('self');
            circle.addEventListener('click', () => {
              const nextName = window.prompt('Update your display name', user.username);
              if (!nextName) return;

              const normalized = nextName.trim();
              if (!normalized || normalized === user.username) return;

              const updated = app.updateMyUsername(normalized);
              if (!updated) {
                app.showNotification('Unable to update your name while disconnected', 'error');
              }
            });
          } else {
            circle.disabled = true;
          }

          circles.appendChild(circle);
        });
      }

      const joinedCount = document.getElementById('joined-count');
      if (joinedCount) {
        joinedCount.textContent = `${users.length} joined`;
      }

      const select = document.getElementById('student-select') as HTMLSelectElement | null;
      if (select) {
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
      document.getElementById('presence-hud')?.classList.remove('hidden');

      if (!launchParams.overlay) {
        document.getElementById('container')?.classList.remove('hidden');
        document.getElementById('status')?.classList.remove('hidden');
      } else {
        if (data.permissions.canChangePermissions) {
          document.getElementById('permission-toggle')?.classList.remove('hidden');
          document.getElementById('permission-panel')?.classList.remove('hidden');
          document.getElementById('permission-panel')?.classList.add('open');
        }
      }

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
      app.updateCursorPosition(e.clientX, e.clientY);

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
    const ticketInput = document.getElementById('ticket-input');
    const paletteBlocks = Array.from(document.querySelectorAll('.palette-block'));

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
    if (ticketInput instanceof HTMLInputElement && launchParams.ticket) {
      ticketInput.value = launchParams.ticket;
      ticketInput.readOnly = true;
    }

    if (launchParams.autoJoin) {
      if (launchParams.workspaceId && launchParams.ticket) {
        window.setTimeout(() => {
          joinWorkspace();
        }, 0);
      } else {
        app.showNotification('autojoin requires workspace and ticket query params', 'error');
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
    ticketInput?.addEventListener('keypress', handleJoinWithEnter as EventListener);
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
      ticketInput?.removeEventListener('keypress', handleJoinWithEnter as EventListener);
      if (codeWorkspace) {
        codeWorkspace.removeEventListener('dragover', handleDragOver);
        codeWorkspace.removeEventListener('drop', handleDrop);
      }

      app.destroy();
      delete window.app;
      appRef.current = null;
      draggingState.clear();
      document.body.classList.remove('overlay-mode');
      document.getElementById('__next')?.classList.remove('overlay-mode');
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
        <input type="text" id="user-id-input" placeholder="Platform user ID (optional, auto-derived)" />
        <input type="text" id="ticket-input" placeholder="Platform join ticket (required)" />
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
        Colab Controls
      </button>
      <div id="permission-panel" className="hidden">
        <h3>Collaboration Options</h3>
        <div id="permission-readonly-note" className="permission-note hidden">
          View-only mode. Request teacher role to manage permissions.
        </div>
        <div id="owner-controls" className="hidden">
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
      </div>

      <div id="presence-hud" className="hidden">
        <div id="joined-count">0 joined</div>
        <div id="presence-circles" />
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

    </>
  );
}
