import { Router, Request, Response } from 'express';
import { config } from '../config';
import { logger } from '../logger';
import { auditLog } from '../db';
import {
  handleGlpiTicketCreated,
  handleGlpiTicketUpdated,
  handleGlpiFollowupAdded
} from '../sync/glpiToBitrix';
import {
  handleBitrixTaskUpdated,
  handleBitrixTaskCommentAdded
} from '../sync/bitrixToGlpi';
import { verifyGlpiSignature, verifyBitrixSecret } from './verifySignature';
import { parseGlpiPayload } from './glpiPayloadParser';

export const router = Router();

router.get('/healthz', (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString(), dryRun: config.DRY_RUN });
});

/**
 * GLPI -> integrador.
 *
 * GLPI 11 envia payload aninhado:
 *   {
 *     "event": "new" | "update" | ...,
 *     "itemtype": "Ticket" | "ITILFollowup",
 *     "item": { "id": "...", "name": "...", "content": "...", "status": {...}, ... }
 *   }
 *
 * Assinatura HMAC-SHA256 vem em X-GLPI-signature.
 */
router.post('/webhooks/glpi', verifyGlpiSignature, async (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;
  const event = parseGlpiPayload(body);
  logger.info(
    { eventKind: event.kind, dryRun: config.DRY_RUN, rawEvent: body.event, rawItemtype: body.itemtype },
    'webhook GLPI recebido'
  );

  if (event.kind === 'unknown') {
    logger.warn({ reason: event.reason, body }, 'evento GLPI ignorado');
    auditLog.record('glpi', `unknown`, body, 'error', event.reason);
    res.json({ ok: true, ignored: true, reason: event.reason });
    return;
  }

  if (config.DRY_RUN) {
    logger.info({ event }, '[DRY_RUN] evento seria processado, mas nada será criado/alterado');
    auditLog.record('glpi', event.kind, body, 'ok', 'dry-run');
    res.json({ ok: true, dryRun: true, event });
    return;
  }

  try {
    switch (event.kind) {
      case 'ticket.add':
        await handleGlpiTicketCreated(event.ticketId);
        break;
      case 'ticket.update':
        await handleGlpiTicketUpdated(event.ticketId);
        break;
      case 'followup.add':
        await handleGlpiFollowupAdded({
          followupId: event.followupId,
          ticketId: event.ticketId,
          content: event.content,
          glpiUserId: event.usersId
        });
        break;
    }
    auditLog.record('glpi', event.kind, body, 'ok');
    res.json({ ok: true });
  } catch (err) {
    const msg = (err as Error).message;
    logger.error({ err: msg, event }, 'falha processando webhook GLPI');
    auditLog.record('glpi', event.kind, body, 'error', msg);
    res.status(500).json({ ok: false, error: msg });
  }
});

/**
 * Bitrix -> integrador. Eventos ONTASKADD/UPDATE/COMMENTADD vêm como form-urlencoded ou json.
 */
router.post('/webhooks/bitrix', verifyBitrixSecret, async (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown> & {
    event?: string;
    data?: Record<string, unknown> & { FIELDS_AFTER?: Record<string, unknown>; FIELDS_BEFORE?: Record<string, unknown> };
  };
  const event = String(body.event ?? body.EVENT ?? '').toUpperCase();
  logger.info({ event, dryRun: config.DRY_RUN }, 'webhook Bitrix recebido');

  if (config.DRY_RUN) {
    logger.info({ event, body }, '[DRY_RUN] evento Bitrix seria processado, mas nada será criado/alterado');
    auditLog.record('bitrix', event, body, 'ok', 'dry-run');
    res.json({ ok: true, dryRun: true });
    return;
  }

  try {
    if (event === 'ONTASKUPDATE' || event === 'ONTASKADD') {
      const taskId = Number(
        body.data?.FIELDS_AFTER?.ID ??
          (body.data as { FIELDS?: { ID?: unknown } } | undefined)?.FIELDS?.ID
      );
      if (Number.isFinite(taskId)) {
        await handleBitrixTaskUpdated(taskId);
      }
    } else if (event === 'ONTASKCOMMENTADD') {
      const taskId = Number((body.data as { TASK_ID?: unknown } | undefined)?.TASK_ID);
      const commentId = Number((body.data as { ID?: unknown } | undefined)?.ID);
      if (Number.isFinite(taskId) && Number.isFinite(commentId)) {
        await handleBitrixTaskCommentAdded(taskId, commentId);
      }
    } else {
      logger.warn({ event }, 'evento Bitrix nao suportado, ignorando');
    }
    auditLog.record('bitrix', event, body, 'ok');
    res.json({ ok: true });
  } catch (err) {
    const msg = (err as Error).message;
    logger.error({ err: msg, event }, 'falha processando webhook Bitrix');
    auditLog.record('bitrix', event, body, 'error', msg);
    res.status(500).json({ ok: false, error: msg });
  }
});
