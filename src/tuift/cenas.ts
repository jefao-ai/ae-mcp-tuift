// Cenas com nome (01/11/2026): cada cena é um marcador da comp com o nome no padrão S01_GANCHO e a duração
// no próprio marcador. tuift.cena grava; ae_see, ae_review_motion e ae_render_video leem, para olhar, revisar e
// refazer por cena.

export interface Cena {
  nome: string;
  inicio: number;
  fim: number;
}

/** JSX (ES3): define TUIFT_lerCenas(comp), que devolve as cenas marcadas em ordem de tempo. */
export const LER_CENAS_FN = `
function TUIFT_lerCenas(c) {
  var out = [], m = c.markerProperty, n = m.numKeys;
  for (var i = 1; i <= n; i++) {
    var v = m.keyValue(i), txt = String(v.comment || "");
    if (!/^S[0-9]{2,3}_/.test(txt)) continue;
    out.push({ nome: txt.split(" ")[0], inicio: m.keyTime(i), dur: v.duration });
  }
  for (var j = 0; j < out.length; j++) {
    var prox = j + 1 < out.length ? out[j + 1].inicio : c.duration;
    out[j].fim = out[j].dur > 0 ? Math.min(out[j].inicio + out[j].dur, c.duration) : prox;
    delete out[j].dur;
  }
  return out;
}
`;

function semAcento(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** "gancho" na posição 0 vira S01_GANCHO; "S03 prova" vira S03_PROVA. */
export function normalizarNomeCena(indice: number, nome: string | undefined): string {
  const limpo = semAcento(String(nome ?? ""));
  if (/^S\d{2,3}_./.test(limpo)) return limpo;
  const numero = `S${String(indice + 1).padStart(2, "0")}`;
  return limpo ? `${numero}_${limpo}` : `${numero}_CENA`;
}

/** Aceita o nome inteiro ("S03_PROVA"), só o número ("S03") ou só o assunto ("prova"). */
export function filtrarCenas(cenas: Cena[], pedido: string | string[]): Cena[] {
  const pedidos = (Array.isArray(pedido) ? pedido : [pedido]).map(semAcento);
  return cenas.filter((c) =>
    pedidos.some(
      (p) =>
        c.nome === p || c.nome.startsWith(`${p}_`) || c.nome.split("_").slice(1).join("_") === p,
    ),
  );
}

/** Quadros que importam numa cena: 1 = meio; 2 = meio e pouso; 3 = entrada, meio e pouso. */
export function temposDaCena(c: Cena, fps: number, quadros: number): number[] {
  const encaixa = (t: number) => Math.round(t * fps) / fps;
  const ultimo = encaixa(Math.max(c.inicio, c.fim - 1 / fps));
  const meio = encaixa((c.inicio + c.fim) / 2);
  const entrada = encaixa(c.inicio + Math.min(0.25, (c.fim - c.inicio) / 4));
  const tempos = quadros <= 1 ? [meio] : quadros === 2 ? [meio, ultimo] : [entrada, meio, ultimo];
  return [...new Set(tempos)];
}

export function cenaNoTempo(cenas: Cena[], t: number): string | undefined {
  return cenas.find((c) => t >= c.inicio - 1e-6 && t < c.fim - 1e-6)?.nome;
}
