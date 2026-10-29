// Vigia a internet da base: o feed do Active Net chega ao servidor pela ponte do PC da empresa. Se a ponte não
// está conectada, ou nada chega (nem o batimento de 30 s) por mais que o limite, a base está sem internet ou a
// ponte parou. Avisa uma vez quando cai e uma vez quando volta.
export class VigiaBase {
  private fora = false;
  private readonly inicio: number;

  constructor(private readonly limiteSeg: number, private readonly agora: () => Date = () => new Date()) {
    this.inicio = agora().getTime();
  }

  verificar(estado: { conexoes: number; ultimoSinal?: Date }): 'caiu' | 'voltou' | undefined {
    const agora = this.agora().getTime();
    const ultimo = estado.ultimoSinal?.getTime() ?? this.inicio;
    const semSinal = agora - ultimo > this.limiteSeg * 1000;
    const caida = semSinal || (estado.conexoes === 0 && agora - Math.max(ultimo, this.inicio) > this.limiteSeg * 1000);
    if (caida && !this.fora) { this.fora = true; return 'caiu'; }
    if (!caida && this.fora && estado.conexoes > 0) { this.fora = false; return 'voltou'; }
    return undefined;
  }

  get semSinal(): boolean {
    return this.fora;
  }
}
