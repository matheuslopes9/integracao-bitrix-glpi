/**
 * Dispara um POST assinado (HMAC-SHA256 igual ao GLPI 11) contra o integrador
 * em produção. Usa um payload realista de chamado, com team[] contendo grupo
 * cliente (AB BRASIL id=212 / KARCHER id=261 / ZAION id=429).
 *
 * Roda: npx tsx scripts/simulate-glpi-webhook.ts [ticketId] [groupId] [groupName]
 *   ex: npx tsx scripts/simulate-glpi-webhook.ts 9999999 212 "AB BRASIL"
 */
import crypto from 'node:crypto';
import axios from 'axios';

const TARGET_URL = 'https://integrabitrixglpi.uctechnology.com.br/webhooks/glpi';
const SECRET = '1yPjXjYr68wdBYfvJ88tbcSaDNPyKj8BNvlTxbUx'; // mesmo do GLPI

const [, , ticketIdArg, groupIdArg, groupNameArg] = process.argv;
const ticketId = ticketIdArg ?? String(Date.now()); // sempre novo p/ evitar dedupe
const groupId = groupIdArg ?? '212';
const groupName = groupNameArg ?? 'AB BRASIL';

const item = {
  id: Number(ticketId),
  name: `[TESTE INTEGRADOR] Chamado simulado ${ticketId}`,
  content:
    '<p>Este é um chamado de teste enviado pelo script simulate-glpi-webhook.ts</p>' +
    '<p>Cliente: ' + groupName + '</p>' +
    '<p>Pode deletar à vontade depois.</p>',
  is_deleted: false,
  urgency: 3,
  impact: 3,
  priority: 3,
  actiontime: 0,
  date_creation: new Date().toISOString(),
  date_mod: new Date().toISOString(),
  date: new Date().toISOString(),
  type: 2,
  external_id: '',
  status: { id: 1, name: 'Novo' },
  category: { id: 21, name: 'Telefonia' },
  location: null,
  request_type: { id: 1, name: 'Helpdesk' },
  entity: { id: 0, name: 'UC Technology Raiz', completename: 'UC Technology Raiz' },
  team: [
    {
      role: 'requester',
      name: 'teste@exemplo.com',
      realname: 'Teste',
      firstname: 'User',
      display_name: 'User Teste',
      href: '/front/user.form.php?id=999'
    },
    {
      role: 'requester',
      name: groupName,
      realname: null,
      firstname: null,
      display_name: groupName,
      href: `/front/group.form.php?id=${groupId}`
    }
  ]
};
const payload = { event: 'new', item };
const body = JSON.stringify(payload);
const timestamp = String(Math.floor(Date.now() / 1000));
const signature = crypto.createHmac('sha256', SECRET).update(body + timestamp).digest('hex');

console.log(`📤 Enviando POST simulado para ${TARGET_URL}`);
console.log(`   Ticket: #${ticketId}`);
console.log(`   Grupo: "${groupName}" (id ${groupId})`);
console.log(`   Timestamp: ${timestamp}`);
console.log(`   Signature: ${signature.slice(0, 20)}...`);
console.log(`   Body: ${body.length} bytes\n`);

axios
  .post(TARGET_URL, body, {
    headers: {
      'Content-Type': 'application/json',
      'X-GLPI-signature': signature,
      'X-GLPI-timestamp': timestamp,
      'User-Agent': 'simulate-glpi-webhook/1.0'
    },
    validateStatus: () => true,
    timeout: 20_000
  })
  .then((res) => {
    console.log(`✅ HTTP ${res.status}`);
    console.log('Resposta:', JSON.stringify(res.data, null, 2));
  })
  .catch((e) => {
    console.error('❌ Erro:', (e as Error).message);
    process.exit(1);
  });
