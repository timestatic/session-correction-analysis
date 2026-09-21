/**
 * Hand-maintained JSON Schema mirror of the model submission protocol
 * (episodeSubmissionSchema + candidateSubmissionSchema, design 22.3).
 * It ships inside prepare packets so the host agent can validate its own
 * output; tests/unit/analysis/submission_schema.test.ts keeps both copies in
 * lockstep — the zod schemas stay the runtime authority.
 */

export interface JsonSchemaObject {
  readonly [key: string]: unknown;
}

const confidenceJson = { enum: ['high', 'medium', 'low', 'uncertain'] } as const;
const evidenceIdJson = { type: 'string', minLength: 1 } as const;
const evidenceIdsJson = { type: 'array', items: evidenceIdJson } as const;
const closed = { type: 'object', additionalProperties: false } as const;

export const episodeSubmissionJsonSchema: JsonSchemaObject = {
  ...closed,
  required: ['anchor_event_id', 'issue_anchor', 'correction', 'intervention', 'citations'],
  properties: {
    anchor_event_id: evidenceIdJson,
    issue_anchor: { type: 'string', minLength: 1, maxLength: 200 },
    correction: {
      ...closed,
      required: ['detected', 'confidence', 'prior_agent_behavior', 'agent_behavior_after', 'explanation'],
      properties: {
        detected: { type: 'boolean' },
        subtype: evidenceIdJson,
        confidence: confidenceJson,
        prior_agent_behavior: evidenceIdsJson,
        agent_behavior_after: evidenceIdsJson,
        rework: {
          ...closed,
          required: ['outcome', 'evidence'],
          properties: {
            outcome: { enum: ['undone', 'replaced', 'fixed', 'none', 'unknown'] },
            evidence: evidenceIdsJson,
          },
        },
        explanation: evidenceIdJson,
      },
    },
    intervention: {
      ...closed,
      required: ['detected', 'confidence', 'evidence', 'explanation'],
      properties: {
        detected: { type: 'boolean' },
        kind: {
          enum: [
            'interrupt_turn',
            'stop_direction',
            'forbid_action',
            'force_reorder',
            'takeover',
            'deny_operation',
            'other',
          ],
        },
        confidence: confidenceJson,
        evidence: evidenceIdsJson,
        explanation: evidenceIdJson,
      },
    },
    citations: {
      type: 'array',
      minItems: 1,
      items: {
        ...closed,
        required: ['evidence_id', 'quote'],
        properties: { evidence_id: evidenceIdJson, quote: evidenceIdJson },
      },
    },
  },
};

export const candidateSubmissionJsonSchema: JsonSchemaObject = {
  ...closed,
  required: ['title', 'category', 'confidence', 'proposed_content', 'evidence', 'source_episode_anchor'],
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 200 },
    category: evidenceIdJson,
    confidence: confidenceJson,
    proposed_content: evidenceIdJson,
    applicable_scope: evidenceIdJson,
    trigger_condition: evidenceIdJson,
    exceptions: evidenceIdJson,
    not_applicable: evidenceIdJson,
    evidence: { type: 'array', minItems: 1, items: evidenceIdJson },
    source_episode_anchor: evidenceIdJson,
    source_issue_anchor: { type: 'string', minLength: 1, maxLength: 200 },
  },
};

export const submissionJsonSchema: JsonSchemaObject = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'session-correction-analysis/submission/v1',
  type: 'object',
  additionalProperties: false,
  required: ['episodes', 'candidates'],
  properties: {
    episodes: { type: 'array', items: episodeSubmissionJsonSchema },
    candidates: { type: 'array', items: candidateSubmissionJsonSchema },
    processed_users: { type: 'array', items: {
      ...closed,
      required: ['evidence_id', 'status'],
      properties: { evidence_id: evidenceIdJson, status: { enum: ['reviewed', 'uncertain'] } },
    } },
  },
};
