import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp(); const response = ctx.getResponse(); const request = ctx.getRequest();
    const prismaCode = typeof exception === 'object' && exception !== null && 'code' in exception ? String((exception as {code:unknown}).code) : '';
    const status = exception instanceof HttpException ? exception.getStatus() : prismaCode === 'P2002' ? HttpStatus.CONFLICT : prismaCode === 'P2025' ? HttpStatus.NOT_FOUND : prismaCode === 'P2003' ? HttpStatus.CONFLICT : HttpStatus.INTERNAL_SERVER_ERROR;
    const raw = exception instanceof HttpException ? exception.getResponse() : null;
    const message = typeof raw === 'string' ? raw : (raw as { message?: unknown } | null)?.message;
    response.status(status).json({ error: {
      code: status >= 500 ? 'INTERNAL_ERROR' : HttpStatus[status].toUpperCase(),
      message: status >= 500 ? 'An unexpected error occurred' : prismaCode ? (prismaCode === 'P2002' ? 'A record with this unique value already exists' : prismaCode === 'P2025' ? 'The requested record was not found' : 'The change conflicts with related records') : Array.isArray(message) ? 'Request validation failed' : message ?? 'Request failed',
      details: Array.isArray(message) ? message.map((m) => ({ message: m })) : prismaCode === 'P2002' ? [{field: 'unique', message: 'Value must be unique'}] : [],
      requestId: request.headers['x-request-id'] ?? randomUUID(),
    }});
  }
}
