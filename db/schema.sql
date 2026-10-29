-- Esquema (PostgreSQL). Idempotente: pode ser aplicado a cada inicialização.

CREATE TABLE IF NOT EXISTS clientes (
  id            BIGSERIAL PRIMARY KEY,
  nome          TEXT NOT NULL,
  endereco      TEXT,
  tipo          TEXT,
  observacoes   TEXT,
  -- Conferidas pelo operador ao atender (palavra-chave e contra-senha do cliente).
  palavra_chave TEXT,
  contra_senha  TEXT,
  ativo         BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Uma conta é o número que a central envia nos eventos (ex.: 0013).
CREATE TABLE IF NOT EXISTS contas (
  numero        TEXT PRIMARY KEY,
  cliente_id    BIGINT NOT NULL REFERENCES clientes(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS contas_cliente_idx ON contas (cliente_id);

-- Pessoas a acionar, em ordem (providências).
CREATE TABLE IF NOT EXISTS contatos (
  id            BIGSERIAL PRIMARY KEY,
  cliente_id    BIGINT NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  nome          TEXT NOT NULL,
  telefone      TEXT,
  ordem         INT NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS contatos_cliente_idx ON contatos (cliente_id, ordem);

-- Histórico de tudo que chegou, já decodificado.
CREATE TABLE IF NOT EXISTS eventos (
  id            BIGSERIAL PRIMARY KEY,
  recebido_em   TIMESTAMPTZ NOT NULL,
  conta         TEXT NOT NULL,
  codigo        TEXT NOT NULL,
  protocolo     TEXT NOT NULL,
  payload       JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS eventos_conta_idx ON eventos (conta, recebido_em DESC);

-- Ocorrências: o estado vivo da fila. Eventos e ações ficam em JSONB junto da ocorrência.
CREATE TABLE IF NOT EXISTS ocorrencias (
  id               BIGINT PRIMARY KEY,
  conta            TEXT NOT NULL,
  conta_cadastrada BOOLEAN NOT NULL,
  prioridade       INT NOT NULL,
  situacao         TEXT NOT NULL CHECK (situacao IN ('aguardando', 'pendente', 'em_atendimento', 'encerrada')),
  operador         TEXT,
  aberta_em        TIMESTAMPTZ NOT NULL,
  atendida_em      TIMESTAMPTZ,
  encerrada_em     TIMESTAMPTZ,
  adiada_ate       TIMESTAMPTZ,
  motivo           TEXT,
  conclusao        TEXT,
  eventos          JSONB NOT NULL DEFAULT '[]',
  acoes            JSONB NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS ocorrencias_situacao_idx ON ocorrencias (situacao, prioridade, aberta_em);
CREATE INDEX IF NOT EXISTS ocorrencias_conta_idx ON ocorrencias (conta, aberta_em DESC);

-- Quem entra no sistema. A senha é guardada só como hash (scrypt).
CREATE TABLE IF NOT EXISTS usuarios (
  id          BIGSERIAL PRIMARY KEY,
  login       TEXT NOT NULL UNIQUE,
  nome        TEXT NOT NULL,
  papel       TEXT NOT NULL CHECK (papel IN ('operador', 'admin')),
  senha_hash  TEXT NOT NULL,
  ativo       BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Câmeras do cliente (links que o operador abre ao atender um disparo).
CREATE TABLE IF NOT EXISTS cameras (
  id          BIGSERIAL PRIMARY KEY,
  cliente_id  BIGINT NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  nome        TEXT NOT NULL,
  marca       TEXT,
  url         TEXT NOT NULL,
  ordem       INT NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS cameras_cliente_idx ON cameras (cliente_id, ordem);

-- Colunas acrescentadas depois da primeira versão (ADD COLUMN IF NOT EXISTS mantém o esquema idempotente).
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS instrucoes TEXT;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS intervalo_teste_horas INT CHECK (intervalo_teste_horas BETWEEN 1 AND 720);

-- ===== Multiempresa =====
-- Cada empresa compradora tem seus clientes, contas, usuários, eventos e ocorrências. Bancos criados antes
-- disso ganham a empresa 1 e todos os dados existentes passam a ser dela.
CREATE TABLE IF NOT EXISTS empresas (
  id          BIGSERIAL PRIMARY KEY,
  nome        TEXT NOT NULL,
  ativo       BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em   TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO empresas (id, nome) SELECT 1, 'Shop Sei'
  WHERE NOT EXISTS (SELECT 1 FROM empresas) AND (EXISTS (SELECT 1 FROM clientes) OR EXISTS (SELECT 1 FROM usuarios) OR EXISTS (SELECT 1 FROM ocorrencias));
SELECT setval(pg_get_serial_sequence('empresas', 'id'), GREATEST((SELECT COALESCE(max(id), 0) FROM empresas), 1), (SELECT count(*) > 0 FROM empresas));

-- Por onde chegam os eventos de cada empresa ("*" = qualquer número). Uma rota é de uma empresa só.
CREATE TABLE IF NOT EXISTS rotas (
  empresa_id  BIGINT NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  canal       TEXT NOT NULL CHECK (canal IN ('surgard', 'dc09')),
  receptora   TEXT NOT NULL,
  linha       TEXT NOT NULL,
  PRIMARY KEY (canal, receptora, linha)
);

DO $$
DECLARE t TEXT;
BEGIN
  -- empresa_id nas tabelas antigas: entra com 1 para os dados que já existem e depois fica sem padrão,
  -- para nenhum dado novo cair numa empresa por esquecimento.
  FOREACH t IN ARRAY ARRAY['clientes', 'usuarios', 'contas', 'ocorrencias', 'eventos'] LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = t AND column_name = 'empresa_id') THEN
      IF EXISTS (SELECT 1 FROM empresas WHERE id = 1) THEN
        EXECUTE format('ALTER TABLE %I ADD COLUMN empresa_id BIGINT REFERENCES empresas(id) DEFAULT 1', t);
        EXECUTE format('ALTER TABLE %I ALTER COLUMN empresa_id DROP DEFAULT', t);
      ELSE
        EXECUTE format('ALTER TABLE %I ADD COLUMN empresa_id BIGINT REFERENCES empresas(id)', t);
      END IF;
    END IF;
  END LOOP;
  -- Usuário sem empresa só o dono do sistema; eventos sem empresa são os que nenhuma rota reconheceu.
  ALTER TABLE clientes ALTER COLUMN empresa_id SET NOT NULL;
  ALTER TABLE contas ALTER COLUMN empresa_id SET NOT NULL;
  ALTER TABLE ocorrencias ALTER COLUMN empresa_id SET NOT NULL;
  -- A mesma conta pode existir em empresas diferentes.
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contas_pkey' AND array_length(conkey, 1) = 1) THEN
    ALTER TABLE contas DROP CONSTRAINT contas_pkey;
    ALTER TABLE contas ADD PRIMARY KEY (empresa_id, numero);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS clientes_empresa_idx ON clientes (empresa_id, nome);
CREATE INDEX IF NOT EXISTS usuarios_empresa_idx ON usuarios (empresa_id);
CREATE INDEX IF NOT EXISTS ocorrencias_empresa_idx ON ocorrencias (empresa_id, situacao, encerrada_em DESC);
CREATE INDEX IF NOT EXISTS eventos_empresa_idx ON eventos (empresa_id, conta, recebido_em DESC);

-- ---- Portaria remota: condomínios, unidades com quem mora/pode entrar, e o registro de cada atendimento.
CREATE TABLE IF NOT EXISTS condominios (
  id BIGSERIAL PRIMARY KEY,
  empresa_id BIGINT NOT NULL REFERENCES empresas(id),
  nome TEXT NOT NULL,
  endereco TEXT,
  instrucoes TEXT,
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS condominios_empresa_idx ON condominios (empresa_id, nome);

-- Pessoas da unidade em JSON: são lidas e gravadas sempre junto com a unidade.
CREATE TABLE IF NOT EXISTS unidades (
  id BIGSERIAL PRIMARY KEY,
  condominio_id BIGINT NOT NULL REFERENCES condominios(id) ON DELETE CASCADE,
  bloco TEXT NOT NULL DEFAULT '',
  numero TEXT NOT NULL,
  observacao TEXT,
  pessoas JSONB NOT NULL DEFAULT '[]',
  UNIQUE (condominio_id, bloco, numero)
);

CREATE TABLE IF NOT EXISTS atendimentos_portaria (
  id BIGSERIAL PRIMARY KEY,
  empresa_id BIGINT NOT NULL REFERENCES empresas(id),
  condominio_id BIGINT NOT NULL REFERENCES condominios(id),
  unidade_id BIGINT REFERENCES unidades(id) ON DELETE SET NULL,
  -- Cópia do bloco/número no momento do atendimento: o histórico continua legível se a unidade for apagada.
  unidade TEXT,
  em TIMESTAMPTZ NOT NULL,
  operador TEXT NOT NULL,
  tipo TEXT NOT NULL,
  visitante TEXT NOT NULL,
  documento TEXT,
  decisao TEXT NOT NULL,
  autorizado_por TEXT,
  observacao TEXT
);
CREATE INDEX IF NOT EXISTS atendimentos_portaria_idx ON atendimentos_portaria (empresa_id, condominio_id, em DESC);

-- Leitores faciais e interfones do condomínio (alcançados pela VPN). A senha fica cifrada (CHAVE_EQUIPAMENTOS).
CREATE TABLE IF NOT EXISTS equipamentos_portaria (
  id BIGSERIAL PRIMARY KEY,
  empresa_id BIGINT NOT NULL REFERENCES empresas(id),
  condominio_id BIGINT NOT NULL REFERENCES condominios(id) ON DELETE CASCADE,
  nome TEXT NOT NULL,
  marca TEXT NOT NULL,
  endereco TEXT NOT NULL,
  usuario TEXT NOT NULL,
  senha_cifrada TEXT NOT NULL,
  porta INTEGER NOT NULL DEFAULT 1,
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  token_eventos TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS equipamentos_portaria_cond_idx ON equipamentos_portaria (condominio_id);

-- Toda porta aberta pela tela do operador, com quem abriu e se o equipamento aceitou.
CREATE TABLE IF NOT EXISTS aberturas_porta (
  id BIGSERIAL PRIMARY KEY,
  empresa_id BIGINT NOT NULL REFERENCES empresas(id),
  condominio_id BIGINT NOT NULL REFERENCES condominios(id),
  equipamento_id BIGINT REFERENCES equipamentos_portaria(id) ON DELETE SET NULL,
  em TIMESTAMPTZ NOT NULL,
  operador TEXT NOT NULL,
  ok BOOLEAN NOT NULL,
  erro TEXT
);
CREATE INDEX IF NOT EXISTS aberturas_porta_idx ON aberturas_porta (empresa_id, condominio_id, em DESC);

-- Regras da fila de cada empresa (tela Configurações).
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS ajustes JSONB NOT NULL DEFAULT '{}';
