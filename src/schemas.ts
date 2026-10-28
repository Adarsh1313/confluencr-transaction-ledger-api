import { z } from 'zod';

// Shared building blocks for request and response schemas. Each schema drives
// validation, TypeScript types and the Swagger docs at the same time.

export const MAX_AMOUNT = 1_000_000_000_000; // ₹1,000 crore in paise

export const amountSchema = z
  .number()
  .int('amount must be a whole number of paise')
  .positive('amount must be greater than 0')
  .max(MAX_AMOUNT, `amount must be at most ${MAX_AMOUNT} paise`)
  .describe('Amount in paise (integer). 15050 = ₹150.50');

export const referenceIdSchema = z
  .string()
  .trim()
  .min(1, 'reference_id is required')
  .max(100)
  .refine((value) => !value.startsWith('transfer:'), 'reference_id must not start with "transfer:" (reserved)')
  .describe('Client-supplied idempotency key, unique per account');

export const descriptionSchema = z.string().trim().max(255).optional().describe('Optional, up to 255 characters');

export const transactionTypeSchema = z.enum(['credit', 'debit']);
export type TransactionType = z.infer<typeof transactionTypeSchema>;

export const accountIdParams = z.object({
  id: z.string().min(1).describe('The account ID, e.g. `acc_4fK2pQ9xTb1LmZ7cR3sV`'),
});

export const errorResponseSchema = z
  .object({
    error: z.object({
      code: z.string(),
      message: z.string(),
      details: z.unknown(),
    }),
  })
  .describe('Every error uses this shape');

// Response helpers for the docs: each status gets a human description and
// realistic example bodies, which the API reference renders next to the code.

export const ok = <T extends z.ZodType>(description: string, schema: T, example: z.output<T>) => ({
  description,
  content: { 'application/json': { schema, example } },
});

type ErrorExample = { summary: string; code: string; message: string; details?: Record<string, unknown> };

export const errorResponse = (description: string, examples: Record<string, ErrorExample>) => ({
  description,
  content: {
    'application/json': {
      schema: errorResponseSchema,
      examples: Object.fromEntries(
        Object.entries(examples).map(([name, { summary, code, message, details = {} }]) => [
          name,
          { summary, value: { error: { code, message, details } } },
        ]),
      ),
    },
  },
});

export const EXAMPLE_ACCOUNT_ID = 'acc_4fK2pQ9xTb1LmZ7cR3sV';

export const accountNotFoundExample: ErrorExample = {
  summary: 'Account does not exist',
  code: 'ACCOUNT_NOT_FOUND',
  message: 'Account acc_doesNotExist0000000 does not exist',
  details: { account_id: 'acc_doesNotExist0000000' },
};

export const paginationErrorExample: ErrorExample = {
  summary: 'Bad page or limit',
  code: 'INVALID_PAGINATION',
  message: 'Invalid querystring',
  details: { issues: [{ field: 'limit', message: 'Too big: expected number to be <=100' }] },
};

export const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(1).describe('Page number, starting at 1'),
  limit: z.coerce.number().int().min(1).max(100).default(20).describe('Items per page, 1–100'),
});

export const paginationMeta = z.object({
  page: z.number(),
  limit: z.number(),
  total_records: z.number(),
  total_pages: z.number(),
});

export function pageMeta(page: number, limit: number, totalRecords: number) {
  return { page, limit, total_records: totalRecords, total_pages: Math.ceil(totalRecords / limit) };
}
