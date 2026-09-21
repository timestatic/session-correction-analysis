import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { analyzeDocumentSchema, SCHEMA_ID, type AnalyzeDocument } from '../../../src/domain/documents.js';
import { ScaError } from '../../../src/domain/errors.js';
import { parseFrontmatterYaml, parseMarkdownDoc, renderDocument, splitFrontmatter } from '../../../src/store/frontmatter.js';
import { assertSingleNotesSection, composeBody, splitBody } from '../../../src/store/notes.js';

function sampleDoc(): AnalyzeDocument {
  return {
    schema: SCHEMA_ID,
    session_id: 'thr_123',
    session_title: '第四批联调测试-2',
    source: 'codex',
    workspace: '/work/dpp_v3',
    trigger: 'session_end',
    analysis_status: 'completed',
    analyzer_version: '0.1.0',
    revision: 3,
    created_at: '2026-09-19T14:30:00+08:00',
    analyzed_at: '2026-09-19T15:00:00+08:00',
    error: null,
  };
}

function expectSchemaInvalid(fn: () => unknown, fragment?: string): void {
  assert.throws(
    fn,
    (err: unknown) =>
      err instanceof ScaError &&
      err.code === 'schema_invalid' &&
      (fragment === undefined || err.message.includes(fragment)),
  );
}

describe('frontmatter round-trip', () => {
  it('renders and re-parses a full document without drift', () => {
    const doc = sampleDoc();
    const text = renderDocument(doc, '# Session 分析\n\n正文 中文 ✅\n');
    const parsed = parseMarkdownDoc(text, analyzeDocumentSchema);
    assert.deepEqual(parsed, doc);
  });

  it('keeps the body after the frontmatter block untouched', () => {
    const body = '# Session 分析\n\n- 多行\n- 内容\n';
    const text = renderDocument(sampleDoc(), body);
    assert.equal(splitFrontmatter(text).body, body);
  });

  it('rejects files without frontmatter', () => {
    expectSchemaInvalid(() => splitFrontmatter('# nothing\n'), 'frontmatter block');
  });

  it('rejects duplicate map keys', () => {
    expectSchemaInvalid(() => parseFrontmatterYaml('revision: 1\nrevision: 2\n'), 'unique');
  });

  it('rejects anchors and aliases', () => {
    expectSchemaInvalid(
      () => parseFrontmatterYaml('base: &b\n  a: 1\nother: *b\n'),
      'anchors',
    );
  });

  it('flags unknown schema ids as read-only rejections', () => {
    const text = `---\nschema: session-correction-analysis/v99\n---\nbody\n`;
    expectSchemaInvalid(() => parseMarkdownDoc(text, analyzeDocumentSchema), 'unknown schema');
  });

  it('reports rejected field paths without leaking document values', () => {
    const text = `---\nschema: ${SCHEMA_ID}\nsession_id: ""\nsecret_note: "top-secret-transcript-text"\n---\nbody\n`;
    assert.throws(
      () => parseMarkdownDoc(text, analyzeDocumentSchema),
      (err: unknown) =>
        err instanceof ScaError &&
        err.message.includes('session_id') &&
        !err.message.includes('top-secret-transcript-text'),
    );
  });

  it('round-trips multiline block scalars', () => {
    const doc = { ...sampleDoc(), extensions: { note: 'line one\nline two\n' } };
    const text = renderDocument(doc, 'body\n');
    const parsed = parseMarkdownDoc(text, analyzeDocumentSchema);
    assert.equal(parsed.extensions?.['note'], 'line one\nline two\n');
  });
});

describe('User Notes region', () => {
  it('splits and recomposes preserving the notes text', () => {
    const body = composeBody('# Projection\n\n- facts\n', '我的备注\n第二行');
    const parts = splitBody(body);
    assert.equal(parts.userNotes, '我的备注\n第二行');
    assert.ok(parts.projection.startsWith('# Projection'));
    assert.equal(composeBody(parts.projection, parts.userNotes), body);
  });

  it('treats a missing notes heading as empty notes', () => {
    const parts = splitBody('# Projection\n\nonly facts\n');
    assert.equal(parts.userNotes, '');
    assert.equal(parts.projection, '# Projection\n\nonly facts');
  });

  it('refuses bodies with two notes sections', () => {
    expectSchemaInvalid(
      () => assertSingleNotesSection('## User Notes\na\n## User Notes\nb\n'),
      '2',
    );
  });
});
