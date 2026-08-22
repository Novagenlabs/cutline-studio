import { PrismaClient } from '@prisma/client';

// Next reloads modules in dev; without the global cache each reload opens a
// new pool and eventually exhausts Postgres connections.
const g = globalThis as unknown as { prisma?: PrismaClient };

export const db = g.prisma ?? new PrismaClient();
if (process.env.NODE_ENV !== 'production') g.prisma = db;
