import { JwtService } from '@nestjs/jwt';
import { NotificationGateway, parseCookieHeader } from './notification.gateway';

describe('NotificationGateway', () => {
  function build(options: {
    verify?: jest.Mock;
    user?: { id: string; email: string; role: string; status: string } | null;
  } = {}) {
    const jwt = {
      verifyAsync: options.verify ?? jest.fn().mockResolvedValue({ sub: '11111111-1111-4111-8111-111111111111', email: 'user@example.test', role: 'STUDENT' }),
    } as unknown as JwtService;
    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue(
          options.user === undefined
            ? { id: '11111111-1111-4111-8111-111111111111', email: 'user@example.test', role: 'STUDENT', status: 'ACTIVE' }
            : options.user,
        ),
      },
    };
    const gateway = new NotificationGateway(jwt, prisma as never);
    const emitTo = jest.fn();
    gateway.server = { to: jest.fn(() => ({ emit: emitTo })) } as never;
    return { gateway, jwt, prisma, emitTo };
  }

  function socket(cookie?: string) {
    return {
      id: 'socket-1',
      handshake: { headers: { cookie } },
      data: {} as Record<string, unknown>,
      join: jest.fn().mockResolvedValue(undefined),
      emit: jest.fn(),
      disconnect: jest.fn(),
    };
  }

  it('parses access_token from cookie headers', () => {
    expect(parseCookieHeader('access_token=abc%20123; csrf_token=xyz')).toEqual({
      access_token: 'abc 123',
      csrf_token: 'xyz',
    });
  });

  it('authenticates a socket with a valid access_token cookie and joins the user room', async () => {
    const { gateway } = build();
    const client = socket('access_token=valid-token');
    await gateway.handleConnection(client as never);
    expect(client.data.userId).toBe('11111111-1111-4111-8111-111111111111');
    expect(client.join).toHaveBeenCalledWith('user:11111111-1111-4111-8111-111111111111');
    expect(client.disconnect).not.toHaveBeenCalled();
  });

  it('rejects unauthenticated sockets without an access_token cookie', async () => {
    const { gateway } = build();
    const client = socket();
    await gateway.handleConnection(client as never);
    expect(client.disconnect).toHaveBeenCalledWith(true);
    expect(client.join).not.toHaveBeenCalled();
  });

  it('rejects sockets with an invalid JWT', async () => {
    const { gateway } = build({
      verify: jest.fn().mockRejectedValue(new Error('jwt expired')),
    });
    const client = socket('access_token=bad');
    await gateway.handleConnection(client as never);
    expect(client.disconnect).toHaveBeenCalledWith(true);
    expect(client.emit).toHaveBeenCalledWith('notification:error', expect.objectContaining({ code: 'UNAUTHORIZED' }));
  });

  it('rejects sockets when the JWT subject is inactive or role-mismatched', async () => {
    const { gateway } = build({
      user: { id: '11111111-1111-4111-8111-111111111111', email: 'user@example.test', role: 'STUDENT', status: 'INACTIVE' },
    });
    const client = socket('access_token=valid-token');
    await gateway.handleConnection(client as never);
    expect(client.disconnect).toHaveBeenCalledWith(true);
    expect(client.join).not.toHaveBeenCalled();
  });

  it('ignores client-controlled room subscribe/join attempts', () => {
    const { gateway } = build();
    const client = socket('access_token=valid-token');
    client.data.userId = '11111111-1111-4111-8111-111111111111';
    expect(gateway.handleClientSubscribe(client as never)).toEqual({ ok: false, code: 'ROOM_SUBSCRIBE_FORBIDDEN' });
    expect(gateway.handleClientJoin(client as never)).toEqual({ ok: false, code: 'ROOM_SUBSCRIBE_FORBIDDEN' });
  });

  it('emits notification:new only to the recipient user room', () => {
    const { gateway, emitTo } = build();
    const payload = {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      type: 'manual' as const,
      title: 'Hello',
      message: 'Body',
      createdAt: new Date().toISOString(),
      readAt: null,
    };
    gateway.emitNotificationNew('11111111-1111-4111-8111-111111111111', payload);
    expect(gateway.server.to).toHaveBeenCalledWith('user:11111111-1111-4111-8111-111111111111');
    expect(emitTo).toHaveBeenCalledWith('notification:new', payload);
  });

  it('does not emit when recipient id is empty', () => {
    const { gateway, emitTo } = build();
    gateway.emitNotificationNew('', {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      type: 'manual',
      title: 'Hello',
      message: 'Body',
      createdAt: new Date().toISOString(),
      readAt: null,
    });
    expect(emitTo).not.toHaveBeenCalled();
  });
});
