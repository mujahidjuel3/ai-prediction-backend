import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { PrismaService } from '../prisma/prisma.module';
import type { NotificationNewEvent } from './notification-realtime.types';

const EVENT_NEW = 'notification:new';

function parseCookieHeader(header?: string): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

function socketCorsOrigins(): string[] | boolean {
  const origins = (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  return origins.length ? origins : false;
}

@WebSocketGateway({
  namespace: '/notifications',
  cors: {
    origin: socketCorsOrigins(),
    credentials: true,
  },
})
export class NotificationGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(NotificationGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async handleConnection(client: Socket) {
    try {
      const user = await this.authenticateSocket(client);
      if (!user) {
        client.emit('notification:error', { code: 'UNAUTHORIZED', message: 'Authentication required' });
        client.disconnect(true);
        return;
      }
      client.data.userId = user.id;
      client.data.role = user.role;
      const room = this.userRoom(user.id);
      await client.join(room);
      this.logger.log({ event: 'socket_connected', userId: user.id, socketId: client.id });
    } catch (cause) {
      this.logger.warn({
        event: 'socket_connection_rejected',
        socketId: client.id,
        code: cause instanceof Error ? cause.name : 'SOCKET_AUTH_ERROR',
      });
      client.emit('notification:error', { code: 'UNAUTHORIZED', message: 'Invalid or expired credentials' });
      client.disconnect(true);
    }
  }

  handleDisconnect(client: Socket) {
    this.logger.log({
      event: 'socket_disconnected',
      userId: typeof client.data?.userId === 'string' ? client.data.userId : undefined,
      socketId: client.id,
    });
  }

  /**
   * Clients must not choose rooms. Any join attempt is ignored; membership is server-assigned only.
   */
  @SubscribeMessage('subscribe')
  handleClientSubscribe(@ConnectedSocket() client: Socket) {
    this.logger.warn({ event: 'socket_subscribe_ignored', socketId: client.id, userId: client.data?.userId });
    return { ok: false, code: 'ROOM_SUBSCRIBE_FORBIDDEN' };
  }

  @SubscribeMessage('join')
  handleClientJoin(@ConnectedSocket() client: Socket) {
    this.logger.warn({ event: 'socket_join_ignored', socketId: client.id, userId: client.data?.userId });
    return { ok: false, code: 'ROOM_SUBSCRIBE_FORBIDDEN' };
  }

  emitNotificationNew(recipientUserId: string, payload: NotificationNewEvent) {
    if (!recipientUserId || !payload?.id) return;
    this.server.to(this.userRoom(recipientUserId)).emit(EVENT_NEW, payload);
  }

  userRoom(userId: string) {
    return `user:${userId}`;
  }

  async authenticateSocket(client: Socket) {
    const cookies = parseCookieHeader(client.handshake.headers.cookie);
    const token = cookies.access_token;
    if (!token) return null;
    const claims = await this.jwt.verifyAsync<{ sub: string; email: string; role: string }>(token);
    const user = await this.prisma.user.findUnique({
      where: { id: claims.sub },
      select: { id: true, email: true, role: true, status: true },
    });
    if (!user || user.status !== 'ACTIVE' || user.role !== claims.role) return null;
    return user;
  }
}

export const NOTIFICATION_NEW_EVENT = EVENT_NEW;
export { parseCookieHeader };
