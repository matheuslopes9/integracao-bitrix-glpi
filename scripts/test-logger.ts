// Teste rápido do formato dos logs (sem subir servidor).
// Roda: npx tsx scripts/test-logger.ts
import pino from 'pino';

const logger = pino({
  level: 'info',
  base: { svc: 'integrador' },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: { level: (label) => ({ level: label }) },
  transport: {
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

setTimeout(() => {
  logger.info('🚀 Integrador GLPI <-> Bitrix24 online em :3000');
  logger.warn('⚠️  Modo DRY_RUN ativo — webhooks são processados mas nada será criado/alterado.');
  logger.info('🟡 DRY_RUN | GLPI -> ticket.add | Ticket #2605200001 aberto por KARCHER');
  logger.info('📥 GLPI -> ticket.add | Ticket #2605200002 aberto por ZAION SEGUROS');
  logger.warn('📭 GLPI -> ignorado: itemtype nao suportado (rawEvent="delete")');
  logger.error('❌ Falha processando ticket.add: tarefa Bitrix nao criada (timeout)');
}, 200);
