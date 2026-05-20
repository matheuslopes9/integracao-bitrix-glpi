import { config } from '../config';
import { logger } from '../logger';
import { glpiClient, GlpiClient } from '../clients/glpiClient';
import { bitrixClient, BITRIX_TASK_STATUS } from '../clients/bitrixClient';
import { linkRepo, userRepo, echoGuard, followupRepo } from '../db';
import { normalizeCnpj, isValidCnpjLength } from '../util/cnpj';

/**
 * Erro de negócio: chamado GLPI não tem CNPJ válido ou não há Company correspondente
 * no Bitrix. Conforme decidido com o usuário, nesses casos NÃO criamos tarefa.
 */
export class CnpjMatchError extends Error {
  readonly code = 'CNPJ_NOT_MATCHED';
  constructor(message: string, public readonly details: Record<string, unknown> = {}) {
    super(message);
  }
}

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
  logger.warn(`👤 GLPI user #${glpiUserId} sem mapeamento Bitrix — usando default #${config.BITRIX_DEFAULT_RESPONSIBLE_ID}`);
  return config.BITRIX_DEFAULT_RESPONSIBLE_ID;
}

/**
 * Encontra a Company do Bitrix correspondente ao ticket GLPI, cruzando por CNPJ.
 *
 * Fluxo:
 *   1. Lista os grupos do ticket (tipo "requester" = cliente).
 *   2. Para cada grupo, lê o campo `code` (CNPJ).
 *   3. Normaliza o CNPJ e procura a Company correspondente no Bitrix.
 *   4. Retorna a primeira que casar.
 *
 * Lança CnpjMatchError se:
 *   - O ticket não tem grupo cliente,
 *   - O grupo não tem CNPJ válido no campo `code`,
 *   - Não existe Company no Bitrix com esse CNPJ.
 */
async function resolveBitrixCompany(
  glpiTicketId: number
): Promise<{ id: number; title: string; cnpj: string; glpiGroupId: number }> {
  const groups = await glpiClient.listTicketGroups(glpiTicketId, 'requester');
  if (groups.length === 0) {
    throw new CnpjMatchError(`Ticket #${glpiTicketId} não tem grupo cliente (requester) vinculado`, {
      ticketId: glpiTicketId
    });
  }

  // Pode ter mais de um grupo; tentamos cada um até achar match
  const tried: Array<{ groupId: number; groupName: string; cnpj: string; matched: boolean }> = [];
  for (const g of groups) {
    let groupData: { id: number; name: string; code?: string };
    try {
      groupData = await glpiClient.getGroup(g.groups_id);
    } catch (e) {
      logger.warn(`📭 Falha ao ler grupo GLPI #${g.groups_id}: ${(e as Error).message}`);
      continue;
    }
    const cnpj = normalizeCnpj(groupData.code);
    tried.push({ groupId: groupData.id, groupName: groupData.name, cnpj, matched: false });

    if (!isValidCnpjLength(cnpj)) {
      logger.warn(`📭 Grupo GLPI #${groupData.id} "${groupData.name}" sem CNPJ válido (code="${groupData.code ?? ''}")`);
      continue;
    }
    const company = await bitrixClient.findCompanyByCnpj(cnpj, config.BITRIX_CNPJ_FIELD);
    if (company) {
      tried[tried.length - 1].matched = true;
      return {
        id: Number(company.ID),
        title: company.TITLE,
        cnpj,
        glpiGroupId: groupData.id
      };
    }
  }

  throw new CnpjMatchError(
    `Nenhuma Company Bitrix encontrada para o(s) CNPJ(s) do ticket #${glpiTicketId}`,
    { ticketId: glpiTicketId, tried }
  );
}

export async function handleGlpiTicketCreated(ticketId: number): Promise<void> {
  if (linkRepo.findByGlpiTicket(ticketId)) {
    logger.info(`🔁 Ticket #${ticketId} já vinculado, ignorando duplicata`);
    return;
  }

  const ticket = await glpiClient.getTicket(ticketId);
  const company = await resolveBitrixCompany(ticketId);
  const responsibleId = await resolveResponsibleId(ticketId);

  const description = [
    `[GLPI #${ticket.id}] — ${company.title} (CNPJ ${company.cnpj})`,
    '',
    ticket.content?.replace(/<[^>]+>/g, '').trim() ?? '(sem descrição)',
    '',
    `🔗 GLPI: ${config.GLPI_BASE_URL}/front/ticket.form.php?id=${ticket.id}`
  ].join('\n');

  const created = await bitrixClient.createTask({
    TITLE: `[GLPI #${ticket.id}] ${ticket.name}`,
    DESCRIPTION: description,
    RESPONSIBLE_ID: responsibleId,
    CREATED_BY: config.BITRIX_DEFAULT_CREATOR_ID,
    GROUP_ID: config.BITRIX_DEFAULT_GROUP_ID,
    STATUS: mapGlpiStatusToBitrix(ticket.status),
    TAGS: ['glpi', `glpi-${ticket.id}`, `cnpj-${company.cnpj}`],
    // Vincula a tarefa Bitrix à Company do CRM — assim aparece na tela da empresa
    // e podemos consultá-la depois via crm.activity.list
    // Bitrix usa formato ["CO_<id>"] = Company, ["C_<id>"] = Contact, ["L_<id>"] = Lead, ["D_<id>"] = Deal
    UF_CRM_TASK: [`CO_${company.id}`]
  } as Parameters<typeof bitrixClient.createTask>[0]);

  linkRepo.upsert(ticketId, created.id);
  echoGuard.arm(`bitrix-task-add:${created.id}`, 15_000);

  logger.info(
    `✅ Ticket #${ticketId} (${company.title}) -> tarefa Bitrix #${created.id} criada`
  );
}

export async function handleGlpiTicketUpdated(ticketId: number): Promise<void> {
  const link = linkRepo.findByGlpiTicket(ticketId);
  if (!link) {
    logger.info(`🔍 Ticket #${ticketId} sem vínculo, tentando criar agora`);
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

  if (ticket.status === GlpiClient.STATUS.SOLVED || ticket.status === GlpiClient.STATUS.CLOSED) {
    try {
      await bitrixClient.completeTask(link.bitrix_task_id);
    } catch (e) {
      logger.warn(`⚠️  completeTask falhou (talvez já completa): ${(e as Error).message}`);
    }
  }

  logger.info(`♻️  Ticket #${ticketId} -> tarefa Bitrix #${link.bitrix_task_id} atualizada`);
}

export async function handleGlpiFollowupAdded(args: {
  followupId: number;
  ticketId: number;
  content: string;
  glpiUserId?: number;
}): Promise<void> {
  if (followupRepo.alreadyHandled(args.followupId, 'glpi->bitrix')) {
    logger.info(`🔁 Followup #${args.followupId} já processado, ignorando`);
    return;
  }
  let link = linkRepo.findByGlpiTicket(args.ticketId);
  if (!link) {
    await handleGlpiTicketCreated(args.ticketId);
    link = linkRepo.findByGlpiTicket(args.ticketId);
  }
  if (!link) {
    throw new Error(`Não foi possível criar/encontrar vínculo para ticket #${args.ticketId}`);
  }

  const authorId = args.glpiUserId ? userRepo.glpiToBitrix(args.glpiUserId) : undefined;
  const cleaned = args.content.replace(/<[^>]+>/g, '').trim();
  const message = authorId ? cleaned : `[GLPI] ${cleaned}`;

  const commentId = await bitrixClient.addComment(link.bitrix_task_id, message, authorId);
  followupRepo.mark(args.followupId, args.ticketId, 'glpi->bitrix', commentId);
  echoGuard.arm(`bitrix-comment-add:${link.bitrix_task_id}:${commentId}`, 15_000);
  logger.info(
    `💬 Followup #${args.followupId} -> comentário Bitrix #${commentId} na tarefa #${link.bitrix_task_id}`
  );
}
