import crypto from 'node:crypto';
import { Request, Response, NextFunction } from 'express';
import { config } from '../config';
import { logger } from '../logger';

function timingSafeEqualHex(a: string, b: string): boolean {
  // hex strings podem ter case diferente; normaliza
  const aBuf = Buffer.from(a.toLowerCase(), 'utf8');
  const bBuf = Buffer.from(b.toLowerCase(), 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

// Captura raw body antes do parser JSON do Express. Necessário para HMAC.
export function rawBodyCapture(req: Request, _res: Response, next: NextFunction) {
  let data = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => (data += chunk));
  req.on('end', () => {
    (req as Request & { rawBody?: string }).rawBody = data;
    try {
      req.body = data ? JSON.parse(data) : {};
    } catch {
      req.body = {};
    }
    next();
  });
}

/**
 * Valida assinatura do GLPI 11.
 *
 * Conforme src/Webhook.php do GLPI 11:
 *   X-GLPI-signature = hash_hmac('sha256', body + timestamp, secret)
 *   X-GLPI-timestamp = timestamp UNIX em segundos (string numérica)
 *
 * O body é o JSON renderizado pelo template Twig (o que chega aqui em rawBody).
 * A chave secreta no GLPI fica criptografada com GLPIKey e é descriptografada antes
 * de assinar — no nosso .env guardamos o valor PLAINTEXT (como aparece no campo
 * "Segredo" do GLPI quando você clica no olhinho).
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
    logger.warn({ headers: req.headers }, 'GLPI webhook sem X-GLPI-signature');
    res.status(401).json({ error: 'missing signature header' });
    return;
  }
  if (!tsHeader) {
    logger.warn({ headers: req.headers }, 'GLPI webhook sem X-GLPI-timestamp');
    res.status(401).json({ error: 'missing timestamp header' });
    return;
  }

  // GLPI assina body+timestamp concatenados (timestamp como string)
  const expected = crypto
    .createHmac('sha256', config.GLPI_WEBHOOK_SECRET)
    .update(rawBody + tsHeader)
    .digest('hex');

  // GLPI manda hex puro, mas aceitamos variantes "sha256=" por segurança
  const provided = sig.startsWith('sha256=') ? sig.slice(7) : sig;

  if (!timingSafeEqualHex(expected, provided)) {
    logger.warn(
      {
        providedPreview: provided.slice(0, 12),
        expectedPreview: expected.slice(0, 12),
        timestamp: tsHeader,
        bodyLen: rawBody.length
      },
      'assinatura GLPI invalida'
    );
    res.status(401).json({ error: 'invalid signature' });
    return;
  }

  // Sanity check no timestamp (defesa contra replay): aceita ±10 minutos
  const ts = Number(tsHeader);
  const skewSec = Math.abs(Date.now() / 1000 - ts);
  if (Number.isFinite(ts) && skewSec > 600) {
    logger.warn({ skewSec }, 'GLPI webhook com timestamp muito antigo/futuro');
    res.status(401).json({ error: 'timestamp out of window' });
    return;
  }

  next();
}

export function verifyBitrixSecret(req: Request, res: Response, next: NextFunction) {
  // Eventos de saída do Bitrix24 enviam application_token (token do app/event) ou auth.application_token.
  // Como aqui usamos webhook entrante + um evento outbound configurado pelo admin, esperamos um
  // campo "auth[application_token]" igual ao nosso segredo.
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
