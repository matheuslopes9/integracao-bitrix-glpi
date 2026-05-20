/**
 * Busca tarefas recentes no Bitrix com tag "glpi" pra ver se foram criadas.
 * Roda: npx tsx scripts/find-bitrix-tasks.ts
 */
import axios from 'axios';

const BASE = 'https://uctech.bitrix24.com.br/rest/11013/sv73jkzl96pns8g5/';

const http = axios.create({ baseURL: BASE, timeout: 15_000, validateStatus: () => true });
async function call(method: string, params: Record<string, unknown> = {}) {
  const res = await http.post(`${method}.json`, params);
  return res.data;
}

async function main() {
  console.log('=== Tarefas recentes com tag "glpi" (qualquer responsavel) ===\n');
  const result = await call('tasks.task.list', {
    filter: { TAG: 'glpi' },
    select: ['ID', 'TITLE', 'RESPONSIBLE_ID', 'CREATED_BY', 'CREATED_DATE', 'STATUS', 'TAGS', 'UF_CRM_TASK'],
    order: { ID: 'DESC' },
    start: 0
  });

  if (result.error) {
    console.error('Erro:', result.error, result.error_description);
    return;
  }

  const tasks = (result.result?.tasks ?? []) as Array<Record<string, unknown>>;
  console.log(`Encontradas ${tasks.length} tarefas\n`);
  for (const t of tasks.slice(0, 10)) {
    console.log(`  #${t.id} | ${t.title}`);
    console.log(`    Criado em: ${t.createdDate}`);
    console.log(`    Responsavel: ${t.responsibleId}`);
    console.log(`    Status: ${t.status}`);
    console.log(`    Tags: ${JSON.stringify(t.tags)}`);
    console.log(`    UF_CRM_TASK: ${JSON.stringify(t.ufCrmTask)}`);
    console.log('');
  }

  // Tambem busca pelo titulo
  console.log('\n=== Tarefas com [GLPI no titulo (qualquer responsavel) ===\n');
  const byTitle = await call('tasks.task.list', {
    filter: { '%TITLE': '[GLPI #' },
    select: ['ID', 'TITLE', 'RESPONSIBLE_ID', 'CREATED_DATE'],
    order: { ID: 'DESC' },
    start: 0
  });
  const t2 = (byTitle.result?.tasks ?? []) as Array<Record<string, unknown>>;
  console.log(`Encontradas ${t2.length} tarefas`);
  for (const t of t2.slice(0, 10)) {
    console.log(`  #${t.id} | ${t.title} | resp=${t.responsibleId} | created=${t.createdDate}`);
  }
}
main().catch((e) => {
  console.error('Erro:', (e as Error).message);
  process.exit(1);
});
