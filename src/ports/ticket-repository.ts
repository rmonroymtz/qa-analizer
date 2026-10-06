import type { Ticket } from '../domain/ticket.js';

export interface TicketRepository {
  getTicket(key: string): Promise<Ticket>;
}
