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
  const marca = el('a', 'marca'); marca.href = '/';
  const logo = el('span', 'logo', 'S');
  const nome = el('span', '', 'Shop Sei'); nome.append(el('small', '', 'Monitoramento'));
  marca.append(logo, nome);
  const nav = el('nav');
  const links = [['/', 'Fila', 'fila']];
  if (eu.papel === 'admin') links.push(['/clientes.html', 'Clientes', 'clientes'], ['/usuarios.html', 'Usuários', 'usuarios']);
  for (const [href, texto, chave] of links) { const a = el('a', chave === ativa ? 'ativo' : '', texto); a.href = href; nav.append(a); }
  const quem = el('div', 'usuario');
  quem.append(el('span', 'nome', eu.nome || 'Serviço'), el('span', 'papel', eu.papel === 'admin' ? 'Administrador' : 'Operador'));
  const sair = el('button', 'sutil', 'Sair');
  sair.onclick = async () => { try { await api('/api/logout', { method: 'POST', body: '{}' }); } finally { location.href = '/login.html'; } };
  quem.append(sair);
  topo.append(marca, nav, quem);
  document.body.prepend(topo);
  return eu;
}
