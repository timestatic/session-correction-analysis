import { ScaError } from '../domain/errors.js';

export const USER_NOTES_HEADING = '## User Notes';

export interface BodyParts {
  projection: string;
  userNotes: string;
}

/**
 * The body is the human-readable projection of the frontmatter plus one
 * trailing `User Notes` region that survives every regeneration (design 24.1).
 */
export function splitBody(body: string): BodyParts {
  const lines = body.split('\n');
  const idx = lines.findIndex((line) => line.trimEnd() === USER_NOTES_HEADING);
  if (idx === -1) {
    return { projection: body.replace(/\s+$/g, ''), userNotes: '' };
  }
  return {
    projection: lines
      .slice(0, idx)
      .join('\n')
      .replace(/\s+$/g, ''),
    userNotes: lines
      .slice(idx + 1)
      .join('\n')
      .trim(),
  };
}

export function composeBody(projection: string, userNotes: string): string {
  const proj = projection.replace(/\s+$/g, '');
  const notes = userNotes.replace(/^\s+|\s+$/g, '');
  return notes === '' ? `${proj}\n\n${USER_NOTES_HEADING}\n` : `${proj}\n\n${USER_NOTES_HEADING}\n\n${notes}\n`;
}

/** User Notes edits live outside the projection; conflicting duplicate headings are reported, never dropped. */
export function assertSingleNotesSection(body: string): void {
  const count = body.split('\n').filter((line) => line.trimEnd() === USER_NOTES_HEADING).length;
  if (count > 1) {
    throw new ScaError(
      'schema_invalid',
      `body contains ${String(count)} '${USER_NOTES_HEADING}' sections; resolve the edit before rewriting`,
    );
  }
}
