import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import path from 'path';

import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';

import { ASSISTANT_NAME, WEB_PORT } from '../config.js';
import { getAllChats, getAllMessagesForChat, RawMessage, storeMessage, storeChatMetadata } from '../db.js';
import { logger } from '../logger.js';
import { Channel, NewMessage, RegisteredGroup } from '../types.js';
import { registerChannel, ChannelOpts } from './registry.js';

const WEB_JID = 'web:default@web';
const WEB_FOLDER = 'webchat';

export class WebChannel implements Channel {
  name = 'web';
  private server!: http.Server;
  private wss!: WebSocketServer;
  private connected = false;
  private connections = new Map<string, Set<WebSocket>>();
  private opts: ChannelOpts;

  constructor(opts: ChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.ensureWebGroup();
    this.startServer();
    this.connected = true;
    logger.info({ port: WEB_PORT }, 'Web channel listening');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    // Persist bot message
    const now = new Date().toISOString();
    storeMessage({
      id: crypto.randomUUID(),
      chat_jid: jid,
      sender: 'assistant',
      sender_name: ASSISTANT_NAME,
      content: text,
      timestamp: now,
      is_from_me: true,
      is_bot_message: true,
    });
    storeChatMetadata(jid, now, undefined, 'web', false);

    // Push to all connected WS clients for this JID
    const sockets = this.connections.get(jid);
    if (!sockets) return;
    const payload = JSON.stringify({ type: 'message', role: 'assistant', content: text, timestamp: now });
    for (const ws of sockets) {
      if (ws.readyState === WebSocket.OPEN) ws.send(payload);
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    const sockets = this.connections.get(jid);
    if (!sockets) return;
    const payload = JSON.stringify({ type: 'typing', active: isTyping });
    for (const ws of sockets) {
      if (ws.readyState === WebSocket.OPEN) ws.send(payload);
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('web:') && jid.endsWith('@web');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.wss?.close();
    this.server?.close();
  }

  private ensureWebGroup(): void {
    const groups = this.opts.registeredGroups();
    if (groups[WEB_JID]) return;

    const now = new Date().toISOString();
    storeChatMetadata(WEB_JID, now, 'Web Chat', 'web', false);

    this.opts.ensureGroup?.(WEB_JID, {
      name: 'Web Chat',
      folder: WEB_FOLDER,
      trigger: `@${ASSISTANT_NAME}`,
      added_at: now,
      requiresTrigger: false,
      isMain: false,
    });
  }

  private startServer(): void {
    const app = express();
    app.use(express.json());

    // Serve static UI
    const webDir = path.join(process.cwd(), 'web');
    app.use(express.static(webDir));

    // REST: list conversations
    app.get('/api/conversations', (_req, res) => {
      const chats = getAllChats().filter((c) => c.channel === 'web');
      res.json(chats);
    });

    // REST: full history including bot messages
    app.get('/api/messages/:jid', (req, res) => {
      const jid = decodeURIComponent(req.params.jid);
      if (!this.ownsJid(jid)) return res.status(400).json({ error: 'Invalid JID' });
      res.json(this.getFullHistory(jid));
    });

    this.server = http.createServer(app);

    this.wss = new WebSocketServer({ server: this.server });
    this.wss.on('connection', (ws) => {
      let currentJid: string | null = null;

      ws.on('message', (data) => {
        let msg: { type: string; jid?: string; content?: string };
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return;
        }

        if (msg.type === 'join' && msg.jid && this.ownsJid(msg.jid)) {
          // Leave previous room
          if (currentJid) {
            this.connections.get(currentJid)?.delete(ws);
          }
          currentJid = msg.jid;
          if (!this.connections.has(currentJid)) {
            this.connections.set(currentJid, new Set());
          }
          this.connections.get(currentJid)!.add(ws);

          // Send history
          ws.send(JSON.stringify({ type: 'history', messages: this.getFullHistory(currentJid) }));

        } else if (msg.type === 'message' && msg.jid && msg.content && this.ownsJid(msg.jid)) {
          const jid = msg.jid;
          const now = new Date().toISOString();
          const userMsg: NewMessage = {
            id: crypto.randomUUID(),
            chat_jid: jid,
            sender: 'user',
            sender_name: 'You',
            content: msg.content,
            timestamp: now,
            is_from_me: false,
            is_bot_message: false,
          };

          storeChatMetadata(jid, now, undefined, 'web', false);
          this.opts.onMessage(jid, userMsg);

          // Echo user message back to all tabs on this JID
          const payload = JSON.stringify({ type: 'message', role: 'user', content: msg.content, timestamp: now });
          const sockets = this.connections.get(jid);
          if (sockets) {
            for (const s of sockets) {
              if (s.readyState === WebSocket.OPEN) s.send(payload);
            }
          }
        }
      });

      ws.on('close', () => {
        if (currentJid) {
          this.connections.get(currentJid)?.delete(ws);
        }
      });
    });

    this.server.listen(WEB_PORT);
  }

  private getFullHistory(jid: string): Array<{ role: string; content: string; timestamp: string }> {
    return getAllMessagesForChat(jid).map((m: RawMessage) => ({
      role: m.is_bot_message === 1 || m.is_from_me === 1 ? 'assistant' : 'user',
      content: m.content,
      timestamp: m.timestamp,
    }));
  }
}

registerChannel('web', (opts: ChannelOpts) => new WebChannel(opts));
