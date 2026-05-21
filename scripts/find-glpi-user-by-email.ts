/**
 * Diagnóstico: testa várias formas de buscar um user GLPI por email.
 * Roda: npx tsx scripts/find-glpi-user-by-email.ts <email>
 */
import axios from 'axios';

const BASE = 'https://suporte.uctechnology.com.br';
const APP_TOKEN = 'hBqDqjf8zybbgmh8NOEC25qEeZBk7fW2mwZel63g';
const USER_TOKEN = 'ahR0QXdTYi8ZMzkd47auJwNDqheurKukFehgu7cB';
const email = process.argv[2] ?? 'matheus.lopes@uctechnology.com.br';

const http = axios.create({
  baseURL: `${BASE}/apirest.php`,
  timeout: 20_000,
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
  const headers = {
    'App-Token': APP_TOKEN,
    'Session-Token': init.data.session_token,
    'Content-Type': 'application/json'
  };

  console.log(`\n🔍 Procurando GLPI user com email "${email}"\n`);

  // 1) listSearchOptions de UserEmail para descobrir qual campo é o email
  console.log('=== 1) Search options para UserEmail ===');
  const opts = await http.get('/listSearchOptions/UserEmail', { headers });
  if (opts.status === 200) {
    for (const [k, v] of Object.entries(opts.data as Record<string, unknown>)) {
      if (typeof v === 'object' && v !== null) {
        const o = v as { name?: string; table?: string; field?: string };
        if (o.name && /email/i.test(String(o.name))) {
          console.log(`  opt ${k}: name="${o.name}" table=${o.table} field=${o.field}`);
        }
      }
    }
  } else {
    console.log('  listSearchOptions UserEmail falhou:', opts.status);
  }

  // 2) Tenta search/UserEmail com várias options
  for (const field of [1, 2, 3, 4, 5]) {
    console.log(`\n=== 2.${field}) search/UserEmail field=${field} equals "${email}" ===`);
    const r = await http.get('/search/UserEmail', {
      headers,
      params: {
        'criteria[0][field]': field,
        'criteria[0][searchtype]': 'equals',
        'criteria[0][value]': email,
        range: '0-4'
      }
    });
    if (r.status === 200 && (r.data?.data ?? []).length > 0) {
      console.log(`  ✅ ${r.data.data.length} resultado(s):`, JSON.stringify(r.data.data));
    } else {
      console.log(`  Sem resultado (HTTP ${r.status})`);
    }
  }

  // 3) Tenta search/UserEmail com searchtype "contains"
  console.log('\n=== 3) search/UserEmail searchtype=contains ===');
  const r3 = await http.get('/search/UserEmail', {
    headers,
    params: {
      'criteria[0][field]': 2,
      'criteria[0][searchtype]': 'contains',
      'criteria[0][value]': email,
      range: '0-4'
    }
  });
  console.log(`HTTP ${r3.status}`, JSON.stringify(r3.data?.data ?? r3.data).slice(0, 300));

  // 4) Tenta search/User onde o nome contem o email
  console.log('\n=== 4) search/User onde name=email ===');
  const r4 = await http.get('/search/User', {
    headers,
    params: {
      'criteria[0][field]': 1,
      'criteria[0][searchtype]': 'equals',
      'criteria[0][value]': email,
      range: '0-4',
      'forcedisplay[0]': 2
    }
  });
  console.log(`HTTP ${r4.status}`, JSON.stringify(r4.data?.data ?? r4.data).slice(0, 300));

  // 5) Lista UserEmail diretamente onde o email contem
  console.log('\n=== 5) GET /UserEmail (lista) procurando manual ===');
  const r5 = await http.get('/UserEmail', {
    headers,
    params: { range: '0-49' }
  });
  if (Array.isArray(r5.data)) {
    const found = r5.data.find((e: { email?: string }) =>
      String(e.email ?? '').toLowerCase() === email.toLowerCase()
    );
    console.log(`  ${r5.data.length} emails lidos. Match para "${email}":`, found ?? 'nenhum');
  } else {
    console.log(`  HTTP ${r5.status}`, JSON.stringify(r5.data).slice(0, 200));
  }

  // 6) Tenta o endpoint /User direto com filtro
  console.log('\n=== 6) GET /User?searchText[name]=email (legacy) ===');
  const r6 = await http.get('/User', {
    headers,
    params: { 'searchText[name]': email, range: '0-4' }
  });
  if (Array.isArray(r6.data) && r6.data.length > 0) {
    console.log('  Resultados:', r6.data.map((u: { id?: number; name?: string }) => `#${u.id} ${u.name}`).join(', '));
  } else {
    console.log(`  HTTP ${r6.status}`, JSON.stringify(r6.data).slice(0, 200));
  }

  await http.get('/killSession', { headers });
}

main().catch((e) => {
  console.error('Erro:', (e as Error).message);
  process.exit(1);
});
