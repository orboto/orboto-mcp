import { z } from 'zod';

export const TicketSpecStateSchema = z.enum(['none', 'needs_spec', 'in_spec', 'ready']);
export type TicketSpecState = z.infer<typeof TicketSpecStateSchema>;
export const ProjectSpecSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  requiredTypes: z.array(z.enum(['epic', 'story', 'task', 'bug'])).optional(),
  releaseBy: z.enum(['agent', 'author']).optional(),
}).strict();
export type ProjectSpecSettings = z.infer<typeof ProjectSpecSettingsSchema>;

export function specGateFailure(body: string) {
  let failure: { errorKey?: string; errorParams?: Record<string, unknown> };
  try { failure = JSON.parse(body); } catch { return undefined; }
  if (!failure || !['errors.tickets.spec_not_ready', 'errors.tickets.epic_not_claimable'].includes(failure.errorKey ?? '')) return undefined;
  return {
    isError: true,
    content: [{ type: 'text' as const, text: failure.errorKey === 'errors.tickets.spec_not_ready'
      ? `Specification is ${failure.errorParams?.state ?? 'not ready'}. Complete and release the specification, or explicitly set override=true with a reason.`
      : 'Epics are task groups. Use the spec role to prepare child stories.' }],
    structuredContent: { ...failure, specGate: true },
  };
}

export function isAlreadyAssigned(body: string): boolean {
  try {
    const error = JSON.parse(body) as { errorKey?: string; error?: string };
    return error?.errorKey === 'errors.tickets.already_assigned' || (!error?.errorKey && error?.error?.trim().toLowerCase() === 'already assigned');
  } catch { return false; }
}
