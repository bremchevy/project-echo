import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
export const createDatabase = () => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  return new PrismaClient({adapter:new PrismaPg({connectionString:process.env.DATABASE_URL})});
};
