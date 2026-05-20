import { config } from '../config';
import { logger } from '../logger';
import { glpiClient, GlpiClient } from '../clients/glpiClient';
import { bitrixClient, BITRIX_TASK_STATUS } from '../clients/bitrixClient';
import { linkRepo, userRepo, echoGuard } from '../db';
import { normalizeCnpj, isValidCnpjLength } from '../util/cnpj';

/**
 * Erro de negócio: tarefa Bitrix não tem CNPJ válido ou não há Grupo correspondente
 * no GLPI. Quando isso acontece, NÃO criamos chamado e retornamos 422.
 */
export class BitrixCnpjMatchError extends Error {
  readonly code = 'BITRIX_CNPJ_NOT_MATCHED';
  constructor(message: string, public readonly details: Record<string, unknown> = {}) {
    super(message);
  }
}

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

/**
 * Extrai o ID da Company vinculada à tarefa via UF_CRM_TASK.
 * Formato: ["CO_42", "C_7", ...] -> retorna 42.
 */
function extractCompanyIdFromTask(task: Record<string, unknown>): number | null {
  // Bitrix retorna como ufCrmTask (camelCase) ou UF_CRM_TASK (snake) dependendo do select
  const raw =
    (task.ufCrmTask as unknown) ??
    (task.UF_CRM_TASK as unknown) ??
    (task['uf_crm_task'] as unknown);
  if (!Array.isArray(raw)) return null;
  for (const item of raw) {
    const s = String(item);
    if (s.startsWith('CO_')) {
      const id = Number(s.slice(3));
      if (Number.isFinite(id) && id > 0) return id;
    }
  }
  return null;
}

/**
 * Handler principal: tarefa nova no Bitrix -> chamado no GLPI.
 *
 * Filtro: SÓ cria chamado se a tarefa tem Company vinculada (UF_CRM_TASK)
 *         e o CNPJ dessa Company existe em algum Group do GLPI.
 *
 * Se não tem Company: ignora silenciosamente (tarefa interna, não é cliente).
 * Se tem Company mas CNPJ não bate: lança BitrixCnpjMatchError -> 422.
 */
export async function handleBitrixTaskAdded(taskId: number): Promise<void> {
  // Verifica echo-guard: se a tarefa foi criada por nós (vindo do GLPI), ignora
  if (echoGuard.isArmed(`bitrix-task-add:${taskId}`)) {
    logger.info(`🔁 Task Bitrix #${taskId} criada pelo proprio integrador, ignorando echo`);
    return;
  }

  // Verifica se já está vinculada (idempotência)
  const existing = linkRepo.findByBitrixTask(taskId);
  if (existing) {
    logger.info(`🔁 Task Bitrix #${taskId} ja vinculada ao Ticket GLPI #${existing.glpi_ticket_id}`);
    return;
  }

  // Importante: o Bitrix retorna campos em camelCase no response (ufCrmTask, tags).
  // Sem select, UF_CRM_TASK e tags NÃO vêm por padrão — precisam estar listados.
  const task = await bitrixClient.getTask(taskId, [
    'ID',
    'TITLE',
    'DESCRIPTION',
    'CREATED_BY',
    'RESPONSIBLE_ID',
    'STATUS',
    'TAGS',
    'UF_CRM_TASK'
  ]);

  if (!task) {
    logger.warn(`📭 Task Bitrix #${taskId} retornou null no getTask — ignorando`);
    return;
  }

  // Tag-check anti-loop: tarefa criada a partir do GLPI tem tag "glpi"
  // task.tags pode vir como object { "id": { title }, ... }, array de strings, ou undefined
  const rawTags = (task.tags ?? (task as { TAGS?: unknown }).TAGS) as unknown;
  const tagTitles: string[] = [];
  if (Array.isArray(rawTags)) {
    for (const t of rawTags) {
      if (typeof t === 'string') tagTitles.push(t);
      else if (t && typeof t === 'object' && 'title' in t) tagTitles.push(String((t as { title: unknown }).title));
    }
  } else if (rawTags && typeof rawTags === 'object') {
    for (const v of Object.values(rawTags as Record<string, unknown>)) {
      if (typeof v === 'string') tagTitles.push(v);
      else if (v && typeof v === 'object' && 'title' in v) tagTitles.push(String((v as { title: unknown }).title));
    }
  }
  if (tagTitles.includes('glpi')) {
    logger.info(`🔁 Task Bitrix #${taskId} tem tag "glpi", origem do GLPI - ignorando`);
    return;
  }

  // Extrai Company ID da tarefa
  const companyId = extractCompanyIdFromTask(task);
  if (!companyId) {
    logger.info(`⏭️  Task Bitrix #${taskId} sem Company vinculada (UF_CRM_TASK) - tarefa interna, ignorando`);
    return;
  }

  // Lê a Company para extrair o CNPJ
  const company = await bitrixClient.getCompany(companyId, [
    'ID',
    'TITLE',
    config.BITRIX_CNPJ_FIELD
  ]);
  const rawCnpj = company[config.BITRIX_CNPJ_FIELD];
  const cnpj = normalizeCnpj(rawCnpj);
  if (!isValidCnpjLength(cnpj)) {
    throw new BitrixCnpjMatchError(
      `Company Bitrix #${companyId} "${company.TITLE}" não tem CNPJ válido (${config.BITRIX_CNPJ_FIELD}="${String(rawCnpj ?? '')}")`,
      { taskId, companyId, companyTitle: company.TITLE, rawCnpj }
    );
  }

  // Procura o Group GLPI com o CNPJ
  const group = await glpiClient.findGroupByCode(cnpj);
  if (!group) {
    throw new BitrixCnpjMatchError(
      `Nenhum Group GLPI encontrado com code=${cnpj} (Company "${company.TITLE}")`,
      { taskId, companyId, cnpj }
    );
  }

  // Tudo certo, cria o chamado no GLPI
  const title = String(task.title ?? '(sem título)').slice(0, 250);
  const description = [
    `[Bitrix Task #${taskId}] — ${company.TITLE}`,
    '',
    String(task.description ?? '(sem descrição)').replace(/<[^>]+>/g, '').trim(),
    '',
    `🔗 Bitrix: https://uctech.bitrix24.com.br/company/personal/user/${task.createdBy ?? config.BITRIX_DEFAULT_CREATOR_ID}/tasks/task/view/${taskId}/`
  ].join('\n');

  // Resolve o atendente: tenta mapeamento estatico no SQLite primeiro; senao busca por email
  let requesterGlpiUserId: number | undefined;
  if (task.createdBy) {
    const bitrixUserId = Number(task.createdBy);
    requesterGlpiUserId = userRepo.bitrixToGlpi(bitrixUserId);
    if (!requesterGlpiUserId) {
      try {
        const email = await bitrixClient.getUserEmail(bitrixUserId);
        if (email) {
          const glpiUser = await glpiClient.findUserByEmail(email);
          if (glpiUser) {
            requesterGlpiUserId = glpiUser.id;
            // Aprende para próximas vezes
            userRepo.upsert(glpiUser.id, bitrixUserId, email, 'auto-link via email');
            logger.info(`🔗 Mapeamento aprendido: Bitrix #${bitrixUserId} (${email}) <-> GLPI #${glpiUser.id}`);
          } else {
            logger.warn(`⚠️  Email "${email}" do user Bitrix #${bitrixUserId} nao achou correspondente no GLPI`);
          }
        }
      } catch (e) {
        logger.warn(`⚠️  Falha buscando user GLPI por email: ${(e as Error).message}`);
      }
    }
  }

  const ticketId = await glpiClient.createTicket({
    name: title,
    content: description,
    groupId: group.id,
    entitiesId: group.entities_id, // <-- entidade INFERIDA do grupo
    requesterUserId: requesterGlpiUserId
  });

  linkRepo.upsert(ticketId, taskId);
  // Echo-guard: quando o GLPI dispara o webhook ticket.add por causa desta criação,
  // queremos ignorar (senão criamos uma task duplicada no Bitrix)
  echoGuard.arm(`glpi-ticket-add:${ticketId}`, 30_000);

  logger.info(
    `✅ Task Bitrix #${taskId} (${company.TITLE}) -> Ticket GLPI #${ticketId} criado no grupo "${group.name}" (entidade ${group.entities_id})`
  );
}

/**
 * Handler de atualização de tarefa (mudança de status etc.)
 * Mantém a tarefa Bitrix sincronizada com seu Ticket GLPI vinculado.
 */
export async function handleBitrixTaskUpdated(taskId: number): Promise<void> {
  if (echoGuard.isArmed(`bitrix-task-update:${taskId}`)) {
    logger.debug(`🔁 Task #${taskId} echo-guard ativo, ignorando update do echo`);
    return;
  }
  const link = linkRepo.findByBitrixTask(taskId);
  if (!link) {
    // Sem vínculo prévio -> trata como criação (pode ter sido criada antes do integrador estar online)
    logger.info(`🔍 Task Bitrix #${taskId} sem vínculo, tentando criar agora como nova`);
    await handleBitrixTaskAdded(taskId);
    return;
  }
  const task = await bitrixClient.getTask(taskId, ['ID', 'STATUS', 'RESPONSIBLE_ID']);
  if (!task) {
    logger.warn(`📭 Task Bitrix #${taskId} não encontrada — ignorando update`);
    return;
  }
  const statusNum = Number(task.status);
  const glpiStatus = mapBitrixStatusToGlpi(statusNum);

  if (glpiStatus !== undefined) {
    await glpiClient.updateTicket(link.glpi_ticket_id, { status: glpiStatus });
    logger.info(
      `♻️  Task Bitrix #${taskId} -> Ticket GLPI #${link.glpi_ticket_id} status atualizado`
    );
  }

  if (statusNum === BITRIX_TASK_STATUS.COMPLETED) {
    const glpiUserId = task.responsibleId ? userRepo.bitrixToGlpi(Number(task.responsibleId)) : undefined;
    try {
      await glpiClient.solveTicket(
        link.glpi_ticket_id,
        `[Bitrix] Tarefa #${taskId} marcada como concluída.`,
        glpiUserId
      );
    } catch (e) {
      logger.warn(`⚠️  Falha criando ITILSolution: ${(e as Error).message}`);
    }
  }
}

/**
 * Handler de comentário Bitrix -> followup GLPI.
 */
export async function handleBitrixTaskCommentAdded(taskId: number, commentId: number): Promise<void> {
  if (echoGuard.isArmed(`bitrix-comment-add:${taskId}:${commentId}`)) {
    logger.debug(`🔁 Comment #${commentId} echo-guard ativo, ignorando`);
    return;
  }
  const link = linkRepo.findByBitrixTask(taskId);
  if (!link) {
    logger.info(`⏭️  Task Bitrix #${taskId} sem vínculo GLPI - comentário ignorado`);
    return;
  }
  const comments = await bitrixClient.listComments(taskId);
  const c = comments.find((cm) => Number(cm.ID) === commentId);
  if (!c) {
    logger.warn(`📭 Comentário #${commentId} não encontrado na task #${taskId}`);
    return;
  }
  const glpiUserId = userRepo.bitrixToGlpi(Number(c.AUTHOR_ID));
  const content = `[Bitrix] ${c.POST_MESSAGE}`;
  const followupId = await glpiClient.addFollowup(link.glpi_ticket_id, content, false, glpiUserId);
  logger.info(
    `💬 Comment Bitrix #${commentId} -> Followup GLPI #${followupId} no ticket #${link.glpi_ticket_id}`
  );
}
