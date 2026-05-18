import { logger } from '../logger';
import { glpiClient, GlpiClient } from '../clients/glpiClient';
import { bitrixClient, BITRIX_TASK_STATUS } from '../clients/bitrixClient';
import { linkRepo, userRepo, echoGuard } from '../db';

function mapBitrixStatusToGlpi(status: number): number | undefined {
  switch (status) {
    case BITRIX_TASK_STATUS.NEW:
      return GlpiClient.STATUS.NEW;
    case BITRIX_TASK_STATUS.IN_PROGRESS:
    case BITRIX_TASK_STATUS.WAITING_FOR_EXECUTION:
      return GlpiClient.STATUS.PROCESSING_ASSIGNED;
    case BITRIX_TASK_STATUS.WAITING_FOR_CONTROL:
      return GlpiClient.STATUS.SOLVED;
    case BITRIX_TASK_STATUS.COMPLETED:
      return GlpiClient.STATUS.CLOSED;
    case BITRIX_TASK_STATUS.DEFERRED:
      return GlpiClient.STATUS.PENDING;
    default:
      return undefined;
  }
}

export async function handleBitrixTaskUpdated(taskId: number): Promise<void> {
  if (echoGuard.isArmed(`bitrix-task-update:${taskId}`)) {
    logger.debug({ taskId }, 'echo guard ativo, ignorando task.update (originado do GLPI)');
    return;
  }
  const link = linkRepo.findByBitrixTask(taskId);
  if (!link) {
    logger.info({ taskId }, 'task Bitrix sem vinculo GLPI, ignorando update');
    return;
  }
  const task = await bitrixClient.getTask(taskId);
  const statusNum = Number(task.status);
  const glpiStatus = mapBitrixStatusToGlpi(statusNum);

  if (glpiStatus !== undefined) {
    await glpiClient.updateTicket(link.glpi_ticket_id, { status: glpiStatus });
    logger.info(
      { taskId, glpiTicketId: link.glpi_ticket_id, glpiStatus },
      'status Bitrix->GLPI atualizado'
    );
  }

  // se a tarefa foi marcada como concluída, registra uma solução no GLPI
  if (statusNum === BITRIX_TASK_STATUS.COMPLETED) {
    const glpiUserId = task.responsibleId ? userRepo.bitrixToGlpi(Number(task.responsibleId)) : undefined;
    try {
      await glpiClient.solveTicket(
        link.glpi_ticket_id,
        `[Bitrix] Tarefa #${taskId} marcada como concluída.`,
        glpiUserId
      );
    } catch (e) {
      logger.warn(
        { err: (e as Error).message },
        'falha ao criar ITILSolution (talvez ja exista)'
      );
    }
  }
}

export async function handleBitrixTaskCommentAdded(taskId: number, commentId: number): Promise<void> {
  if (echoGuard.isArmed(`bitrix-comment-add:${taskId}:${commentId}`)) {
    logger.debug({ taskId, commentId }, 'echo guard ativo, ignorando comment.add (originado do GLPI)');
    return;
  }
  const link = linkRepo.findByBitrixTask(taskId);
  if (!link) {
    logger.info({ taskId }, 'task Bitrix sem vinculo GLPI, ignorando comentario');
    return;
  }

  const comments = await bitrixClient.listComments(taskId);
  const c = comments.find((cm) => Number(cm.ID) === commentId);
  if (!c) {
    logger.warn({ taskId, commentId }, 'comentario nao encontrado na listagem');
    return;
  }

  const glpiUserId = userRepo.bitrixToGlpi(Number(c.AUTHOR_ID));
  const content = `[Bitrix] ${c.POST_MESSAGE}`;
  const followupId = await glpiClient.addFollowup(link.glpi_ticket_id, content, false, glpiUserId);
  logger.info(
    { taskId, commentId, glpiTicketId: link.glpi_ticket_id, followupId },
    'comment->followup criado'
  );
}
