import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { z } from 'zod';

import { candidateSubmissionSchema } from '../../../src/domain/candidates.js';
import { episodeSubmissionSchema } from '../../../src/domain/episodes.js';
import {
  candidateSubmissionJsonSchema,
  episodeSubmissionJsonSchema,
  submissionJsonSchema,
  type JsonSchemaObject,
} from '../../../src/analysis/submission-schema.js';

function core(schema: z.ZodTypeAny): z.ZodTypeAny {
  let cur: z.ZodTypeAny = schema;
  for (;;) {
    if (cur instanceof z.ZodEffects) {
      cur = (cur as z.ZodEffects<z.ZodTypeAny>).innerType();
      continue;
    }
    if (cur instanceof z.ZodOptional) {
      cur = (cur as z.ZodOptional<z.ZodTypeAny>).unwrap();
      continue;
    }
    return cur;
  }
}

function stringBound(inner: z.ZodString, kind: 'min' | 'max'): number {
  let bound = 0;
  for (const check of inner._def.checks) {
    if ((check.kind === 'min' || check.kind === 'max') && check.kind === kind) {
      bound = check.value;
    }
  }
  return bound;
}

function jsonProps(json: JsonSchemaObject, name: string): Record<string, JsonSchemaObject> {
  const props = json['properties'];
  assert.ok(props && typeof props === 'object', `${name}: JSON schema must list properties`);
  return props as Record<string, JsonSchemaObject>;
}

/** Structural lockstep: property sets, required lists, enums and length bounds must match. */
function matchZod(name: string, zodSchema: z.ZodTypeAny, json: JsonSchemaObject): void {
  const inner = core(zodSchema);
  if (inner instanceof z.ZodObject) {
    const object = inner as z.ZodObject<z.ZodRawShape>;
    assert.equal(json['type'], 'object', `${name}: object expected`);
    assert.equal(json['additionalProperties'], false, `${name}: strict must be mirrored`);
    assert.equal(object._def.unknownKeys, 'strict', `${name}: zod must stay strict`);
    const shape = object.shape;
    const props = jsonProps(json, name);
    assert.deepEqual(
      Object.keys(shape).sort(),
      Object.keys(props).sort(),
      `${name}: property sets drifted`,
    );
    const required = Object.entries(shape)
      .filter(([, field]) => !(field instanceof z.ZodOptional))
      .map(([key]) => key)
      .sort();
    const jsonRequired = json['required'];
    assert.ok(Array.isArray(jsonRequired), `${name}: required list missing`);
    const jsonRequiredList = jsonRequired as string[];
    assert.deepEqual(required, [...jsonRequiredList].sort(), `${name}: required lists drifted`);
    for (const [key, field] of Object.entries(shape)) {
      const child = props[key];
      assert.ok(child, `${name}.${key}: missing JSON schema node`);
      matchZod(`${name}.${key}`, field, child);
    }
    return;
  }
  if (inner instanceof z.ZodEnum) {
    const enumeration = inner as z.ZodEnum<[string, ...string[]]>;
    assert.deepEqual(json['enum'], [...enumeration._def.values], `${name}: enum drifted`);
    return;
  }
  if (inner instanceof z.ZodArray) {
    const array = inner as z.ZodArray<z.ZodTypeAny>;
    assert.equal(json['type'], 'array', `${name}: array expected`);
    assert.equal(
      array._def.minLength?.value ?? 0,
      typeof json['minItems'] === 'number' ? json['minItems'] : 0,
      `${name}: minItems drifted`,
    );
    const items = json['items'];
    assert.ok(items && typeof items === 'object', `${name}: items missing`);
    matchZod(`${name}[]`, array._def.type, items as JsonSchemaObject);
    return;
  }
  if (inner instanceof z.ZodString) {
    assert.equal(json['type'], 'string', `${name}: string expected`);
    assert.equal(
      stringBound(inner, 'min'),
      typeof json['minLength'] === 'number' ? json['minLength'] : 0,
      `${name}: minLength drifted`,
    );
    assert.equal(
      stringBound(inner, 'max'),
      typeof json['maxLength'] === 'number' ? json['maxLength'] : 0,
      `${name}: maxLength drifted`,
    );
    return;
  }
  if (inner instanceof z.ZodBoolean) {
    assert.equal(json['type'], 'boolean', `${name}: boolean expected`);
    return;
  }
  assert.fail(`${name}: unsupported zod node — mirror it explicitly or the lockstep is blind`);
}

describe('submission JSON Schema mirror vs zod authority (design 22.3)', () => {
  it('episode mirror matches the zod submission schema structurally', () => {
    matchZod('episode', episodeSubmissionSchema, episodeSubmissionJsonSchema);
  });

  it('candidate mirror matches the zod submission schema structurally', () => {
    matchZod('candidate', candidateSubmissionSchema, candidateSubmissionJsonSchema);
  });

  it('root schema composes the two mirrors and closes itself', () => {
    assert.equal(submissionJsonSchema['$id'], 'session-correction-analysis/submission/v1');
    assert.equal(submissionJsonSchema['additionalProperties'], false);
    assert.deepEqual(submissionJsonSchema['required'], ['episodes', 'candidates']);
    const props = jsonProps(submissionJsonSchema, 'submission');
    assert.deepEqual(props['episodes']?.['items'], episodeSubmissionJsonSchema);
    assert.deepEqual(props['candidates']?.['items'], candidateSubmissionJsonSchema);
  });

  it('zod stays the runtime authority for semantic rules the mirror cannot express', () => {
    const baseCorrection = {
      detected: true,
      confidence: 'high',
      prior_agent_behavior: ['evt-1'],
      agent_behavior_after: [],
      explanation: 'user reversed the approach',
    };
    const baseIntervention = {
      detected: false,
      confidence: 'high',
      evidence: [],
      explanation: 'no intervention',
    };
    const episodeFields = {
      anchor_event_id: 'evt-1',
      issue_anchor: 'scope creep',
      correction: baseCorrection,
      intervention: baseIntervention,
      citations: [{ evidence_id: 'evt-1', quote: 'do it again' }],
    };
    assert.ok(episodeSubmissionSchema.safeParse(episodeFields).success, 'baseline must parse');
    assert.ok(
      !episodeSubmissionSchema.safeParse({ ...episodeFields, authority: 'model' }).success,
      'strict objects must refuse authority fields',
    );
    assert.ok(
      !episodeSubmissionSchema.safeParse({
        ...episodeFields,
        correction: { ...baseCorrection, detected: false },
        intervention: { ...baseIntervention, detected: false },
      }).success,
      'assertsALabel is enforced by zod only — the mirror cannot express it, so ingest re-validates through zod',
    );
  });
});
