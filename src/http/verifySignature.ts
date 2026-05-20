import crypto from 'node:crypto';
import { Request, Response, NextFunction } from 'express';
import { config } from '../config';
import { logger } from '../logger';

function timingSafeEqualHex(a: string, b: string): boolean {
  const aBuf = Buffer.from(a.toLowerCase(), 'utf8');
  const bBuf = Buffer.from(b.toLowerCase(), 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

/**
 * Captura raw body como Buffer (sem mexer no encoding do stream).
 * Em alguns ambientes (atrás de proxy/EasyPanel), chamar setEncoding('utf8') causa
 * "stream encoding should not be set" e o body fica vazio.
 */
export function rawBodyCapture(req: Request, _res: Response, next: NextFunction) {
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer | string) => {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  });
  req.on('end', () => {
    const buf = Buffer.concat(chunks);
    const text = buf.toString('utf8');
    (req as Request & { rawBody?: string }).rawBody = text;
    try {
      req.body = text ? JSON.parse(text) : {};
    } catch {
      req.body = {};
    }
    next();
  });
  req.on('error', (err) => {
    logger.error({ err: err.message }, 'rawBodyCapture stream error');
    next(err);
  });
}

/**
 * Valida assinatura do GLPI 11.
 *
 * Conforme src/Webhook.php do GLPI 11:
 *   X-GLPI-signature = hash_hmac('sha256', body + timestamp, secret)
 *   X-GLPI-timestamp = timestamp UNIX em segundos (string numérica)
 *
 * Nota: a janela de tempo não é aplicada porque o GLPI pode reprocessar webhooks
 * antigos da fila. Replay-protection precisa ser feita por idempotência (id do
 * evento), não por timestamp.
 */
export function verifyGlpiSignature(req: Request, res: Response, next: NextFunction) {
  const rawBody = (req as Request & { rawBody?: string }).rawBody ?? '';
  const sig =
    req.header('X-GLPI-signature') ??
    req.header('X-GLPI-Signature') ??
    req.header('x-glpi-signature');
  const tsHeader =
    req.header('X-GLPI-timestamp') ??
    req.header('X-GLPI-Timestamp') ??
    req.header('x-glpi-timestamp');

  if (!sig) {
    logger.warn('GLPI webhook sem X-GLPI-signature');
    res.status(401).json({ error: 'missing signature header' });
    return;
  }
  if (!tsHeader) {
    logger.warn('GLPI webhook sem X-GLPI-timestamp');
    res.status(401).json({ error: 'missing timestamp header' });
    return;
  }

  const provided = (sig.startsWith('sha256=') ? sig.slice(7) : sig).toLowerCase();
  const secret = config.GLPI_WEBHOOK_SECRET;

  // Calcula a variante "oficial" do GLPI: HMAC(body + timestamp)
  const expectedBodyPlusTs = crypto.createHmac('sha256', secret).update(rawBody + tsHeader).digest('hex');

  if (timingSafeEqualHex(expectedBodyPlusTs, provided)) {
    return next();
  }

  // ---- Não bateu. Faz log de DEBUG com variantes para identificar o algoritmo certo. ----
  const variants: Record<string, string> = {
    bodyOnly: crypto.createHmac('sha256', secret).update(rawBody).digest('hex'),
    tsOnly: crypto.createHmac('sha256', secret).update(tsHeader).digest('hex'),
    bodyPlusTs: expectedBodyPlusTs,
    tsPlusBody: crypto.createHmac('sha256', secret).update(tsHeader + rawBody).digest('hex'),
    bodyTrimPlusTs: crypto.createHmac('sha256', secret).update(rawBody.trim() + tsHeader).digest('hex'),
    bodyPlusTsTrim: crypto.createHmac('sha256', secret).update(rawBody + tsHeader.trim()).digest('hex'),
    // GLPI talvez assine sem o timestamp, mas em SHA1
    bodyOnlySha1: crypto.createHmac('sha1', secret).update(rawBody).digest('hex'),
    // ou em base64 ao invés de hex
    bodyPlusTsBase64: crypto.createHmac('sha256', secret).update(rawBody + tsHeader).digest('base64')
  };

  const matched = Object.entries(variants).find(([, v]) => v.toLowerCase() === provided);

  logger.warn(
    {
      provided,
      tsHeader,
      bodyLen: rawBody.length,
      bodyFirst100: rawBody.slice(0, 100),
      bodyLast100: rawBody.slice(-100),
      secretLen: secret.length,
      secretPreview: secret.slice(0, 4) + '...' + secret.slice(-4),
      variants,
      matchedVariant: matched?.[0] ?? 'NONE'
    },
    '[DEBUG] assinatura GLPI invalida'
  );

  res.status(401).json({ error: 'invalid signature' });
}

export function verifyBitrixSecret(req: Request, res: Response, next: NextFunction) {
  const body = req.body as { auth?: { application_token?: string }; application_token?: string };
  const provided =
    body?.auth?.application_token ??
    body?.application_token ??
    req.header('X-Bitrix-Token') ??
    '';
  if (provided.length !== config.BITRIX_WEBHOOK_SECRET.length) {
    logger.warn('Bitrix webhook com token invalido (tamanho)');
    res.status(401).json({ error: 'invalid bitrix token' });
    return;
  }
  const a = Buffer.from(provided);
  const b = Buffer.from(config.BITRIX_WEBHOOK_SECRET);
  if (!crypto.timingSafeEqual(a, b)) {
    logger.warn('Bitrix webhook com token invalido');
    res.status(401).json({ error: 'invalid bitrix token' });
    return;
  }
  next();
}
