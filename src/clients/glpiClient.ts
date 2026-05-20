import axios, { AxiosInstance, AxiosError } from 'axios';
import { config } from '../config';
import { logger } from '../logger';

const GLPI_TICKET_STATUS = {
  NEW: 1,
  PROCESSING_ASSIGNED: 2,
  PROCESSING_PLANNED: 3,
  PENDING: 4,
  SOLVED: 5,
  CLOSED: 6
} as const;
export type GlpiTicketStatus = typeof GLPI_TICKET_STATUS[keyof typeof GLPI_TICKET_STATUS];

export interface GlpiTicket {
  id: number;
  name: string;
  content: string;
  status: GlpiTicketStatus;
  users_id_recipient?: number;
  entities_id?: number;
  date?: string;
  date_mod?: string;
}

export interface GlpiUser {
  id: number;
  name?: string;
  firstname?: string;
  realname?: string;
}

export class GlpiClient {
  private http: AxiosInstance;
  private sessionToken: string | null = null;
  private sessionExpiresAt = 0;

  constructor() {
    this.http = axios.create({
      baseURL: `${config.GLPI_BASE_URL}/apirest.php`,
      timeout: 15_000,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  private async ensureSession(): Promise<string> {
    if (this.sessionToken && Date.now() < this.sessionExpiresAt) return this.sessionToken;

    const res = await this.http.get('/initSession', {
      headers: {
        Authorization: `user_token ${config.GLPI_USER_TOKEN}`,
        'App-Token': config.GLPI_APP_TOKEN
      },
      params: { get_full_session: false }
    });
    this.sessionToken = res.data.session_token as string;
    // GLPI session typically lasts 24h, but we refresh every 45min to be safe
    this.sessionExpiresAt = Date.now() + 45 * 60_000;
    logger.info('[glpi] session token refreshed');
    return this.sessionToken;
  }

  private async headers() {
    return {
      'App-Token': config.GLPI_APP_TOKEN,
      'Session-Token': await this.ensureSession(),
      'Content-Type': 'application/json'
    };
  }

  private async request<T>(fn: (h: Record<string, string>) => Promise<T>): Promise<T> {
    try {
      return await fn(await this.headers());
    } catch (err) {
      const ae = err as AxiosError<unknown>;
      const status = ae.response?.status;
      if (status === 401 || status === 400) {
        // token can become invalid; refresh once and retry
        this.sessionToken = null;
        return await fn(await this.headers());
      }
      throw err;
    }
  }

  async getTicket(id: number): Promise<GlpiTicket> {
    return this.request(async (headers) => {
      const res = await this.http.get<GlpiTicket>(`/Ticket/${id}`, { headers });
      return res.data;
    });
  }

  async listTicketUsers(ticketId: number, type: 'requester' | 'assigned' | 'observer' = 'assigned') {
    // 1=requester, 2=assigned, 3=observer
    const typeId = type === 'requester' ? 1 : type === 'assigned' ? 2 : 3;
    return this.request(async (headers) => {
      const res = await this.http.get(`/Ticket/${ticketId}/Ticket_User`, { headers });
      return (res.data as Array<{ users_id: number; type: number }>).filter((r) => r.type === typeId);
    });
  }

  async getUser(id: number): Promise<GlpiUser> {
    return this.request(async (headers) => {
      const res = await this.http.get<GlpiUser>(`/User/${id}`, { headers });
      return res.data;
    });
  }

  /**
   * Procura um usuário do GLPI pelo e-mail (case-insensitive).
   *
   * O GLPI tem duas formas de armazenar email:
   *   - tabela glpi_useremails (1 user pode ter N emails) → endpoint /UserEmail
   *   - campo name = login (que muitas instalações usam = email)
   *
   * Estratégia: primeiro tenta search via UserEmail; se não acha,
   * tenta achar User onde name = email.
   */
  async findUserByEmail(email: string): Promise<{ id: number; name: string } | null> {
    const target = email.trim().toLowerCase();
    if (!target) return null;
    return this.request(async (headers) => {
      // 1) search por UserEmail
      try {
        const res = await this.http.get('/search/UserEmail', {
          headers,
          params: {
            'criteria[0][field]': 2, // email
            'criteria[0][searchtype]': 'equals',
            'criteria[0][value]': target,
            'range': '0-4',
            'forcedisplay[0]': 3 // users_id
          }
        });
        const rows = (res.data?.data ?? []) as Array<Record<string, unknown>>;
        if (rows.length > 0) {
          const userId = Number(rows[0]['3'] ?? rows[0].users_id);
          if (Number.isFinite(userId) && userId > 0) {
            const user = await this.http.get<GlpiUser>(`/User/${userId}`, { headers });
            return { id: userId, name: user.data.name ?? '' };
          }
        }
      } catch {
        /* ignora — tenta fallback */
      }

      // 2) fallback: User.name == email (instalações onde login é email)
      try {
        const res = await this.http.get('/search/User', {
          headers,
          params: {
            'criteria[0][field]': 1, // name
            'criteria[0][searchtype]': 'equals',
            'criteria[0][value]': target,
            'range': '0-4',
            'forcedisplay[0]': 2
          }
        });
        const rows = (res.data?.data ?? []) as Array<Record<string, unknown>>;
        if (rows.length > 0) {
          const userId = Number(rows[0]['2'] ?? rows[0].id);
          if (Number.isFinite(userId) && userId > 0) {
            return { id: userId, name: target };
          }
        }
      } catch {
        /* nada achado */
      }

      return null;
    });
  }

  /**
   * Lê um Group do GLPI. O campo `code` é onde armazenamos o CNPJ do cliente.
   */
  async getGroup(id: number): Promise<{ id: number; name: string; code?: string }> {
    return this.request(async (headers) => {
      const res = await this.http.get<{ id: number; name: string; code?: string }>(
        `/Group/${id}`,
        { headers }
      );
      return res.data;
    });
  }

  /**
   * Lista os grupos vinculados a um ticket (filtrados por tipo).
   * type: 1=requester, 2=assigned, 3=observer
   */
  async listTicketGroups(
    ticketId: number,
    type: 'requester' | 'assigned' | 'observer' = 'requester'
  ): Promise<Array<{ groups_id: number; type: number }>> {
    const typeId = type === 'requester' ? 1 : type === 'assigned' ? 2 : 3;
    return this.request(async (headers) => {
      const res = await this.http.get(`/Ticket/${ticketId}/Group_Ticket`, { headers });
      return (res.data as Array<{ groups_id: number; type: number }>).filter(
        (r) => r.type === typeId
      );
    });
  }

  async addFollowup(ticketId: number, content: string, isPrivate = false, usersId?: number): Promise<number> {
    return this.request(async (headers) => {
      const res = await this.http.post(
        '/ITILFollowup',
        {
          input: {
            items_id: ticketId,
            itemtype: 'Ticket',
            content,
            is_private: isPrivate ? 1 : 0,
            ...(usersId ? { users_id: usersId } : {})
          }
        },
        { headers }
      );
      const data = res.data as { id: number } | Array<{ id: number }>;
      return Array.isArray(data) ? data[0].id : data.id;
    });
  }

  async updateTicket(id: number, input: Record<string, unknown>): Promise<void> {
    await this.request(async (headers) => {
      await this.http.put(`/Ticket/${id}`, { input: { id, ...input } }, { headers });
    });
  }

  /**
   * Procura um Group cujo campo `code` seja igual ao CNPJ (14 dígitos limpos).
   * Lê em páginas e compara normalizado, porque o GLPI pode ter o code com formato
   * variado e o endpoint /search/Group é instável entre versões.
   */
  async findGroupByCode(cnpj: string): Promise<{ id: number; name: string; entities_id: number } | null> {
    if (cnpj.length !== 14) return null;
    return this.request(async (headers) => {
      // GET /Group sem search — paginamos manualmente até achar
      const PAGE = 50;
      for (let offset = 0; offset < 2000; offset += PAGE) {
        const res = await this.http.get<
          Array<{ id: number; name: string; code?: string; entities_id?: number }>
        >('/Group', { headers, params: { range: `${offset}-${offset + PAGE - 1}` } });
        const list = Array.isArray(res.data) ? res.data : [];
        if (list.length === 0) break;
        for (const g of list) {
          const code = String(g.code ?? '').replace(/\D+/g, '');
          if (code === cnpj) {
            return { id: g.id, name: g.name, entities_id: g.entities_id ?? 0 };
          }
        }
        if (list.length < PAGE) break;
      }
      return null;
    });
  }

  /**
   * Cria um Ticket no GLPI vinculado a um grupo cliente (requester).
   * @param input    Campos do Ticket (name, content, status opcionais)
   * @param groupId  ID do grupo "requester" (cliente)
   * @param entitiesId Entidade onde o ticket vai ser criado (do grupo)
   */
  async createTicket(args: {
    name: string;
    content: string;
    groupId: number;
    entitiesId: number;
    requesterUserId?: number;
    priority?: number;
    urgency?: number;
    impact?: number;
  }): Promise<number> {
    return this.request(async (headers) => {
      // 1) cria o ticket
      const createRes = await this.http.post<{ id: number } | Array<{ id: number }>>(
        '/Ticket',
        {
          input: {
            name: args.name,
            content: args.content,
            entities_id: args.entitiesId,
            priority: args.priority ?? 3,
            urgency: args.urgency ?? 3,
            impact: args.impact ?? 3,
            status: GLPI_TICKET_STATUS.NEW
          }
        },
        { headers }
      );
      const ticketId = Array.isArray(createRes.data) ? createRes.data[0].id : createRes.data.id;

      // 2) vincula o grupo como requester (type=1)
      await this.http.post(
        '/Group_Ticket',
        { input: { tickets_id: ticketId, groups_id: args.groupId, type: 1 } },
        { headers }
      );

      // 3) se passar um usuário requester, vincula também
      if (args.requesterUserId) {
        await this.http.post(
          '/Ticket_User',
          {
            input: {
              tickets_id: ticketId,
              users_id: args.requesterUserId,
              type: 1 // requester
            }
          },
          { headers }
        );
      }

      return ticketId;
    });
  }

  async solveTicket(ticketId: number, content: string, usersId?: number): Promise<void> {
    await this.request(async (headers) => {
      await this.http.post(
        '/ITILSolution',
        {
          input: {
            items_id: ticketId,
            itemtype: 'Ticket',
            content,
            ...(usersId ? { users_id: usersId } : {})
          }
        },
        { headers }
      );
    });
  }

  static readonly STATUS = GLPI_TICKET_STATUS;
}

export const glpiClient = new GlpiClient();
