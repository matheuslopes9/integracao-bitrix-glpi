import axios, { AxiosInstance } from 'axios';
import { config } from '../config';
import { logger } from '../logger';

// Bitrix24 task statuses (referência oficial)
export const BITRIX_TASK_STATUS = {
  NEW: 1,
  WAITING_FOR_EXECUTION: 2,
  IN_PROGRESS: 3,
  WAITING_FOR_CONTROL: 4,
  COMPLETED: 5,
  DEFERRED: 6
} as const;
export type BitrixTaskStatus = typeof BITRIX_TASK_STATUS[keyof typeof BITRIX_TASK_STATUS];

export const BITRIX_TASK_PRIORITY = {
  LOW: 0,
  AVERAGE: 1,
  HIGH: 2
} as const;

interface BitrixApiResponse<T> {
  result?: T;
  error?: string;
  error_description?: string;
  time?: { start: number; finish: number; duration: number };
}

export interface BitrixTaskFields {
  TITLE: string;
  RESPONSIBLE_ID: number;
  DESCRIPTION?: string;
  CREATED_BY?: number;
  PRIORITY?: number;
  DEADLINE?: string;
  GROUP_ID?: number;
  STATUS?: number;
  AUDITORS?: number[];
  ACCOMPLICES?: number[];
  TAGS?: string[];
}

export interface BitrixTask {
  id: string;
  title: string;
  description?: string;
  responsibleId?: string;
  status?: string;
  createdBy?: string;
}

export class BitrixClient {
  private http: AxiosInstance;

  constructor() {
    this.http = axios.create({
      baseURL: config.BITRIX_WEBHOOK_URL,
      timeout: 15_000,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  private async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    try {
      const res = await this.http.post<BitrixApiResponse<T>>(`${method}.json`, params);
      if (res.data.error) {
        throw new Error(`[bitrix] ${res.data.error}: ${res.data.error_description ?? ''}`);
      }
      return res.data.result as T;
    } catch (err) {
      logger.error({ method, params, err: (err as Error).message }, 'bitrix api call failed');
      throw err;
    }
  }

  async createTask(fields: BitrixTaskFields): Promise<{ id: number }> {
    const result = await this.call<{ task: { id: string } }>('tasks.task.add', { fields });
    return { id: Number(result.task.id) };
  }

  async updateTask(taskId: number, fields: Partial<BitrixTaskFields>): Promise<void> {
    await this.call('tasks.task.update', { taskId, fields });
  }

  async getTask(taskId: number): Promise<BitrixTask> {
    const res = await this.call<{ task: BitrixTask }>('tasks.task.get', { taskId });
    return res.task;
  }

  async completeTask(taskId: number): Promise<void> {
    // method legado mas ainda funcional - encerra a tarefa
    await this.call('tasks.task.complete', { taskId });
  }

  async deferTask(taskId: number): Promise<void> {
    await this.call('tasks.task.defer', { taskId });
  }

  async renewTask(taskId: number): Promise<void> {
    await this.call('tasks.task.renew', { taskId });
  }

  async addComment(taskId: number, message: string, authorId?: number): Promise<number> {
    // task.commentitem.add expects positional args via "FIELDS" object
    const result = await this.call<number>('task.commentitem.add', {
      TASKID: taskId,
      FIELDS: {
        POST_MESSAGE: message,
        ...(authorId ? { AUTHOR_ID: authorId } : {})
      }
    });
    return Number(result);
  }

  async listComments(taskId: number): Promise<Array<{ ID: string; POST_MESSAGE: string; AUTHOR_ID: string; POST_DATE: string }>> {
    return this.call('task.commentitem.getlist', { TASKID: taskId });
  }

  async getUser(id: number) {
    return this.call('user.get', { ID: id });
  }

  async findUserByEmail(email: string) {
    return this.call<unknown[]>('user.search', { FILTER: { EMAIL: email } });
  }
}

export const bitrixClient = new BitrixClient();
