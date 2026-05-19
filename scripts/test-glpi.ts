import axios from 'axios';

const BASE = 'https://suporte.uctechnology.com.br';
const APP_TOKEN = 'hBqDqjf8zybbgmh8NOEC25qEeZBk7fW2mwZel63g';
const USER_TOKEN = 'ahR0QXdTYi8ZMzkd47auJwNDqheurKukFehgu7cB';

const http = axios.create({
  baseURL: `${BASE}/apirest.php`,
  timeout: 15_000,
  headers: { 'Content-Type': 'application/json' },
  validateStatus: () => true
});

async function main() {
  console.log('=== 1) initSession ===');
  const init = await http.get('/initSession', {
    headers: {
      Authorization: `user_token ${USER_TOKEN}`,
      'App-Token': APP_TOKEN
    }
  });
  if (init.status !== 200) {
    console.error(`❌ HTTP ${init.status}:`, JSON.stringify(init.data));
    return;
  }
  const sessionToken = init.data.session_token as string;
  console.log('✅ session_token:', sessionToken.slice(0, 14) + '…');

  const headers = {
    'App-Token': APP_TOKEN,
    'Session-Token': sessionToken,
    'Content-Type': 'application/json'
  };

  console.log('\n=== 2) getFullSession ===');
  const session = await http.get('/getFullSession', { headers });
  const s = session.data?.session ?? session.data;
  console.log('   Usuário:', s?.glpiname ?? s?.glpifriendlyname);
  console.log('   Perfil ativo:', s?.glpiactiveprofile?.name);
  console.log('   Entidade:', s?.glpiactive_entity_name);

  console.log('\n=== 3) Listar 5 últimos tickets ===');
  const tickets = await http.get('/Ticket', {
    headers,
    params: { range: '0-4', order: 'DESC', sort: 15 }
  });
  if (tickets.status !== 200 && tickets.status !== 206) {
    console.error(`❌ HTTP ${tickets.status}:`, JSON.stringify(tickets.data));
  } else {
    const list = Array.isArray(tickets.data) ? tickets.data : tickets.data?.data ?? [];
    console.log(`   Encontrados ${list.length} tickets:`);
    for (const t of list) {
      const statusLabel: Record<number, string> = {
        1: 'Novo', 2: 'Atribuído', 3: 'Planejado',
        4: 'Pendente', 5: 'Solucionado', 6: 'Fechado'
      };
      console.log(`     #${t.id} — [${statusLabel[t.status] ?? t.status}] ${(t.name ?? '').slice(0, 80)}`);
    }
  }

  console.log('\n=== 4) killSession ===');
  await http.get('/killSession', { headers });
  console.log('✅ Sessão encerrada.');
  console.log('\n🎉 GLPI 100% conectado!');
}

main().catch((e) => {
  console.error('❌ Erro inesperado:', (e as Error).message);
  process.exit(1);
});
