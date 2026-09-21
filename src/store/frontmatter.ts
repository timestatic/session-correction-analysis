import { isAlias, isMap, isSeq, parseDocument, stringify } from 'yaml';
import type { ZodTypeAny } from 'zod';

import { SCHEMA_ID } from '../domain/documents.js';
import { ScaError } from '../domain/errors.js';

const FRONTMATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/;

export interface SplitDoc {
  yamlText: string;
  body: string;
}

export function splitFrontmatter(text: string): SplitDoc {
  const match = FRONTMATTER_RE.exec(text);
  if (match === null) {
    throw new ScaError('schema_invalid', 'file must start with a --- frontmatter block');
  }
  return {
    yamlText: match[1] ?? '',
    body: text.slice(match[0].length).replace(/^\r?\n/, ''),
  };
}

function containsAlias(node: unknown): boolean {
  if (isAlias(node)) {
    return true;
  }
  if (isMap(node)) {
    return node.items.some((pair) => pair.value !== null && containsAlias(pair.value));
  }
  if (isSeq(node)) {
    return node.items.some((item) => item !== null && containsAlias(item));
  }
  return false;
}

/** YAML 1.2 safe reading: no duplicate keys, no anchors/aliases, no custom tags. */
export function parseFrontmatterYaml(yamlText: string): unknown {
  const doc = parseDocument(yamlText, { logLevel: 'silent', merge: false });
  const firstError = doc.errors[0];
  if (firstError !== undefined) {
    throw new ScaError('schema_invalid', `frontmatter YAML error: ${truncate(firstError.message)}`);
  }
  if (containsAlias(doc.contents)) {
    throw new ScaError('schema_invalid', 'frontmatter must not use YAML anchors or aliases');
  }
  const value: unknown = doc.toJS();
  return value;
}

function truncate(value: string): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > 160 ? `${flat.slice(0, 160)}...` : flat;
}

export function validateSchema<T extends ZodTypeAny>(schema: T, record: Record<string, unknown>): T['_output'] {
  const result = schema.safeParse(record);
  if (!result.success) {
    const fields = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.code}`)
      .join('; ');
    throw new ScaError('schema_invalid', `payload rejected by schema — ${truncate(fields)}`);
  }
  return result.data as T['_output'];
}

/**
 * Reads one Markdown document through its frontmatter schema. `expectedSchemaId`
 * is per surface: the session records and the root rules registry share this
 * reader but never share an upgrade path, and an id either side does not know is
 * refused rather than silently downgraded (design 31.1).
 */
export function parseMarkdownDoc<T extends ZodTypeAny>(
  text: string,
  schema: T,
  expectedSchemaId: string = SCHEMA_ID,
): T['_output'] {
  const data = parseFrontmatterYaml(splitFrontmatter(text).yamlText);
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new ScaError('schema_invalid', 'frontmatter must be a YAML mapping');
  }
  const record = data as Record<string, unknown>;
  const declaredSchema = record['schema'];
  if (typeof declaredSchema !== 'string') {
    throw new ScaError('schema_invalid', 'frontmatter schema field is missing');
  }
  if (declaredSchema !== expectedSchemaId) {
    throw new ScaError(
      'schema_invalid',
      `unknown schema '${declaredSchema}' (open read-only, expected '${expectedSchemaId}')`,
    );
  }
  return validateSchema(schema, record);
}

export function renderDocument(frontmatter: object, body: string): string {
  const yamlText = stringify(frontmatter, { lineWidth: 0 }).trimEnd();
  return `---\n${yamlText}\n---\n\n${body}`;
}
