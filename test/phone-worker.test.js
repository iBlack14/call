import test from "node:test";
import assert from "node:assert/strict";

import {
  createPhoneWorker,
  isAllowedCampaignTransition,
  isCampaignStatusCorrelated,
  normalizePhoneNumber
} from "../server/phone-worker.js";

test("restores persisted worker identity and campaign binding", () => {
  const worker = createPhoneWorker({
    id: "device-a",
    name: "Xiaomi A",
    campaignContactId: "contact-a",
    campaignCommandId: "command-a",
    campaignCallPhase: "active"
  });

  assert.equal(worker.id, "device-a");
  assert.equal(worker.name, "Xiaomi A");
  assert.equal(worker.campaignContactId, "contact-a");
  assert.equal(worker.campaignCommandId, "command-a");
  assert.equal(worker.campaignCallPhase, "active");
});

test("correlates exact IDs and rejects stale, partial, and incoming events", () => {
  const worker = createPhoneWorker({
    id: "device-a",
    currentNumber: "979807000",
    campaignContactId: "contact-a",
    campaignCommandId: "command-a"
  });
  const contact = { id: "contact-a", phone: "979807000" };

  assert.equal(isCampaignStatusCorrelated(worker, contact, {
    commandId: "command-a",
    contactId: "contact-a",
    phoneNumber: "+51 979 807 000",
    callDirection: "outgoing"
  }), true);
  assert.equal(isCampaignStatusCorrelated(worker, contact, {
    commandId: "command-a",
    contactId: "contact-a",
    phoneNumber: "979807000",
    callDirection: "incoming"
  }), false);
  assert.equal(isCampaignStatusCorrelated(worker, contact, {
    commandId: "old-command",
    contactId: "contact-a",
    phoneNumber: "979807000"
  }), false);
  assert.equal(isCampaignStatusCorrelated(worker, contact, {
    commandId: "command-a",
    phoneNumber: "979807000"
  }), false);
  assert.equal(isCampaignStatusCorrelated(worker, contact, {
    phoneNumber: "966407384",
    callDirection: "incoming"
  }), false);
});

test("legacy rollout fallback requires the expected number and never incoming", () => {
  const worker = createPhoneWorker({
    id: "device-a",
    currentNumber: "979807000",
    campaignContactId: "contact-a",
    campaignCommandId: "command-a"
  });
  const contact = { id: "contact-a", phone: "979807000" };

  assert.equal(isCampaignStatusCorrelated(worker, contact, { phoneNumber: "+51979807000" }), true);
  assert.equal(isCampaignStatusCorrelated(worker, contact, {
    phoneNumber: "979807000",
    callDirection: "incoming"
  }), false);
  assert.equal(normalizePhoneNumber("+51 979-807-000"), "979807000");
});

test("rejects duplicate and regressive campaign transitions", () => {
  assert.equal(isAllowedCampaignTransition("dialing", "in_call"), true);
  assert.equal(isAllowedCampaignTransition("in_call", "ended"), true);
  assert.equal(isAllowedCampaignTransition("in_call", "dialing"), false);
  assert.equal(isAllowedCampaignTransition("ringing", "dialing"), false);
  assert.equal(isAllowedCampaignTransition("ended", "ended"), false);
});
