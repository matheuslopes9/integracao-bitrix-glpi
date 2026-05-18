import crypto from 'node:crypto';
import { Request, Response, NextFunction } from 'express';
import { config } from '../config';
import { logger } from '../logger';

function timingSafeEqualStr(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// Captura raw body antes do parser JSON do Express. Necessario para HMAC.
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

export function verifyGlpiSignature(req: Request, res: Response, next: NextFunction) {
  const rawBody = (req as Request & { rawBody?: string }).rawBody ?? '';
  const sig =
    req.header('X-GLPI-Signature') ??
    req.header('X-Hub-Signature-256') ??
    req.header('X-Signature');
  if (!sig) {
    logger.warn('GLPI webhook sem assinatura');
    res.status(401).json({ error: 'missing signature header' });
    return;
  }
  const expected = crypto
    .createHmac('sha256', config.GLPI_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');
  // GLPI pode mandar como hex puro ou "sha256=hex"
  const provided = sig.startsWith('sha256=') ? sig.slice(7) : sig;
  if (!timingSafeEqualStr(expected, provided)) {
    logger.warn({ sigPreview: provided.slice(0, 8) }, 'assinatura GLPI invalida');
    res.status(401).json({ error: 'invalid signature' });
    return;
  }
  next();
}

export function verifyBitrixSecret(req: Request, res: Response, next: NextFunction) {
  // Eventos de saida do Bitrix24 enviam application_token (token do app/event) ou auth.application_token.
  // Como aqui usamos webhook entrante + um evento outbound configurado pelo admin, esperamos um campo "auth[application_token]" igual ao nosso segredo.
  const body = req.body as { auth?: { application_token?: string }; application_token?: string };
  const provided =
    body?.auth?.application_token ??
    body?.application_token ??
    req.header('X-Bitrix-Token') ??
    '';
  if (!timingSafeEqualStr(provided, config.BITRIX_WEBHOOK_SECRET)) {
    logger.warn('Bitrix webhook com token invalido');
    res.status(401).json({ error: 'invalid bitrix token' });
    return;
  }
  next();
}
