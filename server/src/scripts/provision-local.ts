import { PrismaClient, UserRole } from '@prisma/client';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import env from '../config/env.js';
import { hashPassword } from '../lib/auth.js';
import { prisma } from '../lib/prisma.js';

const accountSchema = z.object({
  name: z.string().trim().min(2).max(100),
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(12).max(128),
});

export type LocalProvisioningConfig = {
  admin: z.infer<typeof accountSchema>;
  moderator: z.infer<typeof accountSchema>;
};

export function readLocalProvisioningConfig(input: NodeJS.ProcessEnv): LocalProvisioningConfig {
  const isProductionProvisioning = input.NODE_ENV?.toLowerCase() === 'production';
  if (isProductionProvisioning && input.PROVISION_PRODUCTION_CONFIRM !== 'I_UNDERSTAND_PRODUCTION_PROVISIONING') {
    throw new Error('Production provisioning requires explicit confirmation.');
  }

  const databaseUrl = input.DATABASE_URL ?? env.DATABASE_URL;
  if (!isProductionProvisioning && !/^postgres(?:ql)?:\/\/[^/]*\b(?:localhost|127\.0\.0\.1)(?::\d+)?(?:\/|$)/i.test(databaseUrl)) {
    throw new Error('Local provisioning requires a loopback DATABASE_URL.');
  }

  return {
    admin: accountSchema.parse({
      name: input.ADMIN_NAME,
      email: input.ADMIN_EMAIL,
      password: input.ADMIN_PASSWORD,
    }),
    moderator: accountSchema.parse({
      name: input.MODERATOR_NAME,
      email: input.MODERATOR_EMAIL,
      password: input.MODERATOR_PASSWORD,
    }),
  };
}

export async function provisionLocalAccounts(client: Pick<PrismaClient, 'user'>, config: LocalProvisioningConfig) {
  for (const [role, account] of [[UserRole.ADMIN, config.admin], [UserRole.MODERATOR, config.moderator]] as const) {
    await client.user.upsert({
      where: { email: account.email },
      create: {
        name: account.name,
        email: account.email,
        passwordHash: await hashPassword(account.password),
        role,
        status: 'ACTIVE',
        communityRulesAccepted: true,
        communityRulesAcceptedAt: new Date(),
        rulesVersion: 'nova-community-safety-v1',
        profile: {
          create: { displayName: account.name },
        },
      },
      update: {
        role,
        status: 'ACTIVE',
        profile: {
          upsert: {
            create: { displayName: account.name },
            update: {},
          },
        },
      },
      select: { email: true, role: true },
    });
  }
}

async function main() {
  const config = readLocalProvisioningConfig(process.env);
  await provisionLocalAccounts(prisma, config);
  console.log('Local admin and moderator provisioning completed.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main()
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : 'Local provisioning failed.');
      process.exitCode = 1;
    })
    .finally(async () => prisma.$disconnect());
}