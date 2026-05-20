/**
 * Encontra um ticket REAL no GLPI pertencente ao grupo informado.
 * Útil para testar o webhook simulado com um ticket que existe — caso contrario
 * o integrador faz getTicket() e recebe 404 do GLPI.
 *
 * Roda: npx tsx scripts/find-real-ticket-by-group.ts [groupId]
 */
import axios from 'axios';

const BASE = 'https://suporte.uctechnology.com.br';
const APP_TOKEN = 'hBqDqjf8zybbgmh8NOEC25qEeZBk7fW2mwZel63g';
const USER_TOKEN = 'ahR0QXdTYi8ZMzkd47auJwNDqheurKukFehgu7cB';
const groupId = process.argv[2] ?? '212';

const http = axios.create({
  baseURL: `${BASE}/apirest.php`,
  timeout: 15_000,
  validateStatus: () => true
});

async function main() {
  const init = await http.get('/initSession', {
    headers: { Authorization: `user_token ${USER_TOKEN}`, 'App-Token': APP_TOKEN }
  });
  if (init.status !== 200) {
    console.error('initSession falhou:', init.status, init.data);
    return;
  }
  const sessionToken = init.data.session_token;
  const headers = {
    'App-Token': APP_TOKEN,
    'Session-Token': sessionToken,
    'Content-Type': 'application/json'
  };

  console.log(`🔍 Listando os 10 últimos tickets do GLPI (qualquer grupo)...`);

  // Lista os tickets mais recentes (sem filtro de grupo - vamos olhar manualmente)
  const search = await http.get('/Ticket', {
    headers,
    params: { range: '0-9', 'order': 'DESC' }
  });

  let data: Array<Record<string, unknown>> = [];
  if (Array.isArray(search.data)) data = search.data;
  else if (Array.isArray(search.data?.data)) data = search.data.data;

  console.log(`HTTP ${search.status} - resposta:`, JSON.stringify(search.data).slice(0, 300));
  console.log(`${data.length} tickets retornados:`);
  for (const row of data.slice(0, 10)) {
    const id = row.id;
    const name = row.name ?? '?';
    const status = row.status ?? '?';
    console.log(`  #${id} — status=${status} — ${String(name).slice(0, 70)}`);
  }

  // Para cada ticket, vamos olhar quem é o grupo requester
  console.log(`\n🔬 Analisando grupos de cada ticket...`);
  for (const row of data.slice(0, 10)) {
    const ticketId = row.id;
    const groups = await http.get(`/Ticket/${ticketId}/Group_Ticket`, { headers });
    const ticketGroups = Array.isArray(groups.data)
      ? (groups.data as Array<{ groups_id: number; type: number }>)
      : [];
    const requesterGroups = ticketGroups.filter((g) => g.type === 1);
    if (requesterGroups.length > 0) {
      for (const g of requesterGroups) {
        const grp = await http.get(`/Group/${g.groups_id}`, { headers });
        const code = grp.data?.code ?? '(sem code)';
        const gname = grp.data?.name ?? '?';
        const cnpj = String(code).replace(/\D+/g, '');
        const validCnpj = cnpj.length === 14 ? '✅' : '❌';
        console.log(
          `  Ticket #${ticketId} -> grupo "${gname}" (id=${g.groups_id}) code="${code}" cnpj=${cnpj} ${validCnpj}`
        );
      }
    } else {
      console.log(`  Ticket #${ticketId} — sem grupo requester`);
    }
  }

  await http.get('/killSession', { headers });
}

main().catch((e) => {
  console.error('Erro:', (e as Error).message);
  process.exit(1);
});
