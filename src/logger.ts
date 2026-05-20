import pino from 'pino';
import { config } from './config';

/**
 * Logger humanizado.
 *
 * - Em DEV: usa pino-pretty (cores, formatado por linha, sem JSON).
 * - Em PROD: também usa pino-pretty (porque os logs do EasyPanel só são visualizados
 *   em texto, e JSON gigante numa única linha ficava ilegível). Se quiser JSON estruturado
 *   para alimentar uma ferramenta tipo Loki/ELK, basta setar LOG_JSON=true via env.
 */
const useJson = process.env.LOG_JSON === 'true';

export const logger = pino({
  level: config.LOG_LEVEL,
  base: { svc: 'integrador' },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label })
  },
  transport: useJson
    ? undefined
    : {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:HH:MM:ss',
          ignore: 'pid,hostname,svc',
          singleLine: false,
          messageFormat: '{msg}'
        }
      }
});
