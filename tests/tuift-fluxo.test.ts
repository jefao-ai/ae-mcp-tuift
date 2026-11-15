import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import {
  acharPicos,
  avaliarRenderTool,
  lerAudioScan,
  lerVideoScan,
  medirMovimento,
  notaAudio,
  notaRitmo,
  notaTecnica,
  somarRevisao,
  vereditoFinal,
  lerProblemas,
  textoRevisao,
} from "../src/tuift/avaliar.js";
import { cenaNoTempo, filtrarCenas, normalizarNomeCena, temposDaCena } from "../src/tuift/cenas.js";
import { DEFAULT_STYLE } from "../src/tuift/common.js";
import { acharIdentidade, checarIdentidade, lerIdentidade } from "../src/tuift/identidade.js";
import { checarPlano, iniciosDeFrase, normalizarPalavras } from "../src/tuift/plano.js";
import { temposPorCena } from "../src/tuift/see.js";
import { nomeLivre, quadrosDaSequencia } from "../src/operations/pacote.js";

const regras = (p: Array<{ rule: string }>) => p.map((x) => x.rule);

describe("cenas", () => {
  it("normaliza o nome", () => {
    expect(normalizarNomeCena(0, "gancho")).toBe("S01_GANCHO");
    expect(normalizarNomeCena(4, "Prova social ção")).toBe("S05_PROVA_SOCIAL_CAO");
    expect(normalizarNomeCena(1, "S07 fecho")).toBe("S07_FECHO");
    expect(normalizarNomeCena(2, undefined)).toBe("S03_CENA");
  });

  it("filtra por nome, número ou assunto", () => {
    const cenas = [
      { nome: "S01_GANCHO", inicio: 0, fim: 2 },
      { nome: "S02_PROVA_SOCIAL", inicio: 2, fim: 4 },
    ];
    expect(filtrarCenas(cenas, "S02").map((c) => c.nome)).toEqual(["S02_PROVA_SOCIAL"]);
    expect(filtrarCenas(cenas, "prova social").map((c) => c.nome)).toEqual(["S02_PROVA_SOCIAL"]);
    expect(filtrarCenas(cenas, ["S01_GANCHO", "S02"])).toHaveLength(2);
    expect(filtrarCenas(cenas, "S1")).toHaveLength(0);
    expect(cenaNoTempo(cenas, 2)).toBe("S02_PROVA_SOCIAL");
    expect(cenaNoTempo(cenas, 9)).toBeUndefined();
  });

  it("escolhe meio e pouso em quadros exatos", () => {
    expect(temposDaCena({ nome: "S", inicio: 2, fim: 4 }, 30, 2)).toEqual([3, 119 / 30]);
    expect(temposDaCena({ nome: "S", inicio: 2, fim: 4 }, 30, 1)).toEqual([3]);
    expect(temposDaCena({ nome: "S", inicio: 2, fim: 4 }, 30, 3)).toHaveLength(3);
  });

  it("reduz para um quadro por cena quando não cabe na folha", () => {
    const cenas = Array.from({ length: 20 }, (_, i) => ({
      nome: `S${i}_X`,
      inicio: i,
      fim: i + 1,
    }));
    const r = temposPorCena(cenas, 30, 2);
    expect(r.quadros).toBe(1);
    expect(r.times).toHaveLength(20);
    expect(r.labels[0]).toBe("S0_X 0.50s");
  });
});

describe("pacote", () => {
  it("não repete nome, nem com maiúscula diferente", () => {
    const usados = new Set<string>();
    expect(nomeLivre(usados, "Foto.png")).toBe("Foto.png");
    expect(nomeLivre(usados, "foto.PNG")).toBe("foto__2.PNG");
    expect(nomeLivre(usados, "Foto.png")).toBe("Foto__3.png");
  });

  it("acha os quadros da sequência sem pegar outros arquivos", () => {
    const pasta = [
      "frame_0001.png",
      "frame_0002.png",
      "frame_0003.PNG",
      "outro_0001.png",
      "frame_0001.jpg",
    ];
    expect(quadrosDaSequencia("C:/x/frame_0002.png", pasta)).toEqual([
      "frame_0001.png",
      "frame_0002.png",
      "frame_0003.PNG",
    ]);
    expect(quadrosDaSequencia("C:/x/capa.png", pasta)).toEqual(["capa.png"]);
  });
});

describe("identidade", () => {
  const coleta = {
    textos: [
      { comp: "A", layer: "titulo", fonte: "SFProDisplay-Bold", familia: "SF Pro Display" },
      { comp: "A", layer: "nota", fonte: "ArialMT", familia: "Arial" },
    ],
    cores: [
      { comp: "A", layer: "card", tipo: "preenchimento", rgb: [10, 132, 255] },
      { comp: "A", layer: "fundo", tipo: "sólido", rgb: [20, 20, 20] },
      { comp: "A", layer: "selo", tipo: "preenchimento", rgb: [255, 0, 0] },
      { comp: "Library", layer: "peca", tipo: "preenchimento", rgb: [0, 255, 0] },
    ],
    raios: [
      { comp: "A", layer: "card", raio: 24 },
      { comp: "A", layer: "selo", raio: 7 },
    ],
  };

  it("acusa fonte, cor e raio fora", () => {
    const p = checarIdentidade(coleta, {
      fontes: ["SF Pro*"],
      paleta: ["#0A84FF"],
      raiosPx: [24],
    });
    expect(regras(p)).toEqual([
      "fonte_fora_da_identidade",
      "cor_fora_da_identidade",
      "cor_fora_da_identidade",
      "raio_fora_da_identidade",
    ]);
    expect(p[0].msg).toContain("ArialMT");
  });

  it("neutros passam por padrão, e não passam com neutrosLivres false", () => {
    const coletaSimples = { textos: [], raios: [], cores: [coleta.cores[1]] };
    expect(checarIdentidade(coletaSimples, { paleta: ["#0A84FF"] })).toEqual([]);
    expect(
      checarIdentidade(coletaSimples, { paleta: ["#0A84FF"], neutrosLivres: false }),
    ).toHaveLength(1);
  });

  it("ignora camadas e comps pedidas", () => {
    const p = checarIdentidade(coleta, { paleta: ["#0A84FF", "#FF0000"], ignorar: ["^Library$"] });
    expect(p).toEqual([]);
  });

  it("recusa cor inválida e aceita objeto", () => {
    expect(lerIdentidade({ paleta: ["azul"] }).erro).toContain("azul");
    expect(lerIdentidade({ paleta: ["#ffffff"] }).identidade).toBeTruthy();
    expect(lerIdentidade("Z:/nao/existe.json").erro).toBeTruthy();
  });

  it("acha o arquivo subindo pastas", () => {
    const raiz = mkdtempSync(path.join(os.tmpdir(), "ident-"));
    try {
      writeFileSync(path.join(raiz, "identidade.json"), "{}");
      expect(acharIdentidade(path.join(raiz, "ae", "video.aep"))).toBe(
        path.join(raiz, "identidade.json"),
      );
      expect(acharIdentidade(null)).toBeNull();
    } finally {
      rmSync(raiz, { recursive: true, force: true });
    }
  });
});

describe("plano", () => {
  const base = (cenas: any[], extra: any = {}) => ({ tipo: "narrado", cenas, ...extra });
  const cena = (nome: string, inicio: number, fim: number, extra: any = {}) => ({
    nome,
    inicio,
    fim,
    ...extra,
  });

  it("aceita um plano redondo e devolve as cenas prontas", () => {
    const r = checarPlano(
      base([cena("gancho", 0, 5), cena("prova", 4.8, 10)], { duracao: 10 }),
      DEFAULT_STYLE,
    );
    expect(r.problemas).toEqual([]);
    expect(r.cenas.map((c) => c.nome)).toEqual(["S01_GANCHO", "S02_PROVA"]);
  });

  it("acusa buraco, sobreposição grande e fim descoberto", () => {
    const r = checarPlano(
      base([cena("a", 0, 4), cena("b", 4.5, 8), cena("c", 7, 11)], { duracao: 15 }),
      DEFAULT_STYLE,
    );
    expect(regras(r.problemas)).toEqual(
      expect.arrayContaining(["buraco_entre_cenas", "sobreposicao_grande"]),
    );
    expect(r.problemas.filter((p) => p.rule === "buraco_entre_cenas")).toHaveLength(2);
  });

  it("acusa cena invertida, repetida e plano vazio", () => {
    expect(regras(checarPlano({}, DEFAULT_STYLE).problemas)).toEqual(["plano_sem_cenas"]);
    const r = checarPlano(base([cena("S01_A", 3, 1), cena("S01_A", 0, 4)]), DEFAULT_STYLE);
    expect(regras(r.problemas)).toEqual(
      expect.arrayContaining(["cena_invertida", "cena_repetida"]),
    );
  });

  it("usa os limites do perfil", () => {
    const curta = base([cena("a", 0, 1)]);
    expect(regras(checarPlano(curta, DEFAULT_STYLE).problemas)).toContain("cena_curta");
    expect(
      regras(checarPlano({ ...curta, tipo: "cinetico" }, DEFAULT_STYLE).problemas),
    ).not.toContain("cena_curta");
    expect(regras(checarPlano(base([cena("a", 0, 12)]), DEFAULT_STYLE).problemas)).toContain(
      "cena_longa",
    );
    const muitas = base(Array.from({ length: 20 }, (_, i) => cena(`c${i}`, i * 3, (i + 1) * 3)));
    expect(regras(checarPlano({ ...muitas, duracao: 60 }, DEFAULT_STYLE).problemas)).toContain(
      "cenas_demais",
    );
  });

  it("acusa texto longo e citado sem imagem", () => {
    const r = checarPlano(
      base([
        cena("a", 0, 5, {
          texto: "um dois tres quatro cinco seis sete oito nove dez",
          citados: [{ nome: "Acme Bank" }, { nome: "Acme Food", asset: "acme-food.svg" }],
        }),
      ]),
      DEFAULT_STYLE,
      { existe: () => false },
    );
    expect(regras(r.problemas)).toEqual(["texto_longo", "citado_sem_asset", "asset_nao_existe"]);
  });

  it("confere elementos: juntos, vida, fora da cena, densidade", () => {
    const e = (nome: string, entra: number, sai: number, papel = "apoio") => ({
      nome,
      entra,
      sai,
      papel,
    });
    const r = checarPlano(
      base([
        cena("a", 0, 6, {
          elementos: [
            e("p", 0.2, 5.5, "principal"),
            e("a1", 1, 5),
            e("a2", 1.5, 5),
            e("a3", 2, 3),
            e("legenda", 2, 3, "legenda"),
            e("fora", 7, 9),
          ],
        }),
      ]),
      DEFAULT_STYLE,
    );
    expect(regras(r.problemas)).toEqual(
      expect.arrayContaining(["elemento_fora_da_cena", "elemento_vive_pouco", "elementos_juntos"]),
    );
    const denso = base([
      cena("a", 0, 8, {
        elementos: Array.from({ length: 9 }, (_, i) => e(`x${i}`, i * 0.5, 7)),
      }),
    ]);
    expect(regras(checarPlano(denso, DEFAULT_STYLE).problemas)).toContain("elementos_demais");
  });

  it("confere a fala contra as cenas", () => {
    const palavras = normalizarPalavras([
      { word: "Oi,", start: 0.1, end: 0.4 },
      { word: "tudo", start: 0.5, end: 0.7 },
      { word: "bem", start: 0.7, end: 1 },
      { word: "Agora", start: 4, end: 4.3 },
      { word: "fim", start: 9, end: 9.3 },
    ]);
    expect(iniciosDeFrase(palavras)).toEqual([0.1, 0.5, 4, 9]);
    const r = checarPlano(base([cena("a", 0, 5.5), cena("b", 5.5, 8)]), DEFAULT_STYLE, {
      palavras,
    });
    expect(regras(r.problemas)).toEqual(
      expect.arrayContaining(["fala_sem_cena", "troca_fora_da_frase"]),
    );
  });
});

describe("avaliar render", () => {
  const A = DEFAULT_STYLE.avaliacao;

  it("acha picos com proeminência e distância", () => {
    const s = [0, 0, 5, 0, 0, 0.5, 0, 0, 6, 5.5, 0];
    expect(acharPicos(s, 3, 3)).toEqual([2, 8]);
  });

  it("mede repouso, tempo parado, corte e primeira mudança", () => {
    const s = [...Array(24).fill(0), 40, ...Array(35).fill(0.1)];
    const m = medirMovimento(s);
    expect(m.cortes).toBe(1);
    expect(m.primeiraMudancaSec).toBeCloseTo(25 / 12, 1);
    expect(m.maiorRepousoSec).toBeCloseTo(35 / 12, 1);
    expect(m.tempoParadoPct).toBe(98);
  });

  it("lê a saída do ffmpeg", () => {
    const a = lerAudioScan(
      "[silencedetect] silence_start: 0\n[silencedetect] silence_end: 1.5 | silence_duration: 1.5\n  Integrated loudness:\n    I:         -14.2 LUFS\n  True peak:\n    Peak:       -1.3 dBFS",
    );
    expect(a).toEqual({ lufs: -14.2, picoDb: -1.3, silencios: [{ ini: 0, fim: 1.5, dur: 1.5 }] });
    expect(lerAudioScan("Peak: -inf dBFS").picoDb).toBeNull();
    const v = lerVideoScan(
      "black_start:1 black_end:2 black_duration:1\nlavfi.freezedetect.freeze_start: 3\nlavfi.freezedetect.freeze_duration: 2\n",
    );
    expect(v).toEqual({ pretos: [{ ini: 1, fim: 2 }], congelados: [{ ini: 3, dur: 2 }] });
  });

  it("dá nota técnica cheia para a entrega da casa", () => {
    const n = notaTecnica(
      [
        {
          codec_type: "video",
          codec_name: "h264",
          width: 1080,
          height: 1920,
          avg_frame_rate: "30/1",
          color_primaries: "bt709",
          color_transfer: "bt709",
        },
        { codec_type: "audio", codec_name: "aac", sample_rate: "48000" },
      ],
      "mov,mp4,m4a",
    );
    expect(n.nota).toBe(15);
    expect(n.notas).toEqual([]);
    const ruim = notaTecnica(
      [{ codec_type: "video", codec_name: "vp9", width: 640, height: 360, avg_frame_rate: "12/1" }],
      "webm",
    );
    expect(ruim.nota).toBeLessThan(6);
    expect(ruim.notas.join(" ")).toContain("BT.709");
  });

  it("dá nota de áudio pelo alvo", () => {
    const ok = notaAudio({ lufs: -14, picoDb: -1.5, silencios: [] }, 30, -14, A);
    expect(ok.nota).toBe(15);
    const baixo = notaAudio(
      { lufs: -22, picoDb: 0, silencios: [{ ini: 0, fim: 10, dur: 10 }] },
      30,
      -14,
      A,
    );
    expect(baixo.nota).toBeLessThan(3);
    expect(notaAudio({ lufs: null, picoDb: null, silencios: [] }, 30, -14, A).nota).toBe(0);
  });

  it("dá nota de ritmo pelo perfil", () => {
    const m: any = { eventosPor10s: 4, tempoParadoPct: 30, maiorRepousoSec: 4 };
    expect(notaRitmo(m, A.perfis.narrado).nota).toBe(15);
    expect(notaRitmo(m, A.perfis.cinetico).nota).toBeLessThan(9);
  });

  it("soma a revisão e aplica as travas", () => {
    const boa = {
      categorias: {
        gancho: { nota: 9 },
        clareza: { nota: 13 },
        acabamento: { nota: 9 },
        identidade: { nota: 9 },
      },
      travas: {
        tudo_citado_aparece: { status: "ok" },
        texto_sem_erro: { status: "ok" },
        sem_cara_de_ia: { status: "ok" },
      },
    };
    expect(somarRevisao(boa)).toEqual({ editorial: 40, falhas: [], pendentes: [] });
    expect(somarRevisao({ categorias: { gancho: { nota: 99 } } }).erro).toContain("gancho");
    const emBranco = structuredClone(boa) as any;
    emBranco.categorias.clareza.nota = null;
    expect(somarRevisao(emBranco).erro).toContain("clareza");
    const falha = somarRevisao({
      ...boa,
      travas: { ...boa.travas, texto_sem_erro: { status: "falhou" } },
    });
    expect(falha.falhas).toEqual(["texto_sem_erro"]);
    expect(vereditoFinal(50, 40, [], A)).toBe("pronto");
    expect(vereditoFinal(40, 35, [], A)).toBe("revisar");
    expect(vereditoFinal(30, 20, [], A)).toBe("refazer");
    expect(vereditoFinal(50, 40, ["texto_sem_erro"], A)).toBe("travado");
    expect(vereditoFinal(50, null, [], A)).toBe("falta_revisao_editorial");
  });

  it("lê a revisão por problemas e monta o pacote com as regras e os casos da casa", () => {
    expect(lerProblemas({ problemas: [], veredito_previsto: "aprovaria" }).veredito).toBe("pronto");
    expect(
      lerProblemas({
        problemas: [{ gravidade: "media" }],
        veredito_previsto: "Aprovaria com ajustes",
      }).veredito,
    ).toBe("revisar");
    expect(lerProblemas({ problemas: [], veredito_previsto: "pediria refação" }).veredito).toBe(
      "refazer",
    );
    // "aprovaria" com problema alto e certo é contradição: vale o problema
    expect(
      lerProblemas({ problemas: [{ gravidade: "alta" }], veredito_previsto: "aprovaria" }).veredito,
    ).toBe("refazer");
    expect(
      lerProblemas({
        problemas: [{ gravidade: "alta", incerto: true }],
        veredito_previsto: "aprovaria",
      }).veredito,
    ).toBe("pronto");
    expect(lerProblemas({ veredito_previsto: "nota 9" }).erro).toContain("veredito_previsto");
    const casa = {
      regras: [{ id: "R1", nome: "Densidade", texto: "um elemento por frase" }],
      casos: [
        { projeto: "proj-a", veredito: "REPROVADO", texto: "caso A" },
        { projeto: "proj-b", veredito: "APROVADO", texto: "caso B" },
      ],
    };
    const medido = { duracao: 10, audio: { lufs: -14, picoDb: -1, silencios: [] }, defeitos: {} };
    const t = textoRevisao("C:/x/proj-a/render/v1.mp4", medido, [], "reel", "teste", casa);
    expect(t).toContain("R1 Densidade");
    expect(t).toContain("caso B");
    expect(t).not.toContain("caso A"); // o caso do próprio projeto sai da calibração
    expect(t).toContain("não afirme que falta som");
    expect(t).toContain("veredito_previsto");
  });

  it("mede um arquivo de verdade e dá ID novo quando o conteúdo muda", async () => {
    const raiz = mkdtempSync(path.join(os.tmpdir(), "avaliar-"));
    const gera = (arquivo: string, freq: number) =>
      execFileSync(
        "ffmpeg",
        [
          "-y",
          "-loglevel",
          "error",
          "-f",
          "lavfi",
          "-i",
          "testsrc2=s=360x640:r=30:d=4",
          "-f",
          "lavfi",
          "-i",
          `sine=f=${freq}:r=48000:d=4`,
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          "-c:a",
          "aac",
          "-shortest",
          arquivo,
        ],
        { stdio: "ignore" },
      );
    try {
      const video = path.join(raiz, "v1.mp4");
      gera(video, 440);
      const r: any = await avaliarRenderTool.handler(
        { video, tipo: "cinetico" } as any,
        null as any,
      );
      expect(r.isError).toBeFalsy();
      const s = r.structuredContent;
      expect(s.veredito).toBe("falta_revisao_editorial");
      expect(s.medida).toBeGreaterThan(10);
      expect(s.folhas).toHaveLength(2);

      const revisao = {
        categorias: {
          gancho: { nota: 8 },
          clareza: { nota: 12 },
          acabamento: { nota: 8 },
          identidade: { nota: 8 },
        },
        travas: {
          tudo_citado_aparece: { status: "ok" },
          texto_sem_erro: { status: "ok" },
          sem_cara_de_ia: { status: "ok" },
        },
      };
      const final: any = await avaliarRenderTool.handler(
        { video, tipo: "cinetico", revisao } as any,
        null as any,
      );
      expect(final.structuredContent.total).toBe(s.medida + 36);
      expect(final.structuredContent.id).toBe(s.id);

      // Medir de novo não apaga a revisão preenchida; o modelo em branco é recusado.
      const arquivoRevisao = path.join(final.structuredContent.pasta, "revisao.json");
      writeFileSync(arquivoRevisao, JSON.stringify(revisao));
      const denovo: any = await avaliarRenderTool.handler(
        { video, tipo: "cinetico", forcar: true, revisao: "revisao.json" } as any,
        null as any,
      );
      expect(denovo.structuredContent.editorial).toBe(36);
      const semTravas = { categorias: revisao.categorias };
      const pendente: any = await avaliarRenderTool.handler(
        { video, tipo: "cinetico", revisao: semTravas } as any,
        null as any,
      );
      expect(pendente.structuredContent.travasPendentes).toHaveLength(3);
      expect(pendente.structuredContent.veredito).not.toBe("pronto");

      gera(video, 880);
      const nova: any = await avaliarRenderTool.handler(
        { video, tipo: "cinetico" } as any,
        null as any,
      );
      expect(nova.structuredContent.id).not.toBe(s.id);
      expect(nova.structuredContent.total).toBeNull();
      expect(nova.structuredContent.evolucao).toHaveLength(2);
    } finally {
      rmSync(raiz, { recursive: true, force: true });
    }
  }, 120_000);
});
