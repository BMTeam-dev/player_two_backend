// Filtro de termos graves do chat (MVP.md, seção 10): só marca a mensagem
// com `flagged: true` para a moderação achar depressa. Não esconde nem
// bloqueia nada: falso positivo custa só uma olhada do moderador, e falso
// negativo ainda pode ser denunciado. Por isso a lista é curta e fica de
// fora palavrão comum ("porra", "caralho"), que é só linguagem de jogo.
//
// Lista inicial: revisar junto com o checklist de moderação (tarefa 35).

// Comparados contra o texto normalizado (ver `normalize`), palavra a palavra.
const WORDS = new Set([
  // ódio (raça, orientação, identidade)
  'crioulo',
  'criolo',
  'macaca',
  'tiziu',
  'viado',
  'viadinho',
  'bichona',
  'traveco',
  'sapatao',
  // assédio sexual
  'nudes',
  // ameaça e incentivo a autolesão
  'kys',
]);

// Expressões de mais de uma palavra, procuradas no texto normalizado inteiro.
const PHRASES = ['vou te matar', 'vou matar voce', 'se mata', 'vai se matar', 'te pegar na saida', 'sei onde voce mora'];

const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', $: 's' };

/** Minúsculas, sem acento, sem leet ("v1ad0" → "viado") e sem letra repetida ("viaaado" → "viado"). */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[013457@$]/g, c => LEET[c] ?? c)
    .replace(/[^a-z]+/g, ' ')
    .replace(/([a-z])\1+/g, '$1')
    .trim();
}

export function hasSevereTerm(text: string): boolean {
  const normalized = normalize(text);
  if (normalized.split(' ').some(word => WORDS.has(word))) {
    return true;
  }
  const padded = ` ${normalized} `;
  return PHRASES.some(phrase => padded.includes(` ${phrase} `));
}
