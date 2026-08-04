import test from "node:test";
import assert from "node:assert/strict";

import {
  assignNextContact,
  ensureCampaign,
  getCampaignSnapshot,
  pickNextContact,
  startCampaign,
  updateActiveCallState
} from "../server/campaign-manager.js";

const contacts = [
  { id: "a", name: "A", phone: "979807000" },
  { id: "b", name: "B", phone: "998347281" },
  { id: "c", name: "C", phone: "940189035" }
];

test("ensureCampaign is idempotent and preserves object identity", () => {
  const session = {};
  const first = ensureCampaign(session);
  first.status = "running";
  const second = ensureCampaign(session);

  assert.equal(second, first);
  assert.equal(second.status, "running");
});

test("two workers update only their own contacts", () => {
  const session = {};
  startCampaign(session, contacts);
  const workerA = { id: "device-a", socketId: "socket-a" };
  const workerB = { id: "device-b", socketId: "socket-b" };

  const contactA = assignNextContact(session, workerA);
  const contactB = assignNextContact(session, workerB);
  updateActiveCallState(session, "in_call", workerA);
  updateActiveCallState(session, "ended", workerA);

  assert.equal(contactA.status, "completed");
  assert.equal(contactA.result, "contactado");
  assert.equal(contactA.wasAnswered, true);
  assert.equal(contactB.status, "dialing");
  assert.equal(contactB.assignedWorkerId, "device-b");
  assert.equal(assignNextContact(session, workerA)?.id, "c");
});

test("finishing the final contact completes the campaign", () => {
  const session = {};
  startCampaign(session, [contacts[0]]);
  const worker = { id: "device-a", socketId: "socket-a" };
  assignNextContact(session, worker);
  updateActiveCallState(session, "ended", worker);

  assert.equal(assignNextContact(session, worker), null);
  const snapshot = getCampaignSnapshot(session);
  assert.equal(snapshot.status, "completed");
  assert.ok(snapshot.completedAt);
});

test("new campaign resets imported operational state and duplicate IDs", () => {
  const session = {};
  startCampaign(session, [
    { ...contacts[0], id: "duplicate", status: "in_call", attempts: 9 },
    { ...contacts[1], id: "duplicate", status: "failed", attempts: 4 }
  ]);
  const snapshot = getCampaignSnapshot(session);

  assert.equal(snapshot.contacts[0].status, "pending");
  assert.equal(snapshot.contacts[0].attempts, 0);
  assert.notEqual(snapshot.contacts[0].id, snapshot.contacts[1].id);
});

test("pending contacts are selected before deferred retries", () => {
  const session = {};
  startCampaign(session, contacts);
  const campaign = ensureCampaign(session);
  campaign.contacts[0].status = "reintentar";

  assert.equal(pickNextContact(session)?.id, "b");
  assert.equal(getCampaignSnapshot(session).counts.pending, 3);
});

test("campaign does not complete while a worker remains physically bound", () => {
  const session = {
    phoneWorkers: [{ id: "device-a", campaignContactId: "quarantined" }]
  };
  startCampaign(session, []);

  assert.equal(assignNextContact(session, { id: "device-b" }), null);
  assert.equal(getCampaignSnapshot(session).status, "running");

  session.phoneWorkers[0].campaignContactId = null;
  assert.equal(assignNextContact(session, { id: "device-b" }), null);
  assert.equal(getCampaignSnapshot(session).status, "completed");
});
