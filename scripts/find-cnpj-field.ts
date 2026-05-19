import axios from 'axios';

const BASE = 'https://uctech.bitrix24.com.br/rest/491/ho8n3gntmllz2fkk/';

const http = axios.create({ baseURL: BASE, timeout: 15_000, validateStatus: () => true });

async function call(method: string, params: Record<string, unknown> = {}) {
  const res = await http.post(`${method}.json`, params);
  return res.data;
}

async function main() {
  console.log('=== Listando campos customizados de Empresa (crm.company.userfield.list) ===');
  const fields = await call('crm.company.userfield.list', {
    order: { SORT: 'ASC' }
  });

  if (fields.error) {
    console.error('❌ Erro:', fields.error, fields.error_description);
    return;
  }

  console.log(`\nTotal: ${fields.result?.length ?? 0} campos customizados\n`);
  for (const f of fields.result ?? []) {
    const label = f.EDIT_FORM_LABEL?.pt ?? f.EDIT_FORM_LABEL?.en ?? f.EDIT_FORM_LABEL?.br ?? Object.values(f.EDIT_FORM_LABEL ?? {})[0] ?? '(sem label)';
    console.log(`  FIELD_NAME: ${f.FIELD_NAME}`);
    console.log(`    LABEL    : ${label}`);
    console.log(`    TYPE     : ${f.USER_TYPE_ID}`);
    console.log(`    XML_ID   : ${f.XML_ID ?? '(vazio)'}`);
    console.log('');
  }

  // Tenta achar especificamente o campo CNPJ
  const cnpjField = (fields.result ?? []).find((f: { EDIT_FORM_LABEL?: Record<string, string>; XML_ID?: string }) => {
    const labels = Object.values(f.EDIT_FORM_LABEL ?? {}).join(' ').toLowerCase();
    const xml = (f.XML_ID ?? '').toLowerCase();
    return labels.includes('cnpj') || xml.includes('cnpj');
  });

  if (cnpjField) {
    console.log('🎯 Campo CNPJ encontrado:');
    console.log('   FIELD_NAME:', cnpjField.FIELD_NAME);
  } else {
    console.log('⚠️ Não achei automaticamente. Veja a lista acima e me diga qual é o de CNPJ.');
  }

  // Lê a empresa do print (32605) para confirmar o valor
  console.log('\n=== Lendo Company 32605 para confirmar ===');
  const company = await call('crm.company.get', { ID: 32605 });
  if (company.result) {
    const ufFields = Object.entries(company.result).filter(([k]) => k.startsWith('UF_CRM_'));
    console.log(`Empresa: ${company.result.TITLE}`);
    console.log('Campos UF_CRM_* preenchidos:');
    for (const [k, v] of ufFields) {
      if (v && v !== '' && v !== null) {
        console.log(`  ${k} = ${JSON.stringify(v)}`);
      }
    }
  } else {
    console.log('Empresa 32605 não retornou. Erro:', company.error);
  }
}

main().catch((e) => {
  console.error('❌ Erro:', (e as Error).message);
  process.exit(1);
});
