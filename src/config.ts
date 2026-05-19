import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  DATABASE_PATH: z.string().default('./data/integrador.db'),

  GLPI_BASE_URL: z.string().url(),
  GLPI_APP_TOKEN: z.string().min(1),
  GLPI_USER_TOKEN: z.string().min(1),
  GLPI_WEBHOOK_SECRET: z.string().min(8),
  GLPI_DEFAULT_ENTITY_ID: z.coerce.number().int().nonnegative().default(0),

  BITRIX_WEBHOOK_URL: z.string().url(),
  BITRIX_WEBHOOK_SECRET: z.string().min(8),
  BITRIX_DEFAULT_CREATOR_ID: z.coerce.number().int().positive(),
  BITRIX_DEFAULT_RESPONSIBLE_ID: z.coerce.number().int().positive(),
  BITRIX_DEFAULT_GROUP_ID: z.coerce.number().int().nonnegative().optional(),

  // Modo simulação: quando ligado, recebe webhooks e processa tudo, MAS não cria/altera
  // nada no Bitrix nem no GLPI - só loga "criaria X com fields Y". Útil para validar em produção
  // sem efeitos colaterais. Ligue temporariamente em DRY_RUN=true e desligue após validar.
  DRY_RUN: z
    .union([z.literal('true'), z.literal('false'), z.literal('1'), z.literal('0')])
    .optional()
    .transform((v) => v === 'true' || v === '1')
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('[config] Variáveis de ambiente inválidas:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = {
  ...parsed.data,
  GLPI_BASE_URL: parsed.data.GLPI_BASE_URL.replace(/\/+$/, ''),
  BITRIX_WEBHOOK_URL: parsed.data.BITRIX_WEBHOOK_URL.endsWith('/')
    ? parsed.data.BITRIX_WEBHOOK_URL
    : parsed.data.BITRIX_WEBHOOK_URL + '/'
};

export type AppConfig = typeof config;
