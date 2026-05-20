/**
 * Confirma que UF_CRM_1588120619499 é o CNPJ em outras Companies, e
 * testa a busca por CNPJ usando crm.company.list.
 */
import axios from 'axios';

const BASE = 'https://uctech.bitrix24.com.br/rest/11013/sv73jkzl96pns8g5/';
const CNPJ_FIELD = 'UF_CRM_1588120619499';

const http = axios.create({ baseURL: BASE, timeout: 20_000, validateStatus: () => true });
async function call(method: string, params: Record<string, unknown> = {}) {
  const res = await http.post(`${method}.json`, params);
  return res.data;
}

async function main() {
  console.log(`=== 1) Lendo 5 Companies para confirmar que ${CNPJ_FIELD} é o CNPJ ===\n`);
  const list = await call('crm.company.list', {
    order: { ID: 'DESC' },
    filter: {},
    select: ['ID', 'TITLE', CNPJ_FIELD],
    start: 0
  });
  if (list.error) {
    console.error('Erro:', list.error, list.error_description);
    return;
  }
  for (const c of (list.result ?? []).slice(0, 5)) {
    console.log(`  #${c.ID} | ${c.TITLE}`);
    console.log(`    CNPJ: ${c[CNPJ_FIELD] ?? '(vazio)'}`);
  }

  console.log('\n=== 2) Buscando empresa por CNPJ = 71948699000164 ===');
  const search = await call('crm.company.list', {
    filter: { [`=${CNPJ_FIELD}`]: '71948699000164' },
    select: ['ID', 'TITLE', CNPJ_FIELD]
  });
  if (search.error) {
    console.error('Erro:', search.error, search.error_description);
    return;
  }
  console.log(`Achou ${search.result?.length ?? 0} empresa(s):`);
  for (const c of search.result ?? []) {
    console.log(`  ✅ #${c.ID} | ${c.TITLE} | CNPJ=${c[CNPJ_FIELD]}`);
  }

  console.log('\n=== 3) Buscando CNPJ inexistente ===');
  const noMatch = await call('crm.company.list', {
    filter: { [`=${CNPJ_FIELD}`]: '00000000000000' },
    select: ['ID', 'TITLE']
  });
  console.log(`Resultados: ${noMatch.result?.length ?? 0} (esperado 0)`);
}

main().catch((e) => {
  console.error('Erro:', (e as Error).message);
  process.exit(1);
});
