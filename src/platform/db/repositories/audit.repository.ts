import { pool } from "../pool.js";

/** Append-only. Every decision, human or machine (design doc section 13.4). */
export class AuditRepository {
  async record(ticketId: string | null, event: string, payload: unknown = {}): Promise<void> {
    await pool.query(`INSERT INTO audit_log (ticket_id, event, payload) VALUES ($1, $2, $3)`, [
      ticketId,
      event,
      JSON.stringify(payload ?? {}),
    ]);
  }

  async forTicket(ticketId: string): Promise<{ event: string; payload: unknown; at: Date }[]> {
    const { rows } = await pool.query<{ event: string; payload: unknown; at: Date }>(
      `SELECT event, payload, at FROM audit_log WHERE ticket_id = $1 ORDER BY id ASC`,
      [ticketId],
    );
    return rows;
  }
}

export const auditRepository = new AuditRepository();
