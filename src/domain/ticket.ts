/** A single acceptance criterion extracted from a ticket, numbered AC-1, AC-2, ... */
export interface AcceptanceCriterion {
  id: string;
  text: string;
}

/** The ticket under verification, independent of the issue tracker. */
export interface Ticket {
  key: string;
  summary: string;
  description: string;
  acceptanceCriteria: AcceptanceCriterion[];
  url: string;
}
