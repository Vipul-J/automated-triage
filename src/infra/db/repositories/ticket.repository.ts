import { pool } from "../pool.js";
import type { CustomerTier, Ticket } from "../../../domain/types.js";

interface TicketRow {
  id: string;
  subject: string;
  body: string;
  requester: string | null;
  customer_tier: CustomerTier | null;
  created_at: Date;
  deadline_at: Date;
  status: string;
}

const toTicket = (r: TicketRow): Ticket => ({
  id: r.id,
  subject: r.subject,
  body: r.body,
  requester: r.requester ?? "unknown",
  customerTier: r.customer_tier ?? "standard",
  createdAt: r.created_at,
  deadlineAt: r.deadline_at,
  status: r.status,
});

export class TicketRepository {
  /**
   * Idempotent on ticket id: a redelivered webhook must not start a second
   * pipeline. Returns true only for a genuinely new ticket.
   */
  async insertIfAbsent(ticket: Ticket, raw: unknown): Promise<boolean> {
    const { rowCount } = await pool.query(
      `INSERT INTO tickets
         (id, subject, body, requester, customer_tier, created_at, deadline_at, status, raw)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id) DO NOTHING`,
      [
        ticket.id, ticket.subject, ticket.body, ticket.requester, ticket.customerTier,
        ticket.createdAt, ticket.deadlineAt, ticket.status, JSON.stringify(raw ?? {}),
      ],
    );
    return rowCount === 1;
  }

  async findById(id: string): Promise<Ticket | undefined> {
    const { rows } = await pool.query<TicketRow>(
      `SELECT id, subject, body, requester, customer_tier, created_at, deadline_at, status
         FROM tickets WHERE id = $1`,
      [id],
    );
    return rows[0] ? toTicket(rows[0]) : undefined;
  }

  async updateStatus(id: string, status: string): Promise<void> {
    await pool.query(`UPDATE tickets SET status = $2 WHERE id = $1`, [id, status]);
  }
}

export const ticketRepository = new TicketRepository();
