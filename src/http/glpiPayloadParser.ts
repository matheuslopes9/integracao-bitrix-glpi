import { logger } from '../logger';

/**
 * Eventos que o GLPI 11 emite em itemtype=Ticket / ITILFollowup.
 * As strings podem variar conforme o idioma do GLPI ("new", "novo", "add", "update").
 */
export type GlpiNormalizedEvent =
  | { kind: 'ticket.add'; ticketId: number }
  | { kind: 'ticket.update'; ticketId: number }
  | { kind: 'followup.add'; ticketId: number; followupId: number; content: string; usersId?: number }
  | { kind: 'unknown'; reason: string };

interface GlpiNestedPayload {
  event?: string;
  itemtype?: string;
  item?: {
    id?: string | number;
    name?: string;
    content?: string;
    is_deleted?: string | number;
    status?: { id?: string | number; name?: string } | string | number;
    users_id?: string | number;
    users_id_recipient?: string | number;
    tickets_id?: string | number;
    items_id?: string | number;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

interface GlpiFlatPayload {
  event?: string;
  itemtype?: string;
  item_type?: string;
  items_id?: string | number;
  id?: string | number;
  ticket_id?: string | number;
  items_id_ticket?: string | number;
  content?: string;
  status?: string | number;
  users_id?: string | number;
  [k: string]: unknown;
}

function toNum(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function classifyEvent(raw: string | undefined): 'add' | 'update' | 'delete' | 'other' {
  if (!raw) return 'other';
  const s = raw.toLowerCase();
  if (s.includes('add') || s.includes('new') || s.includes('novo') || s.includes('create') || s.includes('criar')) {
    return 'add';
  }
  if (s.includes('update') || s.includes('edit') || s.includes('atualiz') || s.includes('modific')) {
    return 'update';
  }
  if (s.includes('delete') || s.includes('purge') || s.includes('exclu')) return 'delete';
  return 'other';
}

function classifyItemtype(raw: string | undefined): 'ticket' | 'followup' | 'other' {
  if (!raw) return 'other';
  const s = raw.toLowerCase();
  if (s === 'ticket') return 'ticket';
  if (s === 'itilfollowup' || s === 'ticketfollowup' || s.endsWith('followup')) return 'followup';
  return 'other';
}

/**
 * Quando o GLPI 11 não envia o campo "itemtype" no body (cada webhook é dedicado a um itemtype,
 * então a info é redundante), inferimos pelo formato do payload.
 *
 * Heurísticas:
 *  - presença de `item.team`, `item.priority`, `item.urgency` → Ticket
 *  - presença de `item.tickets_id` ou `item.itemtype === 'Ticket'` (de dentro do item) → Followup
 */
function inferItemtype(body: GlpiNestedPayload): 'ticket' | 'followup' | 'other' {
  const item = body.item;
  if (!item || typeof item !== 'object') return 'other';

  const hasTicketFields =
    'team' in item || 'priority' in item || 'urgency' in item || 'impact' in item || 'request_type' in item;
  const hasFollowupFields =
    'tickets_id' in item ||
    (typeof (item as { itemtype?: unknown }).itemtype === 'string' &&
      String((item as { itemtype?: unknown }).itemtype).toLowerCase() === 'ticket');

  if (hasFollowupFields && !hasTicketFields) return 'followup';
  if (hasTicketFields) return 'ticket';
  return 'other';
}

/**
 * Recebe o payload bruto do webhook GLPI (em formato GLPI 10 flat ou GLPI 11 aninhado)
 * e devolve um evento normalizado pronto para os handlers.
 */
export function parseGlpiPayload(body: unknown): GlpiNormalizedEvent {
  if (!body || typeof body !== 'object') {
    return { kind: 'unknown', reason: 'payload vazio ou não é objeto' };
  }
  const b = body as GlpiNestedPayload & GlpiFlatPayload;

  // GLPI 11 não inclui "itemtype" no payload (cada webhook é dedicado a um tipo).
  // Tentamos primeiro pelo campo explícito (GLPI 10) e depois inferimos pela forma do item.
  let itemtype = classifyItemtype(b.itemtype ?? b.item_type);
  if (itemtype === 'other') {
    itemtype = inferItemtype(b);
  }
  const eventClass = classifyEvent(b.event);

  // ---------- Ticket ----------
  if (itemtype === 'ticket') {
    const ticketId =
      toNum(b.item?.id) ?? toNum(b.items_id) ?? toNum(b.id) ?? toNum(b.item?.items_id);
    if (!ticketId) {
      return { kind: 'unknown', reason: 'ticket sem id no payload' };
    }
    if (eventClass === 'add') return { kind: 'ticket.add', ticketId };
    if (eventClass === 'update') return { kind: 'ticket.update', ticketId };
    if (eventClass === 'delete') {
      // tratamos como update — handler vai buscar o estado atual do GLPI
      return { kind: 'ticket.update', ticketId };
    }
    return { kind: 'unknown', reason: `evento Ticket nao mapeado: ${b.event}` };
  }

  // ---------- ITILFollowup ----------
  if (itemtype === 'followup') {
    // o ticket pai pode aparecer como tickets_id, items_id (com itemtype=Ticket impl.) ou em campo dedicado
    const ticketId =
      toNum(b.ticket_id) ??
      toNum(b.items_id_ticket) ??
      toNum(b.item?.tickets_id) ??
      toNum(b.item?.items_id) ??
      toNum((b.item as { ticket?: { id?: unknown } } | undefined)?.ticket?.id);
    const followupId = toNum(b.item?.id) ?? toNum(b.items_id) ?? toNum(b.id);
    const content = String(b.item?.content ?? b.content ?? '');
    const usersId = toNum(b.item?.users_id) ?? toNum(b.users_id);

    if (!ticketId || !followupId) {
      return { kind: 'unknown', reason: 'followup sem ticket_id ou followup_id' };
    }
    if (eventClass !== 'add') {
      return { kind: 'unknown', reason: `evento Followup nao mapeado: ${b.event}` };
    }
    return { kind: 'followup.add', ticketId, followupId, content, usersId };
  }

  // ---------- desconhecido ----------
  logger.warn({ itemtype: b.itemtype, event: b.event }, 'payload GLPI nao reconhecido');
  return { kind: 'unknown', reason: `itemtype nao suportado: ${b.itemtype}` };
}
