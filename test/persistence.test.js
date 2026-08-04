import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { SessionPersistence } from "../server/persistence.js";

test("local round-trip preserves device and in-flight correlation while clearing sockets", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "voip-vc-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "sessions.json");
  const persistence = new SessionPersistence(filePath);
  const sessions = new Map([
    ["ABC123", {
      phoneWorkers: [{
        id: "device-a",
        name: "Xiaomi A",
        socketId: "socket-a",
        connected: true,
        callState: "in_call",
        currentNumber: "979807000",
        campaignContactId: "contact-a",
        campaignCommandId: "command-a",
        campaignCallPhase: "active"
      }],
      campaign: {
        status: "running",
        activeContactId: "contact-a",
        contacts: [{ id: "contact-a", phone: "979807000", status: "in_call", assignedWorkerId: "device-a" }]
      }
    }]
  ]);

  await persistence.save(sessions);
  await persistence.close();
  const loaded = await new SessionPersistence(filePath).load();
  const restored = loaded.get("ABC123");

  assert.equal(restored.phoneWorkers[0].id, "device-a");
  assert.equal(restored.phoneWorkers[0].socketId, null);
  assert.equal(restored.phoneWorkers[0].callState, "offline");
  assert.equal(restored.phoneWorkers[0].campaignCommandId, "command-a");
  assert.equal(restored.campaign.contacts[0].status, "in_call");
});

test("burst saves coalesce to the latest state", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "voip-vc-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "sessions.json");
  const persistence = new SessionPersistence(filePath);
  const session = { counter: 0 };
  const sessions = new Map([["ABC123", session]]);

  const writes = [];
  for (let index = 1; index <= 100; index += 1) {
    session.counter = index;
    writes.push(persistence.save(sessions));
  }
  await Promise.all(writes);
  const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));

  assert.equal(parsed.ABC123.counter, 100);
});
