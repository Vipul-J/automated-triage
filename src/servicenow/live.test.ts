import assert from "node:assert/strict";
import { test } from "node:test";
import { LiveServiceNow, toLiveTicket } from "./live.js";

test("ServiceNow handoff reads raw incident fields and writes only internal notes", async (t) => {
  const id = "ab".repeat(16);
  let group: string | { value: string } = "";
  const requests: Array<{ method: string; body: unknown }> = [];
  const opened = new Date().toISOString().slice(0, 19).replace("T", " ");
  t.mock.method(globalThis, "fetch", (url: URL, init: RequestInit) => {
    assert.equal(url.pathname, `/api/now/table/incident/${id}`);
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer test-token");
    requests.push({
      method: init.method ?? "GET",
      body: typeof init.body === "string" ? (JSON.parse(init.body) as unknown) : null,
    });
    return Promise.resolve(
      Response.json({
        result: {
          sys_id: id,
          number: "INC128900",
          short_description: "Test",
          description: "",
          impact: "1",
          urgency: "1",
          priority: "1",
          state: "1",
          assignment_group: group,
          opened_at: opened,
          sys_updated_on: opened,
        },
      }),
    );
  });
  const client = new LiveServiceNow({
    url: "https://sandbox.example",
    bearerToken: "test-token",
    webhookToken: "test-webhook-token",
  });
  const incident = await client.read(id);
  assert.ok(incident);
  const ticket = toLiveTicket(incident);
  assert.equal(ticket.priority, 1);
  assert.equal(ticket.sysId, id);
  await client.writeInternalNote(ticket, "Approved handoff");
  assert.deepEqual(requests.at(-1), { method: "PATCH", body: { work_notes: "Approved handoff" } });
  group = { value: "cd".repeat(16) };
  await assert.rejects(client.writeInternalNote(ticket, "Stale handoff"), /no longer eligible/);
  assert.equal(requests.filter((request) => request.method === "PATCH").length, 1);
});
