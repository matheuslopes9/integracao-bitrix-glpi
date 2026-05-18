import { config } from '../config';
import { logger } from '../logger';
import { glpiClient, GlpiClient } from '../clients/glpiClient';
import { bitrixClient, BITRIX_TASK_STATUS } from '../clients/bitrixClient';
import { linkRepo, userRepo, echoGuard, followupRepo } from '../db';

function mapGlpiStatusToBitrix(glpiStatus: number): number {
  switch (glpiStatus) {
    case GlpiClient.STATUS.NEW:
      return BITRIX_TASK_STATUS.NEW;
    case GlpiClient.STATUS.PROCESSING_ASSIGNED:
    case GlpiClient.STATUS.PROCESSING_PLANNED:
      return BITRIX_TASK_STATUS.IN_PROGRESS;
    case GlpiClient.STATUS.PENDING:
      return BITRIX_TASK_STATUS.DEFERRED;
    case GlpiClient.STATUS.SOLVED:
    case GlpiClient.STATUS.CLOSED:
      return BITRIX_TASK_STATUS.COMPLETED;
    default:
      return BITRIX_TASK_STATUS.NEW;
  }
}

async function resolveResponsibleId(glpiTicketId: number): Promise<number> {
  const assigned = await glpiClient.listTicketUsers(glpiTicketId, 'assigned');
  if (assigned.length === 0) return config.BITRIX_DEFAULT_RESPONSIBLE_ID;
  const glpiUserId = assigned[0].users_id;
  const mapped = userRepo.glpiToBitrix(glpiUserId);
  if (mapped) return mapped;

  // tenta mapear automaticamente por e-mail
  try {
    const u = await glpiClient.getUser(glpiUserId);
    if (u && (u as { name?: string }).name) {
      // fallback: usa o default mas registra que precisa mapear
      logger.warn(
        { glpiUserId, login: (u as { name?: string }).name },
        'usuario GLPI sem mapeamento Bitrix - usando default'
      );
    }
  } catch (e) {
    logger.warn({ err: (e as Error).message, glpiUserId }, 'falha ao consultar usuario GLPI');
  }
  return config.BITRIX_DEFAULT_RESPONSIBLE_ID;
}

export async function handleGlpiTicketCreated(ticketId: number): Promise<void> {
  if (linkRepo.findByGlpiTicket(ticketId)) {
    logger.info({ ticketId }, 'ticket ja vinculado, ignorando criacao');
    return;
  }
  const ticket = await glpiClient.getTicket(ticketId);
  const responsibleId = await resolveResponsibleId(ticketId);

  const description = [
    `[GLPI #${ticket.id}] — Importado automaticamente`,
    '',
    ticket.content?.replace(/<[^>]+>/g, '').trim() ?? '(sem descrição)',
    '',
    `Link GLPI: ${config.GLPI_BASE_URL}/front/ticket.form.php?id=${ticket.id}`
  ].join('\n');

  const created = await bitrixClient.createTask({
    TITLE: `[GLPI #${ticket.id}] ${ticket.name}`,
    DESCRIPTION: description,
    RESPONSIBLE_ID: responsibleId,
    CREATED_BY: config.BITRIX_DEFAULT_CREATOR_ID,
    GROUP_ID: config.BITRIX_DEFAULT_GROUP_ID,
    STATUS: mapGlpiStatusToBitrix(ticket.status),
    TAGS: ['glpi', `glpi-${ticket.id}`]
  });
  linkRepo.upsert(ticketId, created.id);
  // bloqueia loop quando o Bitrix devolver o evento ONTASKADD
  echoGuard.arm(`bitrix-task-add:${created.id}`, 15_000);
  logger.info({ ticketId, bitrixTaskId: created.id }, 'ticket->task criado');
}

export async function handleGlpiTicketUpdated(ticketId: number): Promise<void> {
  const link = linkRepo.findByGlpiTicket(ticketId);
  if (!link) {
    logger.info({ ticketId }, 'ticket sem vinculo, criando');
    await handleGlpiTicketCreated(ticketId);
    return;
  }

  const ticket = await glpiClient.getTicket(ticketId);
  const responsibleId = await resolveResponsibleId(ticketId);
  const bitrixStatus = mapGlpiStatusToBitrix(ticket.status);

  await bitrixClient.updateTask(link.bitrix_task_id, {
    TITLE: `[GLPI #${ticket.id}] ${ticket.name}`,
    RESPONSIBLE_ID: responsibleId,
    STATUS: bitrixStatus
  });
  echoGuard.arm(`bitrix-task-update:${link.bitrix_task_id}`, 10_000);

  if (
    ticket.status === GlpiClient.STATUS.SOLVED ||
    ticket.status === GlpiClient.STATUS.CLOSED
  ) {
    try {
      await bitrixClient.completeTask(link.bitrix_task_id);
    } catch (e) {
      logger.warn({ err: (e as Error).message }, 'completeTask falhou (talvez ja completa)');
    }
  }

  logger.info({ ticketId, bitrixTaskId: link.bitrix_task_id }, 'task atualizada');
}

export async function handleGlpiFollowupAdded(args: {
  followupId: number;
  ticketId: number;
  content: string;
  glpiUserId?: number;
}): Promise<void> {
  if (followupRepo.alreadyHandled(args.followupId, 'glpi->bitrix')) {
    logger.info({ followupId: args.followupId }, 'followup ja processado, ignorando');
    return;
  }
  let link = linkRepo.findByGlpiTicket(args.ticketId);
  if (!link) {
    await handleGlpiTicketCreated(args.ticketId);
    link = linkRepo.findByGlpiTicket(args.ticketId);
  }
  if (!link) {
    throw new Error(`Nao foi possivel criar/encontrar vinculo para ticket ${args.ticketId}`);
  }

  const authorId = args.glpiUserId ? userRepo.glpiToBitrix(args.glpiUserId) : undefined;
  const cleaned = args.content.replace(/<[^>]+>/g, '').trim();
  const message = authorId
    ? cleaned
    : `[GLPI] ${cleaned}`;

  const commentId = await bitrixClient.addComment(link.bitrix_task_id, message, authorId);
  followupRepo.mark(args.followupId, args.ticketId, 'glpi->bitrix', commentId);
  echoGuard.arm(`bitrix-comment-add:${link.bitrix_task_id}:${commentId}`, 15_000);
  logger.info({ followupId: args.followupId, commentId }, 'followup->comment criado');
}
