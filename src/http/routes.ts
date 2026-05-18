import { Router, Request, Response } from 'express';
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

export const router = Router();

router.get('/healthz', (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

/**
 * Endpoint GLPI -> nosso integrador.
 * Esperamos um payload customizado no webhook do GLPI 10 com a forma:
 *   {
 *     "event":   "add" | "update" | "followup_add",   // GLPI manda como "add"/"update" do itemtype
 *     "itemtype":"Ticket" | "ITILFollowup",
 *     "items_id": 123,
 *     "ticket_id": 123,                                // util para ITILFollowup
 *     "content": "...",                                // util para followup
 *     "users_id": 4                                    // util para followup
 *   }
 */
router.post('/webhooks/glpi', verifyGlpiSignature, async (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;
  logger.info({ body }, 'webhook GLPI recebido');

  // GLPI 10 envia "event" e "itemtype"; tentamos cobrir os dois formatos
  const itemtype = String(body.itemtype ?? body.item_type ?? '').toLowerCase();
  const event = String(body.event ?? body.action ?? '').toLowerCase();

  try {
    if (itemtype === 'ticket') {
      const id = Number(body.items_id ?? body.id ?? body.ticket_id);
      if (!Number.isFinite(id) || id <= 0) {
        throw new Error('ticket_id ausente no payload');
      }
      if (event.includes('add') || event.includes('create')) {
        await handleGlpiTicketCreated(id);
      } else {
        await handleGlpiTicketUpdated(id);
      }
    } else if (itemtype === 'itilfollowup' || itemtype === 'ticketfollowup') {
      const ticketId = Number(
        body.ticket_id ?? body.items_id_ticket ?? (body.ticket as { id?: unknown } | undefined)?.id
      );
      const followupId = Number(body.items_id ?? body.id);
      const content = String(body.content ?? '');
      const usersId = body.users_id != null ? Number(body.users_id) : undefined;
      if (!Number.isFinite(ticketId) || !Number.isFinite(followupId)) {
        throw new Error('ids do followup ausentes');
      }
      await handleGlpiFollowupAdded({ followupId, ticketId, content, glpiUserId: usersId });
    } else {
      logger.warn({ itemtype, event }, 'evento GLPI nao suportado, ignorando');
    }
    auditLog.record('glpi', `${itemtype}:${event}`, body, 'ok');
    res.json({ ok: true });
  } catch (err) {
    const msg = (err as Error).message;
    logger.error({ err: msg, body }, 'falha processando webhook GLPI');
    auditLog.record('glpi', `${itemtype}:${event}`, body, 'error', msg);
    res.status(500).json({ ok: false, error: msg });
  }
});

/**
 * Endpoint Bitrix -> nosso integrador.
 * Bitrix24 envia event = "ONTASKADD" / "ONTASKUPDATE" / "ONTASKCOMMENTADD" como form-urlencoded.
 * Espera que voce configure um "event handler" (Apps > Webhooks > Outgoing) ou crie um app local com event.bind.
 * O Express ja parseia urlencoded; aqui aceitamos json tambem.
 */
router.post('/webhooks/bitrix', verifyBitrixSecret, async (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown> & {
    event?: string;
    data?: Record<string, unknown> & { FIELDS_AFTER?: Record<string, unknown>; FIELDS_BEFORE?: Record<string, unknown> };
  };
  const event = String(body.event ?? body.EVENT ?? '').toUpperCase();
  logger.info({ event }, 'webhook Bitrix recebido');

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
