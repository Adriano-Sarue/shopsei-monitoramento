// Falta de teste periódico: cada cliente pode exigir que suas centrais mandem algum sinal (teste,
// keep alive ou qualquer evento) dentro de um intervalo. Passou do prazo, vira ocorrência uma vez,
// até a central voltar a falar.
export class SupervisaoTeste {
  private readonly visto = new Map<string, number>();
  private readonly avisadas = new Set<string>();
  private readonly inicio: number;

  constructor(
    private readonly intervaloHoras: (conta: string) => number | undefined,
    private readonly agora: () => Date = () => new Date(),
  ) {
    this.inicio = this.agora().getTime();
  }

  carregar(ultimos: Map<string, Date>): void {
    for (const [conta, quando] of ultimos) this.registrar(conta, quando);
  }

  registrar(conta: string, quando: Date): void {
    const c = conta.toUpperCase();
    if (quando.getTime() >= (this.visto.get(c) ?? 0)) this.visto.set(c, quando.getTime());
    this.avisadas.delete(c);
  }

  // Contas em atraso que ainda não foram avisadas. Conta nunca vista conta a partir da subida do sistema.
  atrasadas(contas: string[]): { conta: string; desde: Date; horas: number }[] {
    const agora = this.agora().getTime();
    const out: { conta: string; desde: Date; horas: number }[] = [];
    for (const conta of contas.map((c) => c.toUpperCase())) {
      const horas = this.intervaloHoras(conta);
      if (!horas || this.avisadas.has(conta)) continue;
      const desde = this.visto.get(conta) ?? this.inicio;
      if (agora - desde < horas * 3600_000) continue;
      this.avisadas.add(conta);
      out.push({ conta, desde: new Date(desde), horas });
    }
    return out;
  }
}
