import axios from 'axios';

const BASE = 'https://uctech.bitrix24.com.br/rest/491/ho8n3gntmllz2fkk/';

const http = axios.create({
  baseURL: BASE,
  timeout: 15_000,
  headers: { 'Content-Type': 'application/json' },
  validateStatus: () => true
});

async function call(method: string, params: Record<string, unknown> = {}) {
  const res = await http.post(`${method}.json`, params);
  return res.data;
}

async function main() {
  console.log('=== 1) user.current — confirmar autenticação ===');
  const me = await call('user.current');
  console.log('Usuário:', me.result?.NAME, me.result?.LAST_NAME, `(ID=${me.result?.ID})`);

  console.log('\n=== 2) Criar tarefa de teste ===');
  const created = await call('tasks.task.add', {
    fields: {
      TITLE: '[TESTE INTEGRADOR] Tarefa criada via API',
      DESCRIPTION:
        'Esta é uma tarefa de teste criada pelo script de validação do integrador GLPI↔Bitrix.\n\n' +
        'Pode deletar à vontade.',
      RESPONSIBLE_ID: 491,
      CREATED_BY: 491,
      PRIORITY: 1,
      TAGS: ['teste-integrador', 'glpi']
    }
  });

  if (created.error) {
    console.error('❌ ERRO:', created.error, created.error_description);
    return;
  }

  const taskId = created.result?.task?.id;
  console.log(`✅ Tarefa #${taskId} criada com sucesso!`);
  console.log('   Título:', created.result?.task?.title);
  console.log('   Responsável:', created.result?.task?.responsibleId);
  console.log('   Status:', created.result?.task?.status);

  console.log('\n=== 3) Adicionar comentário na tarefa ===');
  const comment = await call('task.commentitem.add', {
    TASKID: taskId,
    FIELDS: {
      POST_MESSAGE: '[GLPI] Este comentário simula uma resposta vinda do chamado no GLPI 🎫'
    }
  });
  if (comment.error) {
    console.error('❌ Erro no comentário:', comment.error, comment.error_description);
  } else {
    console.log(`✅ Comentário ID ${comment.result} adicionado.`);
  }

  console.log('\n=== 4) Atualizar a tarefa (mudar título) ===');
  const updated = await call('tasks.task.update', {
    taskId,
    fields: { TITLE: '[TESTE INTEGRADOR] ✏️ Título atualizado' }
  });
  if (updated.error) {
    console.error('❌ Erro no update:', updated.error, updated.error_description);
  } else {
    console.log('✅ Tarefa atualizada.');
  }

  console.log('\n=== 5) Buscar a tarefa para confirmar ===');
  const got = await call('tasks.task.get', { taskId });
  console.log('   Título atual:', got.result?.task?.title);

  console.log('\n🎉 TUDO OK! Você pode ver a tarefa em:');
  console.log(`   https://uctech.bitrix24.com.br/company/personal/user/491/tasks/task/view/${taskId}/`);
}

main().catch((err) => {
  console.error('❌ Erro inesperado:', (err as Error).message);
  process.exit(1);
});
