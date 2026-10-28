import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'INVALID_REQUEST_BODY'
  | 'INVALID_PAGINATION'
  | 'ACCOUNT_NOT_FOUND'
  | 'TRANSFER_NOT_FOUND'
  | 'ROUTE_NOT_FOUND'
  | 'DUPLICATE_TRANSACTION'
  | 'DUPLICATE_TRANSFER'
  | 'INSUFFICIENT_BALANCE'
  | 'SAME_ACCOUNT_TRANSFER'
  | 'INTERNAL_ERROR';

export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: ErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export const accountNotFound = (accountId: string) =>
  new AppError(404, 'ACCOUNT_NOT_FOUND', `Account ${accountId} does not exist`, { account_id: accountId });

export const insufficientBalance = (accountId: string, balance: number, amount: number) =>
  new AppError(422, 'INSUFFICIENT_BALANCE', `Balance ${balance} is less than debit ${amount}`, {
    account_id: accountId,
    balance,
    amount,
  });

function send(reply: FastifyReply, statusCode: number, code: ErrorCode, message: string, details: unknown = {}) {
  return reply.status(statusCode).send({ error: { code, message, details } });
}

/** Turns every error into the one response shape: { error: { code, message, details } }. */
export function errorHandler(error: FastifyError, request: FastifyRequest, reply: FastifyReply) {
  if (error instanceof AppError) {
    return send(reply, error.statusCode, error.code, error.message, error.details);
  }

  if (hasZodFastifySchemaValidationErrors(error)) {
    const issues = error.validation.map((issue) => ({
      field: issue.instancePath.replace(/^\//, '').replaceAll('/', '.') || null,
      message: issue.message,
    }));
    const isPagination =
      error.validationContext === 'querystring' &&
      issues.some((issue) => issue.field === 'page' || issue.field === 'limit');
    const code: ErrorCode = isPagination ? 'INVALID_PAGINATION' : 'VALIDATION_ERROR';
    return send(reply, 400, code, `Invalid ${error.validationContext ?? 'request'}`, { issues });
  }

  // Malformed JSON, empty JSON body, wrong content type, etc.
  if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500) {
    return send(reply, error.statusCode, 'INVALID_REQUEST_BODY', error.message);
  }

  request.log.error({ err: error }, 'unhandled error');
  return send(reply, 500, 'INTERNAL_ERROR', 'Something went wrong');
}
