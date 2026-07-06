-- migration 0011 — compiled knowledge graph (ADR-0099, P-KB.1)
--
-- FROZEN once applied (invariant #10). Its OWN migration set (harness/kb/migrations) applied to a
-- SEPARATE kb_graph.duckdb, a SIBLING to the vector store (harness/knowledge, 0010_knowledge_vectors)
-- and independent of agent_obs.duckdb — a workspace may use the compiled KB, the vector KB, or both
-- (ADR-0100 routes). The leading number continues the project's global migration numbering after 0010.
--
-- This is the OpenKB "compiled wiki" as a page graph: an LLM compiles source documents into first-class
-- summary/concept/entity pages joined by cross-reference links, with a provenance trail and an
-- append-only changelog. SECURITY (invariant #3, keystone #2): every source is scan-gated BEFORE
-- compilation, and every model-generated page body is re-scanned BEFORE it is stored; a flagged source or
-- page is quarantined, never compiled/stored. A stored derived page is `untrusted`, NEVER auto-`trusted`.
--
-- kb_documents: the source registry. classification U|CUI (ADR-0012); status compiled|quarantined|stale;
--   sha256 makes re-ingest idempotent-ish and lets the changelog reference an exact source version.
-- kb_pages: the compiled wiki — first-class pages. kind summary|concept|entity|source. No single-document
--   FK: a concept/entity page synthesizes ACROSS documents, so provenance lives in kb_page_sources.
-- kb_links: cross-references (wikilinks). Deliberately the personal-KG PersonalLink shape so the ADR-0075
--   graph renderer can draw it. relation defaults to 'related'.
-- kb_page_sources: the citation trail — which document(s) (and where) a page was compiled from.
-- kb_changelog: append-only "kept in sync" log — what each (re)compilation added/flagged (auditable).
-- kb_page_embeddings: OPTIONAL hybrid — page-body vectors reusing the Embedder seam so retrieval can be
--   structural OR vector OR both (ADR-0100). Populated by a later increment; the table is frozen now.

CREATE TABLE kb_documents (
  document_id    VARCHAR PRIMARY KEY,
  source_path    VARCHAR NOT NULL,
  title          VARCHAR NOT NULL,
  sha256         VARCHAR NOT NULL,       -- of the source text, for idempotent re-ingest
  classification VARCHAR NOT NULL,       -- 'U' | 'CUI'
  trust_label    VARCHAR NOT NULL,       -- the source's scan verdict
  status         VARCHAR NOT NULL,       -- 'compiled' | 'quarantined' | 'stale'
  ingested_at    TIMESTAMP NOT NULL
);

CREATE TABLE kb_pages (
  page_id        VARCHAR PRIMARY KEY,
  kind           VARCHAR NOT NULL,       -- 'summary' | 'concept' | 'entity' | 'source'
  slug           VARCHAR NOT NULL,       -- kebab id, unique per compilation run
  title          VARCHAR NOT NULL,
  body_md        VARCHAR NOT NULL,       -- the compiled page markdown (re-scanned clean before store)
  trust_label    VARCHAR NOT NULL,       -- 'untrusted' for a fresh derived page (keystone #2: never auto-trusted)
  classification VARCHAR NOT NULL,       -- inherits the source compartment
  created_at     TIMESTAMP NOT NULL,
  updated_at     TIMESTAMP NOT NULL
);

CREATE TABLE kb_links (
  link_id      VARCHAR PRIMARY KEY,
  from_page_id VARCHAR NOT NULL REFERENCES kb_pages(page_id),
  to_page_id   VARCHAR NOT NULL REFERENCES kb_pages(page_id),
  relation     VARCHAR NOT NULL,         -- default 'related'
  created_at   TIMESTAMP NOT NULL
);

CREATE TABLE kb_page_sources (
  source_id   VARCHAR PRIMARY KEY,
  page_id     VARCHAR NOT NULL REFERENCES kb_pages(page_id),
  document_id VARCHAR NOT NULL REFERENCES kb_documents(document_id),
  ordinal     INTEGER NOT NULL,          -- position/citation order within the page's sources
  quote       VARCHAR                    -- optional supporting excerpt (scanned as part of the source)
);

CREATE TABLE kb_changelog (
  change_id   VARCHAR PRIMARY KEY,
  document_id VARCHAR REFERENCES kb_documents(document_id), -- nullable: a graph-wide entry has none
  action      VARCHAR NOT NULL,          -- 'ingested' | 'compiled' | 'page_added' | 'page_flagged' | 'quarantined'
  detail      VARCHAR NOT NULL,
  created_at  TIMESTAMP NOT NULL
);

CREATE TABLE kb_page_embeddings (
  page_id    VARCHAR PRIMARY KEY REFERENCES kb_pages(page_id),
  model      VARCHAR NOT NULL,
  dim        INTEGER NOT NULL,
  embedding  FLOAT[] NOT NULL,
  created_at TIMESTAMP NOT NULL
);

CREATE INDEX idx_kb_pages_kind ON kb_pages(kind);
CREATE INDEX idx_kb_pages_slug ON kb_pages(slug);
CREATE INDEX idx_kb_links_from ON kb_links(from_page_id);
CREATE INDEX idx_kb_page_sources_page ON kb_page_sources(page_id);
CREATE INDEX idx_kb_changelog_doc ON kb_changelog(document_id);
