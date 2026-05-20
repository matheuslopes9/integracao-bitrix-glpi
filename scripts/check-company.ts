/**
 * Confirma rapidamente se uma Company existe no Bitrix por CNPJ.
 * Roda: npx tsx scripts/check-company.ts <cnpj>
 */
import axios from 'axios';

const BASE = 'https://uctech.bitrix24.com.br/rest/11013/sv73jkzl96pns8g5/';
const CNPJ_FIELD = 'UF_CRM_1588120619499';
const cnpj = (process.argv[2] ?? '').replace(/\D+/g, '');

if (!cnpj || cnpj.length !== 14) {
  console.error('Uso: npx tsx scripts/check-company.ts <cnpj-14-digitos>');
  process.exit(1);
}

const http = axios.create({ baseURL: BASE, timeout: 15_000, validateStatus: () => true });

async function main() {
  // 1) busca exata
  const exact = await http.post('crm.company.list.json', {
    filter: { [`=${CNPJ_FIELD}`]: cnpj },
    select: ['ID', 'TITLE', CNPJ_FIELD]
  });
  let found: Record<string, unknown> | null = null;
  for (const c of (exact.data?.result ?? []) as Array<Record<string, unknown>>) {
    const stored = String(c[CNPJ_FIELD] ?? '').replace(/\D+/g, '');
    if (stored === cnpj) {
      found = c;
      break;
    }
  }

  if (!found) {
    // 2) fallback por raiz
    const root = cnpj.slice(0, 8);
    const candidates = await http.post('crm.company.list.json', {
      filter: { [`%${CNPJ_FIELD}`]: root },
      select: ['ID', 'TITLE', CNPJ_FIELD]
    });
    for (const c of (candidates.data?.result ?? []) as Array<Record<string, unknown>>) {
      const stored = String(c[CNPJ_FIELD] ?? '').replace(/\D+/g, '');
      if (stored === cnpj) {
        found = c;
        break;
      }
    }
  }

  if (found) {
    console.log('✅ Match!');
    console.log(`   Company ID:    ${found.ID}`);
    console.log(`   Title:         ${found.TITLE}`);
    console.log(`   CNPJ no Bitrix: ${found[CNPJ_FIELD]}`);
  } else {
    console.log(`❌ CNPJ ${cnpj} NÃO existe no Bitrix`);
  }
}
main().catch((e) => {
  console.error('Erro:', (e as Error).message);
  process.exit(1);
});
