/**
 * Normaliza um CNPJ removendo TUDO que não é dígito.
 * Aceita formatos como:
 *   "71.948.699/0001-64"  -> "71948699000164"
 *   "04600555000125"       -> "04600555000125"
 *   " 71948699000164 "     -> "71948699000164"
 *   null / undefined / ""  -> ""
 * Retorna string vazia se entrada inválida — quem chamou decide o que fazer.
 */
export function normalizeCnpj(input: unknown): string {
  if (input === null || input === undefined) return '';
  return String(input).replace(/\D+/g, '');
}

export function isValidCnpjLength(cnpj: string): boolean {
  // CNPJ brasileiro = 14 dígitos. Não vamos validar dígitos verificadores aqui
  // porque o GLPI/Bitrix podem ter cadastros legados com CNPJ "errado" mas que
  // existem em ambos os lados — o que importa é o match exato entre as plataformas.
  return cnpj.length === 14;
}
