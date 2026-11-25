import { EXTENSION_CONNECTOR, type PersonaPreview } from '@seedingsys/contracts';
import type { Prisma, Q } from './index';

export type ApprovedPersona = Pick<PersonaPreview, 'speaker' | 'listener' | 'relationship'>;

export function approvedPersona(value: Prisma.JsonValue): ApprovedPersona | undefined {
  return (value as { preview?: PersonaPreview } | null)?.preview;
}

/** The speaker is matched by both the approved UID and the target code. */
export async function personaCommentAuthor(t: Q, approvalId: string, listenerId: string) {
  const [approval, listener] = await Promise.all([
    t.personaApproval.findUnique({ where: { id: approvalId }, select: { context: true } }),
    t.targetAccount.findUnique({ where: { id: listenerId }, select: { code: true, externalId: true, enabled: true } }),
  ]);
  const role = approval && approvedPersona(approval.context);
  if (!role || !listener?.enabled || role.listener.code !== listener.code || role.listener.uid !== listener.externalId) return null;
  const author = await t.targetAccount.findFirst({
    where: { code: role.speaker.code, externalId: role.speaker.uid, enabled: true, connector: EXTENSION_CONNECTOR,
      profile: { isNot: null }, extension: { is: { uid: role.speaker.uid, installationId: { not: null } } } },
  });
  return author;
}

export async function commentListener(t: Q, destinationId: string, source: { sourcePostId: string; parentExternalId: string | null }) {
  if (!source.parentExternalId) return destinationId;
  const parent = await t.publicationComment.findFirst({
    where: { destinationId, source: { sourcePostId: source.sourcePostId, externalId: source.parentExternalId } },
    select: { authorTargetId: true },
  });
  return parent?.authorTargetId ?? null;
}
