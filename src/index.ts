import express from 'express';
import pinoHttp from 'pino-http';
import { config } from './config';
import { logger } from './logger';
import { router } from './http/routes';
import { captureRawBody } from './http/verifySignature';

const app = express();

// Logger HTTP enxuto:
// - Não loga GET /healthz e /favicon.ico (ruído de healthcheck e navegador)
// - Não loga cookies e headers grandes
// - Uma linha por request, formato: "POST /webhooks/glpi 200 12ms"
app.use(
  pinoHttp({
    logger,
    autoLogging: {
      ignore: (req) => {
        const url = req.url ?? '';
        return (
          url.startsWith('/healthz') ||
          url.startsWith('/favicon') ||
          url === '/' ||
          url.endsWith('/robots.txt')
        );
      }
    },
    serializers: {
      req: (req) => ({
        method: req.method,
        url: req.url,
        remoteAddress: req.headers?.['x-real-ip'] || req.remoteAddress
      }),
      res: (res) => ({ statusCode: res.statusCode })
    },
    customLogLevel: (_req, res, err) => {
      if (err || (res.statusCode ?? 0) >= 500) return 'error';
      if ((res.statusCode ?? 0) >= 400) return 'warn';
      return 'info';
    },
    customSuccessMessage: (req, res, responseTime) =>
      `${req.method} ${req.url} -> ${res.statusCode} (${responseTime}ms)`,
    customErrorMessage: (req, res, err) =>
      `${req.method} ${req.url} -> ${res.statusCode} (erro: ${err.message})`
  })
);

// Body parsers — usamos a opção `verify` do express.json para preservar o body raw
// nas rotas /webhooks/*, sem precisar de um middleware separado que escute 'data'/'end'
// no stream (isso causa "stream is not readable" quando pino-http já leu o stream).
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.json({ limit: '1mb', verify: captureRawBody }));

app.use(router);

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error({ err: err.message }, 'erro nao tratado');
  res.status(500).json({ error: 'internal_error' });
});

const server = app.listen(config.PORT, () => {
  logger.info(
    { port: config.PORT, dryRun: config.DRY_RUN, env: config.NODE_ENV },
    `🚀 Integrador GLPI <-> Bitrix24 online em :${config.PORT}`
  );
  if (config.DRY_RUN) {
    logger.warn('⚠️  Modo DRY_RUN ativo — webhooks são processados mas nada será criado/alterado.');
  }
});

function shutdown(signal: string) {
  logger.info({ signal }, '🛑 Desligando integrador...');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
