import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import type { Response } from 'express';
import { z, ZodError, ZodTypeAny } from 'zod';
import { AiServiceError } from '../ai/ai-client.service';
import { redactString } from './redact';

/** Parses untrusted input with a zod schema, raising a 400 with field-level messages. */
export function parse<S extends ZodTypeAny>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) throw new BadRequestException(formatZod(result.error));
  return result.data;
}

export function formatZod(error: ZodError): { message: string; issues: Array<{ path: string; message: string }> } {
  return {
    message: 'Validation failed',
    issues: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
  };
}

/**
 * Converts every error into a safe JSON body. Internal errors are logged (redacted)
 * and reported to clients only as a generic message - no stack traces.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Errors');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      res.status(status).json(typeof body === 'string' ? { statusCode: status, message: body } : { statusCode: status, ...body });
      return;
    }
    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === 'P2002') {
        res.status(HttpStatus.CONFLICT).json({ statusCode: 409, message: 'A record with these values already exists' });
        return;
      }
      if (exception.code === 'P2025') {
        res.status(HttpStatus.NOT_FOUND).json({ statusCode: 404, message: 'Not found' });
        return;
      }
    }
    if (exception instanceof AiServiceError) {
      // Client errors from the AI service (unknown secret, invalid input) are the caller's to fix;
      // anything else means the AI service is down or broken, which is not a server bug.
      if (exception.status === 404 || exception.status === 400 || exception.status === 422) {
        const status = exception.status === 404 ? HttpStatus.NOT_FOUND : HttpStatus.BAD_REQUEST;
        res.status(status).json({ statusCode: status, message: exception.message });
        return;
      }
      this.logger.warn(redactString(exception.message));
      const status = exception.status === undefined ? HttpStatus.SERVICE_UNAVAILABLE : HttpStatus.BAD_GATEWAY;
      res.status(status).json({ statusCode: status, message: 'AI service unavailable' });
      return;
    }
    const err = exception as Error;
    this.logger.error(redactString(`${err?.name ?? 'Error'}: ${err?.message ?? String(exception)}`));
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ statusCode: 500, message: 'Internal server error' });
  }
}
