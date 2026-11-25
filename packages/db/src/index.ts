import { PrismaClient, Prisma } from '@prisma/client';

export * from '@prisma/client';
export * from './outbox';
export * from './audit';
export * from './lease';
export * from './transitions';
export * from './controls';
export * from './operator-tasks';

export type Db = PrismaClient;
export type Tx = Prisma.TransactionClient;
/** Anything that can run queries: the root client or an interactive transaction. */
export type Q = Db | Tx;

export function createDb(url = process.env.DATABASE_URL): PrismaClient {
  return new PrismaClient({ datasources: { db: { url } } });
}

/** Run fn in a transaction (READ COMMITTED + explicit row locks where needed). */
export function tx<T>(db: Db, fn: (t: Tx) => Promise<T>, timeoutMs = 15_000): Promise<T> {
  return db.$transaction(fn, { timeout: timeoutMs, maxWait: 10_000 });
}

export function json(v: unknown): Prisma.InputJsonValue {
  return v as Prisma.InputJsonValue;
}
export * from './content-ops';
export * from './dedup';
export * from './dispatch-publication';
export * from './comment-persona';
