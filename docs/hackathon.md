# Hackathon demo

The simulator demonstrates ticket intake, evidence retrieval, L1/L2 review, an edited customer draft, simulator assignment or escalation, and a verifiable decision record. The sandbox mode uses the same console and adds an internal work note to the actual ServiceNow incident after a human decision.

## Local setup

Use Node.js 22 or newer and Docker with Compose, then run:

```sh
npm ci
cp .env.example .env
npm run db:up
npm run seed
npm run dev
```

Open http://localhost:3000. From a second terminal, run `npm run demo -- 1` to create a duplicate-checkout-charge incident. In the L1 queue, review the team, similar incidents and runbook, edit the customer draft and approve the route or select an alternative. Open the incident to see the handoff and verify its decision fingerprint. The draft is saved with the approval for review and no customer message is posted.

Use `npm run demo -- 3` for a restricted incident in the L2 queue. To show unattended escalation, leave an incident unreviewed. The simulator escalates it after three minutes. Set `ESCALATION_WINDOW_MS=45000 AUTOCOMMIT_MARGIN_MS=15000` on startup to rehearse with a short clock.

The console labels deterministic model output. Set `ANTHROPIC_API_KEY` and a `TRIAGE_MODEL` available to that account for real model inference. To enable semantic retrieval, also set `EMBEDDING_PROVIDER=openai` and `EMBEDDING_API_KEY`, then reseed the demo corpus to rebuild the vectors. The default mode uses local hashed vectors and PostgreSQL text search. Use only data approved for the configured providers.

## Show on-chain verification

Start an Anvil or other local EVM test network. Set `CHAIN_RPC_URL` and a funded **test-only** `CHAIN_PRIVATE_KEY`. Run `npm run chain:deploy` and set the printed `CHAIN_CONTRACT_ADDRESS` before starting the app.

After an engineer decision, the background worker anchors its salted SHA-256 fingerprint. Open the incident and click **Verify record**. The verification response reports whether the saved decision matches the fingerprint and whether the contract has anchored it. The ledger receives only the fingerprint. The ticket contents, actor, draft, and evidence references remain in PostgreSQL.

For a mismatch demonstration, change the approval's draft in a disposable local database after the fingerprint is anchored and verify again. Restore the original draft after the demonstration. A match verifies the contents of the recorded approval against its commitment. Correctness of the engineer's choice is assessed separately.

## Connect a ServiceNow sandbox

1. Start with a separate seeded demo database for this instance. Use a restricted ServiceNow integration account that can read the incident fields requested by the backend and write internal work notes to eligible test records.
2. Provide an OAuth bearer token in `SN_BEARER_TOKEN`, the instance HTTPS URL in `SN_INSTANCE_URL`, a random shared `SN_WEBHOOK_TOKEN` of at least 24 characters, and protected `CONSOLE_USER` and `CONSOLE_PASSWORD` credentials. The console account is shared by demo operators. Renew the OAuth token outside the application for the demo.
3. Run `npm start`. Put it behind an approved HTTPS reverse proxy reachable by the sandbox. Expose the webhook to ServiceNow. Keep the review console restricted to demo operators.
4. In ServiceNow, configure a record-triggered flow or an asynchronous **insert-only** Business Rule on **Incident**. Scope it to an agreed test condition, such as an incident whose short description begins with a test marker. Configure an outbound REST message with method POST to `/webhooks/servicenow`, a JSON content type and `Authorization: Bearer <SN_WEBHOOK_TOKEN>`. Use the platform's credential configuration for the secret. Send only `{"sys_id":"<incident sys_id>"}`.
5. Create a new unassigned test incident. Confirm it appears in the console. Approve the handoff, then refresh the ServiceNow form and check the internal work note under Activity. The note records the selected route, the decision, the analysis run and evidence IDs. Set assignment or post a customer update through the ServiceNow form if your demo calls for it.
6. Re-submit the webhook while the incident is eligible and confirm the gateway returns `duplicate`. Agree the three-minute assignment SLA and escalation workflow with the sandbox owner before demonstrating a missed deadline. ServiceNow owns actual SLA escalation in live mode.

The live integration assumes standard Incident choice values and raw UTC timestamps from the Table API. A customized instance may require field mapping. The console and workflow are designed for one app instance in this demo. The simulator holds its incidents in memory. The app stores decisions and anchor retries in PostgreSQL and requeues eligible, unreviewed tickets on app startup. Production would need ServiceNow role integration and token refresh, an SLA-derived deadline, durable decision delivery and closed-loop resolution reporting.

## Reference

- [ServiceNow outbound RESTMessageV2](https://www.servicenow.com/docs/r/api-reference/server-api-reference/c_RESTMessageV2API.html)
- [ServiceNow outbound REST authentication](https://www.servicenow.com/docs/r/api-reference/web-services/c_OutboundRESTAuth.html)
