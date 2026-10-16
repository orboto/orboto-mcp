/** ORB-2542 - the responsibility map match as rendered by orboto_who for. */
interface UserRef { email: string; fullName: string | null }

export interface OwnerMatch {
  entry: { id: string; topic: string; ownerAddress: string; keywords: string[]; humanOwner: UserRef | null; deputy: UserRef | null };
  score: number;
  reason: string;
  matched: string[];
  routes: boolean;
}

function person(u: UserRef | null): string {
  return u ? u.fullName ?? u.email : '';
}

/** One match as a line: owner address, topic, human owner, why it matched. */
export function ownerLine(m: OwnerMatch): string {
  const human = m.entry.humanOwner ? `, human ${person(m.entry.humanOwner)}` : '';
  const deputy = m.entry.deputy ? `, deputy ${person(m.entry.deputy)}` : '';
  const why = m.matched.length ? `${m.reason}: ${m.matched.join(', ')}` : m.reason;
  return `- ${m.entry.ownerAddress} - ${m.entry.topic}${human}${deputy} (score ${m.score}, ${why}${m.routes ? '' : ', too weak to route'})`;
}
