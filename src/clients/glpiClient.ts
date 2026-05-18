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
