import type { CollaborationMessage } from '../../types/collaboration';

export type AuthSuccessPayload = {
  type: 'auth_success';
  userId: string;
  workspaceId: string;
  permissions: Record<string, boolean>;
  users: Array<{
    userId: string;
    username: string;
    permissions: Record<string, boolean>;
    isOwner: boolean;
  }>;
  isOwner: boolean;
};

type EventName = 'onOpen' | 'onClose' | 'onError' | 'onAuthenticated' | 'onMessage';

type EventListenerMap = {
  onOpen: Array<() => void>;
  onClose: Array<() => void>;
  onError: Array<(error: Event) => void>;
  onAuthenticated: Array<(data: AuthSuccessPayload) => void>;
  onMessage: Array<(data: CollaborationMessage) => void>;
};

type ClientConfig = {
  url?: string;
  reconnectDelay?: number;
  maxReconnectAttempts?: number;
  debug?: boolean;
};

type AuthContext = {
  token: string;
  workspaceId: string;
  username: string;
  userId: string;
};

/**
 * WebSocket Connection Manager
 * Handles connection, authentication, and message routing
 */
export default class WebSocketClient {
  ws: WebSocket | null;

  config: Required<ClientConfig>;

  userId: string | null;

  workspaceId: string | null;

  isAuthenticated: boolean;

  reconnectAttempts: number;

  authContext: AuthContext | null;

  messageHandlers: Map<string, (data: CollaborationMessage) => void>;

  eventListeners: EventListenerMap;

  constructor(config: ClientConfig = {}) {
    this.ws = null;
    this.config = {
      url:
        config.url ||
        `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`,
      reconnectDelay: config.reconnectDelay || 2000,
      maxReconnectAttempts: config.maxReconnectAttempts || 10,
      debug: config.debug || false
    };

    this.userId = null;
    this.workspaceId = null;
    this.isAuthenticated = false;
    this.reconnectAttempts = 0;
    this.authContext = null;

    this.messageHandlers = new Map();

    this.eventListeners = {
      onOpen: [],
      onClose: [],
      onError: [],
      onAuthenticated: [],
      onMessage: []
    };
  }

  connect(token: string, workspaceId: string, username: string, userId: string): void {
    if (this.config.debug) console.log('Connecting to WebSocket server...');

    this.authContext = { token, workspaceId, username, userId };
    this.workspaceId = workspaceId;

    try {
      this.ws = new WebSocket(this.config.url);

      this.ws.onopen = () => {
        this.reconnectAttempts = 0;
        if (this.config.debug) console.log('WebSocket connected');

        this.authenticate(token, workspaceId, username, userId);

        this.eventListeners.onOpen.forEach((handler) => handler());
      };

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as CollaborationMessage;
          this.handleMessage(data);
        } catch (error) {
          console.error('Failed to parse message:', error);
        }
      };

      this.ws.onclose = (event) => {
        this.isAuthenticated = false;
        if (this.config.debug) console.log('WebSocket disconnected', event.code, event.reason);

        this.eventListeners.onClose.forEach((handler) => handler());

        const isAuthFailure = event.code === 4003;
        if (isAuthFailure) {
          if (this.config.debug) {
            console.log('Reconnect disabled due to auth failure');
          }
          return;
        }

        if (this.reconnectAttempts < this.config.maxReconnectAttempts) {
          this.reconnectAttempts += 1;
          setTimeout(() => {
            if (this.config.debug) {
              console.log(`Reconnecting... (attempt ${this.reconnectAttempts})`);
            }
            this.connect(token, workspaceId, username, userId);
          }, this.config.reconnectDelay);
        }
      };

      this.ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        this.eventListeners.onError.forEach((handler) => handler(error));
      };
    } catch (error) {
      console.error('Failed to create WebSocket connection:', error);
      throw error;
    }
  }

  authenticate(token: string, workspaceId: string, username: string, userId: string): void {
    this.send({
      type: 'auth',
      token,
      workspace: workspaceId,
      username,
      userId
    });
  }

  handleMessage(data: CollaborationMessage): void {
    if (data.type === 'auth_success') {
      const payload = data as unknown as AuthSuccessPayload;
      this.userId = payload.userId;
      this.isAuthenticated = true;
      this.eventListeners.onAuthenticated.forEach((handler) => handler(payload));
    }

    const handler = this.messageHandlers.get(data.type);
    if (handler) {
      handler(data);
    }

    this.eventListeners.onMessage.forEach((handler) => handler(data));
  }

  send(data: CollaborationMessage): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('WebSocket is not connected');
      return false;
    }

    try {
      this.ws.send(JSON.stringify(data));
      if (this.config.debug) console.log('Sent:', data);
      return true;
    } catch (error) {
      console.error('Failed to send message:', error);
      return false;
    }
  }

  on(messageType: string, handler: (data: CollaborationMessage) => void): void {
    this.messageHandlers.set(messageType, handler);
  }

  off(messageType: string): void {
    this.messageHandlers.delete(messageType);
  }

  addEventListener(event: 'onOpen', handler: () => void): void;
  addEventListener(event: 'onClose', handler: () => void): void;
  addEventListener(event: 'onError', handler: (error: Event) => void): void;
  addEventListener(event: 'onAuthenticated', handler: (data: AuthSuccessPayload) => void): void;
  addEventListener(event: 'onMessage', handler: (data: CollaborationMessage) => void): void;
  addEventListener(event: EventName, handler: (...args: any[]) => void): void {
    if (this.eventListeners[event]) {
      (this.eventListeners[event] as Array<(...args: any[]) => void>).push(handler);
    }
  }

  removeEventListener(event: EventName, handler: (...args: any[]) => void): void {
    if (this.eventListeners[event]) {
      const listeners = this.eventListeners[event] as Array<(...args: any[]) => void>;
      const index = listeners.indexOf(handler);
      if (index > -1) {
        listeners.splice(index, 1);
      }
    }
  }

  isConnected(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN && this.isAuthenticated;
  }

  disconnect(): void {
    if (this.ws) {
      this.reconnectAttempts = this.config.maxReconnectAttempts;
      this.ws.close();
      this.ws = null;
    }
  }

  getState() {
    return {
      userId: this.userId,
      workspaceId: this.workspaceId,
      isAuthenticated: this.isAuthenticated,
      isConnected: this.isConnected()
    };
  }
}
