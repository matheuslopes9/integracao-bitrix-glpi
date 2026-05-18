import express from 'express';
import pinoHttp from 'pino-http';
import { config } from './config';
import { logger } from './logger';
import { router } from './http/routes';
import { rawBodyCapture } from './http/verifySignature';

const app = express();

app.use(pinoHttp({ logger }));

// Para a rota /webhooks/glpi precisamos do raw body para validar HMAC.
// Usamos um middleware que captura o raw antes do parse, somente nesta rota.
app.use('/webhooks/glpi', rawBodyCapture);
// Bitrix envia form-urlencoded e/ou json
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.json({ limit: '1mb' }));

app.use(router);

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error({ err: err.message }, 'erro nao tratado');
  res.status(500).json({ error: 'internal_error' });
});

const server = app.listen(config.PORT, () => {
  logger.info({ port: config.PORT }, 'integrador glpi <-> bitrix online');
});

function shutdown(signal: string) {
  logger.info({ signal }, 'desligando');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
