// Funções comuns às telas: chamada de API, montagem de elementos e barra superior.
const $ = (id) => document.getElementById(id);

function el(tag, cls, txt) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt !== undefined) e.textContent = txt;
  return e;
}

function hora(iso) { return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }); }

function haQuanto(iso) {
  const min = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (min < 1) return 'agora';
  if (min < 60) return 'há ' + min + ' min';
  return 'há ' + Math.floor(min / 60) + ' h ' + (min % 60) + ' min';
}

async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { 'content-type': 'application/json' } });
  let data = {};
  try { data = await r.json(); } catch { /* resposta sem corpo */ }
  if (r.status === 401 && !path.startsWith('/api/login')) { location.href = '/login.html'; throw new Error('Sessão expirada'); }
  if (!r.ok) throw new Error(data.erro || r.statusText);
  return data;
}

function toast(texto) {
  const t = el('div', 'toast', texto);
  document.body.append(t);
  setTimeout(() => t.remove(), 2800);
}

function mensagem(id, texto, tipo) { const m = $(id); m.textContent = texto; m.className = 'msg' + (tipo ? ' ' + tipo : ''); }

// Monta a barra superior e devolve quem está logado.
async function iniciarTopo(ativa) {
  const eu = await api('/api/eu');
  const topo = el('header', 'topo');
  const marca = el('a', 'marca'); marca.href = eu.plataforma ? '/empresas.html' : '/';
  const logo = el('img', 'logo'); logo.src = '/logo-icone.png'; logo.alt = '';
  const nome = el('span', '', 'Shop Sei'); nome.append(el('small', '', 'Monitoramento'));
  marca.append(logo, nome);
  const nav = el('nav');
  // O dono do sistema cuida das empresas; quem é de uma empresa, da operação dela.
  const links = eu.plataforma
    ? [['/empresas.html', 'Empresas', 'empresas'], ['/usuarios.html', 'Donos do sistema', 'usuarios']]
    : [['/', 'Fila', 'fila'], ['/portaria.html', 'Portaria', 'portaria'], ['/historico.html', 'Histórico', 'historico']];
  if (!eu.plataforma && eu.papel === 'admin') links.push(['/clientes.html', 'Clientes', 'clientes'], ['/condominios.html', 'Condomínios', 'condominios'], ['/usuarios.html', 'Usuários', 'usuarios']);
  for (const [href, texto, chave] of links) { const a = el('a', chave === ativa ? 'ativo' : '', texto); a.href = href; nav.append(a); }
  const quem = el('div', 'usuario');
  const papel = eu.plataforma ? 'Plataforma' : eu.papel === 'admin' ? 'Administrador' : 'Operador';
  quem.append(el('span', 'nome', eu.nome || 'Serviço'));
  if (eu.empresa) quem.append(el('span', 'empresa', eu.empresa.nome));
  quem.append(el('span', 'papel', papel));
  if (eu.login) {
    const senha = el('button', 'sutil', 'Senha');
    senha.onclick = trocarSenha;
    quem.append(senha);
  }
  const sair = el('button', 'sutil', 'Sair');
  sair.onclick = async () => { try { await api('/api/logout', { method: 'POST', body: '{}' }); } finally { location.href = '/login.html'; } };
  quem.append(sair);
  topo.append(marca, nav, quem);
  document.body.prepend(topo);
  // Em qualquer tela da operação o disparo precisa chamar a atenção. A Fila já busca as ocorrências e avisa sozinha.
  if (eu.empresa && ativa !== 'fila') {
    const vigiar = async () => { try { atualizarAlarme(await api('/api/ocorrencias'), eu); } catch { /* tenta de novo na próxima volta */ } };
    vigiar(); setInterval(vigiar, 3000);
  }
  return eu;
}

// Alarme de disparo: faixa vermelha piscando e sirene até um operador ficar ciente. Toca enquanto houver disparo
// esperando operador, ou disparo entregue a você que você ainda não marcou como ciente.
const alarme = { ctx: null, nos: null, faixa: null, titulo: document.title, pisca: null, avisadas: new Set() };

function sirene(ligar) {
  if (!ligar) {
    if (alarme.nos) { try { alarme.nos.forEach((n) => n.stop()); } catch { /* já parou */ } alarme.nos = null; }
    return;
  }
  try {
    alarme.ctx = alarme.ctx || new (window.AudioContext || window.webkitAudioContext)();
    if (alarme.ctx.state === 'suspended') alarme.ctx.resume().catch(() => {});
    if (alarme.nos) return;
    // Sirene de dois tons subindo e descendo (oscilador modulado por outro mais lento).
    const ctx = alarme.ctx; const tom = ctx.createOscillator(); const volume = ctx.createGain(); const onda = ctx.createOscillator(); const largura = ctx.createGain();
    tom.type = 'sawtooth'; tom.frequency.value = 900; volume.gain.value = 0.16;
    onda.type = 'triangle'; onda.frequency.value = 0.9; largura.gain.value = 380;
    onda.connect(largura); largura.connect(tom.frequency); tom.connect(volume); volume.connect(ctx.destination);
    tom.start(); onda.start(); alarme.nos = [tom, onda];
  } catch { /* navegador sem áudio */ }
}

// O navegador só libera o som depois de um clique ou tecla na página.
for (const ev of ['click', 'keydown', 'touchstart']) {
  document.addEventListener(ev, () => { if (alarme.ctx && alarme.ctx.state === 'suspended') alarme.ctx.resume().catch(() => {}); }, { capture: true });
}

function emAlarme(lista, eu) {
  return lista.filter((o) => o.alarme && (o.situacao === 'aguardando'
    || (o.situacao === 'em_atendimento' && o.operador === eu.nome && !o.acoes.some((a) => a.operador === eu.nome))));
}

function atualizarAlarme(lista, eu, aoCiente, aoFicarDisponivel) {
  const ativos = emAlarme(lista, eu).sort((a, b) => a.prioridade - b.prioridade || a.abertaEm.localeCompare(b.abertaEm));
  document.body.classList.toggle('em-alarme', ativos.length > 0);
  sirene(ativos.length > 0);
  if (!ativos.length) {
    if (alarme.faixa) { alarme.faixa.remove(); alarme.faixa = null; }
    if (alarme.pisca) { clearInterval(alarme.pisca); alarme.pisca = null; document.title = alarme.titulo; }
    return;
  }
  if (!alarme.pisca) { let liga = false; alarme.pisca = setInterval(() => { liga = !liga; document.title = liga ? '🚨 DISPARO' : alarme.titulo; }, 800); }
  for (const o of ativos) {
    if (alarme.avisadas.has(o.id)) continue;
    alarme.avisadas.add(o.id);
    if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
      try { new Notification('🚨 Disparo · Conta ' + o.conta, { body: (o.cliente ? o.cliente.nome + ' · ' : '') + o.resumo, tag: 'ocorrencia-' + o.id, requireInteraction: true }); } catch { /* sem notificação */ }
    }
  }
  if (!alarme.faixa) { alarme.faixa = el('div', 'alarme-faixa'); alarme.faixa.setAttribute('role', 'alert'); document.querySelector('.topo').after(alarme.faixa); }
  const o = ativos[0];
  const texto = el('div', 'alarme-texto');
  texto.append(el('strong', '', ativos.length > 1 ? '🚨 ' + ativos.length + ' DISPAROS' : '🚨 DISPARO'),
    el('span', '', 'Conta ' + o.conta + (o.cliente ? ' · ' + o.cliente.nome : '') + ' · ' + o.resumo + ' · ' + haQuanto(o.abertaEm)));
  const botoes = el('div', 'alarme-botoes');
  if (alarme.ctx && alarme.ctx.state !== 'running') {
    const som = el('button', '', '🔊 Ligar o som do alarme'); som.onclick = () => alarme.ctx.resume().catch(() => {}); botoes.append(som);
  }
  const meu = ativos.find((x) => x.situacao === 'em_atendimento');
  if (meu && aoCiente) {
    const ciente = el('button', 'forte', 'Ciente, estou atendendo a conta ' + meu.conta);
    ciente.onclick = () => aoCiente(meu); botoes.append(ciente);
  } else if (!aoCiente) {
    const ir = el('a', 'botao forte', 'Ir para a fila'); ir.href = '/'; botoes.append(ir);
  } else if (aoFicarDisponivel) {
    const disp = el('button', 'forte', 'Ficar disponível e atender'); disp.onclick = aoFicarDisponivel; botoes.append(disp);
  } else {
    botoes.append(el('span', '', 'Esperando um operador disponível'));
  }
  alarme.faixa.replaceChildren(texto, botoes);
}

function trocarSenha() {
  const dlg = el('dialog');
  const form = el('form');
  form.method = 'dialog';
  form.append(el('h3', '', 'Trocar minha senha'), el('p', 'mute', 'A nova senha precisa ter ao menos 8 caracteres.'));
  const campo = (rotulo, auto) => { const l = el('label', '', rotulo); const i = el('input'); i.type = 'password'; i.required = true; i.autocomplete = auto; l.append(i); form.append(l); return i; };
  const atual = campo('Senha atual', 'current-password');
  const nova = campo('Nova senha', 'new-password');
  const erro = el('div', 'msg erro');
  const botoes = el('div', 'botoes');
  const cancelar = el('button', '', 'Cancelar'); cancelar.type = 'button'; cancelar.onclick = () => dlg.close();
  const ok = el('button', 'marca-btn', 'Salvar'); ok.type = 'submit';
  botoes.append(cancelar, ok);
  form.append(erro, botoes);
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    try { await api('/api/senha', { method: 'POST', body: JSON.stringify({ atual: atual.value, nova: nova.value }) }); dlg.close(); toast('Senha alterada'); } catch (e) { erro.textContent = e.message; }
  };
  dlg.addEventListener('close', () => dlg.remove());
  dlg.append(form);
  document.body.append(dlg);
  dlg.showModal();
}
