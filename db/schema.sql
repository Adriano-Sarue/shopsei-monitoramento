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
