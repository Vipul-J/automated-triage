import { Contract, JsonRpcProvider, Wallet } from "ethers";
import { FetchRequest } from "ethers";
import { config } from "../../config/index.js";
import { pool, withTransaction } from "../db/pool.js";
import { loggerFor } from "../logging/logger.js";
import { decisionFingerprint, type DecisionEvent } from "./fingerprint.js";

const logger = loggerFor("decision-anchor");
const abi = ["function exists(bytes32) view returns (bool)", "function anchor(bytes32)"];

function connectivity() {
  if (!config.chain) return null;
  const connection = new FetchRequest(config.chain.url);
  connection.timeout = 5_000;
  const provider = new JsonRpcProvider(connection);
  const contract = new Contract(config.chain.contract, abi, new Wallet(config.chain.key, provider));
  return { provider, contract };
}

const chain = connectivity();

interface AnchorRow {
  approval_id: number;
  fingerprint: string;
  confirmed_at: Date | null;
  transaction_hash: string | null;
}

async function processNext(): Promise<void> {
  if (!chain) return;
  await withTransaction(async (tx) => {
    // Use one signer at a time, including when two app processes share the database.
    const {
      rows: [lock],
    } = await tx.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_xact_lock(1396971844) AS locked",
    );
    if (!lock?.locked) return;

    const {
      rows: [row],
    } = await tx.query<AnchorRow>(
      `SELECT approval_id, fingerprint FROM decision_integrity
        WHERE confirmed_at IS NULL AND next_attempt_at <= now()
        ORDER BY approval_id LIMIT 1 FOR UPDATE`,
    );
    if (!row) return;
    try {
      const exists = chain.contract.getFunction("exists");
      let hash: string | null = null;
      if (!(await exists.staticCall(row.fingerprint))) {
        const anchor = chain.contract.getFunction("anchor");
        const transaction = await anchor.send(row.fingerprint);
        const receipt = await transaction.wait(1, 10_000);
        if (!receipt || receipt.status !== 1) throw new Error("Anchor transaction failed");
        hash = receipt.hash;
      }
      await tx.query(
        `UPDATE decision_integrity SET confirmed_at = now(), transaction_hash = $2
          WHERE approval_id = $1`,
        [row.approval_id, hash],
      );
    } catch {
      logger.warn({ approvalId: row.approval_id }, "anchor pending; will retry");
      await tx.query(
        `UPDATE decision_integrity SET anchor_attempts = anchor_attempts + 1,
          next_attempt_at = now() + interval '15 seconds' WHERE approval_id = $1`,
        [row.approval_id],
      );
    }
  });
}

export function startAnchorWorker(): () => Promise<void> {
  let running: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (!running && chain) {
      running = processNext()
        .catch(() => logger.warn("anchor worker database unavailable"))
        .finally(() => {
          running = undefined;
        });
    }
  }, 2_000);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await running;
    chain?.provider.destroy();
  };
}

export async function listProofs(
  ticketId: string,
): Promise<
  Array<AnchorRow & { action: string; final_team: string | null; response_after: string | null }>
> {
  const { rows } = await pool.query<
    AnchorRow & { action: string; final_team: string | null; response_after: string | null }
  >(
    `SELECT d.approval_id, d.fingerprint, d.confirmed_at, d.transaction_hash, a.action, a.final_team, a.response_after
      FROM decision_integrity d JOIN approvals a ON a.id = d.approval_id
      WHERE a.ticket_id = $1 ORDER BY d.approval_id DESC`,
    [ticketId],
  );
  return rows;
}

export async function verifyProof(ticketId: string, approvalId: number) {
  const {
    rows: [row],
  } = await pool.query<DecisionEvent & AnchorRow>(
    `SELECT a.*, d.nonce, d.evidence, d.fingerprint, d.confirmed_at, d.transaction_hash
      FROM approvals a JOIN decision_integrity d ON a.id = d.approval_id
      WHERE a.ticket_id = $1 AND a.id = $2`,
    [ticketId, approvalId],
  );
  if (!row) return null;
  const matches = decisionFingerprint(row) === row.fingerprint;
  let onChain = null;
  if (chain) {
    try {
      onChain = Boolean(await chain.contract.getFunction("exists").staticCall(row.fingerprint));
    } catch {
      logger.warn({ approvalId }, "anchor verification unavailable");
    }
  }
  return {
    fingerprint: row.fingerprint,
    recordMatches: matches,
    onChain,
    status: !matches
      ? "mismatch"
      : onChain
        ? "verified"
        : !chain
          ? "local_only"
          : onChain === null
            ? "unavailable"
            : "unanchored",
    transactionHash: row.transaction_hash,
  };
}
