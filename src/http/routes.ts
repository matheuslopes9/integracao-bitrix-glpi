import { Router, Request, Response } from 'express';
import { config } from '../config';
import { logger } from '../logger';
import { auditLog } from '../db';
import {
  handleGlpiTicketCreated,
  handleGlpiTicketUpdated,
  handleGlpiFollowupAdded,
  CnpjMatchError
} from '../sync/glpiToBitrix';
import {
  handleBitrixTaskAdded,
  handleBitrixTaskUpdated,
  handleBitrixTaskCommentAdded,
  BitrixCnpjMatchError
} from '../sync/bitrixToGlpi';
import { verifyGlpiSignature, verifyBitrixSecret } from './verifySignature';
import { parseGlpiPayload } from './glpiPayloadParser';

export const router = Router();

router.get('/healthz', (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString(), dryRun: config.DRY_RUN });
});

/**
 * Endpoint que recebe webhooks do GLPI 11.
 * Headers: X-GLPI-signature (HMAC-SHA256 de body+timestamp), X-GLPI-timestamp.
 */
router.post('/webhooks/glpi', verifyGlpiSignature, async (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;
  const event = parseGlpiPayload(body);

  // Pega o nome curto do cliente (grupo no team[]) para o log ficar mais informativo
  const teamCompany =
    Array.isArray((body.item as { team?: unknown[] } | undefined)?.team)
      ? ((body.item as { team: Array<{ role?: string; display_name?: string; href?: string }> }).team
          .find((t) => t.role === 'requester' && t.href?.includes('group.form.php'))?.display_name)
      : undefined;

  if (event.kind === 'unknown') {
    logger.warn(
      `📭 GLPI -> ignorado: ${event.reason} (rawEvent="${String(body.event ?? '?')}")`
    );
    auditLog.record('glpi', 'unknown', body, 'error', event.reason);
    res.json({ ok: true, ignored: true, reason: event.reason });
    return;
  }

  const summary =
    event.kind === 'ticket.add'
      ? `Ticket #${event.ticketId} aberto${teamCompany ? ` por ${teamCompany}` : ''}`
      : event.kind === 'ticket.update'
        ? `Ticket #${event.ticketId} atualizado`
        : `Followup #${event.followupId} no ticket #${event.ticketId}`;

  if (config.DRY_RUN) {
    logger.info(`🟡 DRY_RUN | GLPI -> ${event.kind} | ${summary}`);
    auditLog.record('glpi', event.kind, body, 'ok', 'dry-run');
    res.json({ ok: true, dryRun: true, event });
    return;
  }

  logger.info(`📥 GLPI -> ${event.kind} | ${summary}`);

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
    if (err instanceof CnpjMatchError) {
      // Caso de negócio: chamado sem CNPJ válido ou sem Company correspondente.
      // Devolve 422 (não-retentável) e registra no audit. NÃO é "erro técnico".
      logger.warn(`⛔ ${msg}`);
      auditLog.record('glpi', event.kind, body, 'error', `${err.code}: ${msg}`);
      res.status(422).json({ ok: false, error: err.code, message: msg, details: err.details });
      return;
    }
    logger.error(`❌ Falha processando ${event.kind}: ${msg}`);
    auditLog.record('glpi', event.kind, body, 'error', msg);
    res.status(500).json({ ok: false, error: msg });
  }
});

/**
 * Endpoint que recebe eventos de saída do Bitrix24 (ONTASKADD/UPDATE/COMMENTADD).
 */
router.post('/webhooks/bitrix', verifyBitrixSecret, async (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown> & {
    event?: string;
    data?: Record<string, unknown> & {
      FIELDS_AFTER?: Record<string, unknown>;
      FIELDS_BEFORE?: Record<string, unknown>;
    };
  };
  const event = String(body.event ?? body.EVENT ?? '').toUpperCase();

  if (config.DRY_RUN) {
    logger.info(`🟡 DRY_RUN | Bitrix -> ${event}`);
    auditLog.record('bitrix', event, body, 'ok', 'dry-run');
    res.json({ ok: true, dryRun: true });
    return;
  }

  logger.info(`📥 Bitrix -> ${event}`);

  try {
    if (event === 'ONTASKADD') {
      const taskId = Number(
        body.data?.FIELDS_AFTER?.ID ??
          (body.data as { FIELDS?: { ID?: unknown } } | undefined)?.FIELDS?.ID
      );
      if (Number.isFinite(taskId)) await handleBitrixTaskAdded(taskId);
    } else if (event === 'ONTASKUPDATE') {
      const taskId = Number(
        body.data?.FIELDS_AFTER?.ID ??
          (body.data as { FIELDS?: { ID?: unknown } } | undefined)?.FIELDS?.ID
      );
      if (Number.isFinite(taskId)) await handleBitrixTaskUpdated(taskId);
    } else if (event === 'ONTASKCOMMENTADD') {
      const taskId = Number((body.data as { TASK_ID?: unknown } | undefined)?.TASK_ID);
      const commentId = Number((body.data as { ID?: unknown } | undefined)?.ID);
      if (Number.isFinite(taskId) && Number.isFinite(commentId)) {
        await handleBitrixTaskCommentAdded(taskId, commentId);
      }
    } else {
      logger.warn(`📭 Bitrix -> evento ignorado: ${event}`);
    }
    auditLog.record('bitrix', event, body, 'ok');
    res.json({ ok: true });
  } catch (err) {
    const msg = (err as Error).message;
    if (err instanceof BitrixCnpjMatchError) {
      logger.warn(`⛔ ${msg}`);
      auditLog.record('bitrix', event, body, 'error', `${err.code}: ${msg}`);
      res.status(422).json({ ok: false, error: err.code, message: msg, details: err.details });
      return;
    }
    logger.error(`❌ Falha processando ${event}: ${msg}`);
    auditLog.record('bitrix', event, body, 'error', msg);
    res.status(500).json({ ok: false, error: msg });
  }
});
