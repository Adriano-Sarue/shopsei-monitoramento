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
  if (!eu.plataforma && eu.papel === 'admin') links.push(['/clientes.html', 'Clientes', 'clientes'], ['/condominios.html', 'Condomínios', 'condominios'], ['/usuarios.html', 'Usuários', 'usuarios'], ['/configuracoes.html', 'Configurações', 'configuracoes']);
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
  if (eu.login && eu.empresa) {
    const turno = el('button', 'sutil', 'Trocar de turno');
    turno.onclick = () => trocarTurno(eu);
    quem.append(turno);
  }
  const sair = el('button', 'sutil', 'Sair');
  sair.onclick = async () => { try { await api('/api/logout', { method: 'POST', body: '{}' }); } finally { location.href = '/login.html'; } };
  quem.append(sair);
  topo.append(marca, nav, quem);
  if (eu.travada) trocarTurno(eu, true);
  try { const t = sessionStorage.getItem('turno'); if (t) { sessionStorage.removeItem('turno'); setTimeout(() => toast(t), 300); } } catch { /* sem armazenamento */ }
  document.body.prepend(topo);
  // Em qualquer tela da operação o disparo precisa chamar a atenção. A Fila já busca as ocorrências e avisa sozinha.
  if (eu.empresa && ativa !== 'fila') {
    const vigiar = async () => { try { atualizarAlarme(await api('/api/ocorrencias'), eu); } catch { /* tenta de novo na próxima volta */ } };
    vigiar(); setInterval(vigiar, 3000);
  }
  return eu;
}

// Alarme de disparo: pop-up, faixa vermelha piscando e sirene até um operador ficar ciente. Toca enquanto houver disparo
// esperando operador, ou disparo entregue a você que você ainda não marcou como ciente.
const alarme = { ctx: null, nos: null, faixa: null, titulo: document.title, pisca: null, avisadas: new Set(), popup: null, chave: '', minimizadas: new Set(), travada: false };

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

// Câmera do cliente numa janela pop-up própria (separada do sistema), ao lado da janela principal.
// Só abre dentro de um clique: fora dele o navegador bloqueia a janela.
function abrirCamera(cam, n = 0) {
  const w = Math.min(960, screen.availWidth - 40), h = Math.min(600, screen.availHeight - 80);
  const x = Math.max(0, (window.screenX || 0) + (window.outerWidth || w) - w - 20 - n * 30), y = Math.max(0, (window.screenY || 0) + 80 + n * 30);
  const jan = window.open(cam.url, 'camera-' + n, 'popup=yes,width=' + w + ',height=' + h + ',left=' + x + ',top=' + y);
  if (jan) { try { jan.opener = null; jan.focus(); } catch { /* outra origem */ } }
  return !!jan;
}

// Aviso da própria base (internet da empresa ou ponte do Active Net), não de um cliente.
const CONTA_BASE = 'BASE';
function rotuloConta(o) { return o.conta === CONTA_BASE ? 'Base da empresa' : 'Conta ' + o.conta + (o.cliente ? ' · ' + o.cliente.nome : ''); }

function tipoDisparo(o) { return /p[aâ]nico|coa[cç][aã]o/i.test(o.resumo) ? '🆘 PÂNICO' : '🚨 DISPARO'; }

function botoesAlarme(ativos, aoCiente, aoFicarDisponivel) {
  const botoes = [];
  if (alarme.ctx && alarme.ctx.state !== 'running') {
    const som = el('button', '', '🔊 Ligar o som do alarme'); som.onclick = () => alarme.ctx.resume().catch(() => {}); botoes.push(som);
  }
  const meu = ativos.find((x) => x.situacao === 'em_atendimento');
  if (meu && aoCiente) {
    const ciente = el('button', 'forte', 'Ciente, estou atendendo a conta ' + meu.conta);
    ciente.onclick = () => aoCiente(meu); botoes.push(ciente);
  } else if (!aoCiente) {
    const ir = el('a', 'botao forte', 'Ir para a fila'); ir.href = '/'; botoes.push(ir);
  } else if (aoFicarDisponivel) {
    const disp = el('button', 'forte', 'Ficar disponível e atender'); disp.onclick = aoFicarDisponivel; botoes.push(disp);
  } else {
    botoes.push(el('span', '', 'Esperando um operador disponível'));
  }
  return botoes;
}

// Pop-up no meio da tela com o disparo ou pânico. Some no "Ciente"; "Minimizar" deixa só a faixa e a sirene,
// e o pop-up volta se chegar outro disparo.
function popupAlarme(ativos, aoCiente, aoFicarDisponivel) {
  const novos = ativos.filter((o) => !alarme.minimizadas.has(o.id));
  if (!novos.length) { if (alarme.popup) { alarme.popup.close(); alarme.popup.remove(); alarme.popup = null; alarme.chave = ''; } return; }
  const o = novos.find((x) => x.situacao === 'em_atendimento') || novos[0];
  const chave = ativos.map((x) => x.id + x.situacao).join() + '|' + o.id + '|' + (alarme.ctx ? alarme.ctx.state : '');
  if (alarme.popup && alarme.chave === chave) return;
  alarme.chave = chave;
  if (!alarme.popup) {
    alarme.popup = el('dialog', 'alarme-popup'); alarme.popup.setAttribute('role', 'alertdialog');
    alarme.popup.addEventListener('cancel', (ev) => { ev.preventDefault(); minimizar(); });
    document.body.append(alarme.popup);
  }
  function minimizar() { for (const x of ativos) alarme.minimizadas.add(x.id); alarme.popup.close(); alarme.popup.remove(); alarme.popup = null; alarme.chave = ''; }
  const topo = el('div', 'alarme-popup-topo');
  topo.append(el('strong', '', tipoDisparo(o)), el('span', '', haQuanto(o.abertaEm)));
  const corpo = el('div', 'alarme-popup-corpo');
  if (o.conta === CONTA_BASE) corpo.append(el('div', 'alarme-popup-cliente', 'Base da empresa'), el('div', 'alarme-popup-conta', 'Internet da base ou ponte do Active Net'));
  else corpo.append(el('div', 'alarme-popup-cliente', o.cliente ? o.cliente.nome : 'Conta não cadastrada'), el('div', 'alarme-popup-conta', 'Conta ' + o.conta + (o.cliente && o.cliente.tipo ? ' · ' + o.cliente.tipo : '')));
  if (o.cliente && o.cliente.endereco) corpo.append(el('div', 'mute', o.cliente.endereco));
  corpo.append(el('div', 'alarme-popup-evento', o.resumo));
  const cams = (o.cliente && o.cliente.cameras) || [];
  if (cams.length) {
    const lista = el('div', 'cameras');
    cams.forEach((cam, i) => { const b = el('button', 'mini', '📹 ' + cam.nome); b.type = 'button'; b.onclick = () => abrirCamera(cam, i); lista.append(b); });
    corpo.append(lista);
  }
  if (ativos.length > 1) corpo.append(el('div', 'aviso', 'Mais ' + (ativos.length - 1) + (ativos.length > 2 ? ' alarmes' : ' alarme') + ' na fila'));
  const botoes = el('div', 'alarme-botoes');
  const min = el('button', 'discreto', 'Minimizar'); min.type = 'button'; min.onclick = minimizar;
  botoes.append(...botoesAlarme([o, ...ativos.filter((x) => x !== o)], aoCiente, aoFicarDisponivel), min);
  alarme.popup.replaceChildren(topo, corpo, botoes);
  if (!alarme.popup.open) { try { alarme.popup.showModal(); } catch { alarme.popup.show(); } }
}

function atualizarAlarme(lista, eu, aoCiente, aoFicarDisponivel) {
  const ativos = emAlarme(lista, eu).sort((a, b) => a.prioridade - b.prioridade || a.abertaEm.localeCompare(b.abertaEm));
  document.body.classList.toggle('em-alarme', ativos.length > 0);
  sirene(ativos.length > 0);
  popupAlarme(alarme.travada ? [] : ativos, aoCiente, aoFicarDisponivel);
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
      try { new Notification(tipoDisparo(o) + ' · Conta ' + o.conta, { body: (o.cliente ? o.cliente.nome + ' · ' : '') + o.resumo, tag: 'ocorrencia-' + o.id, requireInteraction: true }); } catch { /* sem notificação */ }
    }
  }
  if (!alarme.faixa) { alarme.faixa = el('div', 'alarme-faixa'); alarme.faixa.setAttribute('role', 'alert'); document.querySelector('.topo').after(alarme.faixa); }
  const o = ativos[0];
  const texto = el('div', 'alarme-texto');
  texto.append(el('strong', '', ativos.length > 1 ? '🚨 ' + ativos.length + ' ALARMES' : tipoDisparo(o)),
    el('span', '', rotuloConta(o) + ' · ' + o.resumo + ' · ' + haQuanto(o.abertaEm)));
  const botoes = el('div', 'alarme-botoes');
  botoes.append(...botoesAlarme(ativos, aoCiente, aoFicarDisponivel));
  alarme.faixa.replaceChildren(texto, botoes);
}

// Troca de turno: quem sai escolhe quem entra; quem entra digita só a própria senha. Os chamados em
// atendimento passam direto para quem entra, sem voltar para a fila. Ao abrir, a tela trava (no servidor,
// então recarregar não destrava): para cancelar, só com a senha de quem estava.
async function trocarTurno(eu, jaTravada) {
  let info;
  try {
    if (!jaTravada) await api('/api/turno/iniciar', { method: 'POST', body: '{}' });
    info = await api('/api/turno');
  } catch (e) { toast(e.message); return; }
  alarme.travada = true; popupAlarme([]);
  const dlg = el('dialog', 'turno-travado');
  dlg.addEventListener('cancel', (ev) => ev.preventDefault());
  const form = el('form');
  form.append(el('h3', '', '🔒 Trocar de turno'));
  form.append(el('p', 'mute', 'A tela fica travada até alguém entrar no turno. ' + (info.comigo
    ? (info.comigo === 1 ? 'O chamado em atendimento com ' + eu.nome + ' passa' : 'Os ' + info.comigo + ' chamados em atendimento com ' + eu.nome + ' passam') + ' direto para quem entrar, com todo o histórico.'
    : eu.nome + ' não tem chamados em atendimento agora.')));
  const lq = el('label', '', 'Quem vai entrar');
  const quem = el('select'); quem.required = true; quem.id = 'turno-quem';
  quem.append(new Option('Escolha o operador…', ''));
  for (const c of info.colegas) quem.append(new Option(c.nome, String(c.id)));
  lq.append(quem); form.append(lq);
  const ls = el('label', '', 'Senha de quem vai entrar');
  const senha = el('input'); senha.type = 'password'; senha.required = true; senha.autocomplete = 'off'; senha.id = 'turno-senha';
  ls.append(senha); form.append(ls);
  const erro = el('div', 'msg erro');
  const botoes = el('div', 'botoes');
  const cancelar = el('button', '', 'Cancelar'); cancelar.type = 'button';
  const ok = el('button', 'marca-btn', 'Entrar no turno'); ok.type = 'submit';
  botoes.append(cancelar, ok);
  form.append(erro, botoes);
  form.onsubmit = async (ev) => {
    ev.preventDefault(); ok.disabled = true;
    try {
      const r = await api('/api/turno', { method: 'POST', body: JSON.stringify({ usuarioId: Number(quem.value), senha: senha.value }) });
      sessionStorage.setItem('turno', 'Turno com ' + r.nome + (r.passadas ? ' · ' + r.passadas + (r.passadas === 1 ? ' chamado passado' : ' chamados passados') : ''));
      location.reload();
    } catch (e) { erro.textContent = e.message; senha.value = ''; senha.focus(); ok.disabled = false; }
  };
  // Cancelar pede a senha de quem estava no turno.
  const sair = el('form'); sair.hidden = true;
  sair.append(el('h3', '', '🔒 Cancelar a troca de turno'), el('p', 'mute', 'Para destravar a tela, ' + eu.nome + ' digita a própria senha.'));
  const lv = el('label', '', 'Senha de ' + eu.nome);
  const minha = el('input'); minha.type = 'password'; minha.required = true; minha.autocomplete = 'current-password'; minha.id = 'turno-minha-senha';
  lv.append(minha); sair.append(lv);
  const erro2 = el('div', 'msg erro');
  const botoes2 = el('div', 'botoes');
  const voltar = el('button', '', 'Voltar'); voltar.type = 'button';
  const destravar = el('button', 'marca-btn', 'Destravar'); destravar.type = 'submit';
  botoes2.append(voltar, destravar);
  sair.append(erro2, botoes2);
  cancelar.onclick = () => { form.hidden = true; sair.hidden = false; erro2.textContent = ''; minha.value = ''; minha.focus(); };
  voltar.onclick = () => { sair.hidden = true; form.hidden = false; quem.focus(); };
  sair.onsubmit = async (ev) => {
    ev.preventDefault(); destravar.disabled = true;
    try {
      await api('/api/turno/cancelar', { method: 'POST', body: JSON.stringify({ senha: minha.value }) });
      alarme.travada = false; dlg.close(); toast('Troca de turno cancelada');
    } catch (e) { erro2.textContent = e.message; minha.value = ''; minha.focus(); destravar.disabled = false; }
  };
  dlg.addEventListener('close', () => dlg.remove());
  dlg.append(form, sair);
  document.body.append(dlg);
  dlg.showModal();
  quem.focus();
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
