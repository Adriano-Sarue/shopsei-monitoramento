-- Esquema inicial (PostgreSQL). Cadastros, eventos e fila de ocorrências.

CREATE TABLE clientes (
  id            BIGSERIAL PRIMARY KEY,
  nome          TEXT NOT NULL,
  endereco      TEXT,
  observacoes   TEXT,
  tipo          TEXT,
  -- Conferidas pelo operador ao atender (palavra-chave e contra-senha do cliente).
  palavra_chave TEXT,
  contra_senha  TEXT,
  ativo         BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Uma conta é o número que a central envia nos eventos.
CREATE TABLE contas (
  id            BIGSERIAL PRIMARY KEY,
  cliente_id    BIGINT NOT NULL REFERENCES clientes(id),
  numero        TEXT NOT NULL UNIQUE,
  chave_aes     TEXT,
  ativa         BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE contatos (
  id            BIGSERIAL PRIMARY KEY,
  cliente_id    BIGINT NOT NULL REFERENCES clientes(id),
  nome          TEXT NOT NULL,
  telefone      TEXT,
  ordem         INT NOT NULL DEFAULT 1,
  senha         TEXT,
  contrassenha  TEXT
);

CREATE TABLE operadores (
  id            BIGSERIAL PRIMARY KEY,
  nome          TEXT NOT NULL,
  disponivel    BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE eventos (
  id            BIGSERIAL PRIMARY KEY,
  recebido_em   TIMESTAMPTZ NOT NULL,
  protocolo     TEXT NOT NULL,
  conta         TEXT NOT NULL,
  codigo        TEXT NOT NULL,
  qualificador  TEXT,
  particao      TEXT,
  zona_usuario  TEXT,
  descricao     TEXT NOT NULL,
  categoria     TEXT NOT NULL,
  prioridade    INT NOT NULL,
  bruto         TEXT NOT NULL
);
CREATE INDEX eventos_conta_idx ON eventos (conta, recebido_em DESC);

CREATE TYPE situacao_ocorrencia AS ENUM ('aguardando', 'pendente', 'em_atendimento', 'encerrada');

CREATE TABLE ocorrencias (
  id            BIGSERIAL PRIMARY KEY,
  conta         TEXT NOT NULL,
  conta_cadastrada BOOLEAN NOT NULL,
  prioridade    INT NOT NULL,
  situacao      situacao_ocorrencia NOT NULL DEFAULT 'aguardando',
  operador_id   BIGINT REFERENCES operadores(id),
  aberta_em     TIMESTAMPTZ NOT NULL DEFAULT now(),
  atendida_em   TIMESTAMPTZ,
  encerrada_em  TIMESTAMPTZ,
  motivo_encerramento TEXT,
  conclusao     TEXT,
  adiada_ate    TIMESTAMPTZ
);
CREATE INDEX ocorrencias_fila_idx ON ocorrencias (situacao, prioridade, aberta_em);

CREATE TABLE ocorrencia_eventos (
  ocorrencia_id BIGINT NOT NULL REFERENCES ocorrencias(id),
  evento_id     BIGINT NOT NULL REFERENCES eventos(id),
  PRIMARY KEY (ocorrencia_id, evento_id)
);

CREATE TABLE ocorrencia_acoes (
  id            BIGSERIAL PRIMARY KEY,
  ocorrencia_id BIGINT NOT NULL REFERENCES ocorrencias(id),
  operador_id   BIGINT REFERENCES operadores(id),
  em            TIMESTAMPTZ NOT NULL DEFAULT now(),
  descricao     TEXT NOT NULL
);
