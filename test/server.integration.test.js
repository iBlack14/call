import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { io as createSocketClient } from "socket.io-client";

function eventOnce(socket, eventName, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(eventName, listener);
      reject(new Error(`Timeout esperando ${eventName}`));
    }, timeoutMs);
    const listener = (payload) => {
      clearTimeout(timer);
      resolve(payload);
    };
    socket.once(eventName, listener);
  });
}

function eventOnceMatching(socket, eventName, predicate, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    let timer;
    const listener = (payload) => {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      socket.off(eventName, listener);
      resolve(payload);
    };
    timer = setTimeout(() => {
      socket.off(eventName, listener);
      reject(new Error(`Timeout esperando ${eventName} coincidente`));
    }, timeoutMs);
    socket.on(eventName, listener);
  });
}

async function availablePort() {
  const listener = net.createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const { port } = listener.address();
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

async function waitForServer(baseUrl, child, logs) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Servidor terminó antes de iniciar:\n${logs.join("")}`);
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Servidor no inició:\n${logs.join("")}`);
}

async function createSlot(baseUrl, code, label) {
  const response = await fetch(`${baseUrl}/api/session/${code}/pairing-slots`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label })
  });
  assert.equal(response.status, 201);
  const data = await response.json();
  return new URL(data.slot.link).searchParams.get("token");
}

async function pairAndJoin(baseUrl, code, token, deviceId, deviceName) {
  const paired = await fetch(`${baseUrl}/api/android/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, token, deviceId, deviceName })
  });
  assert.equal(paired.status, 200);

  const socket = createSocketClient(baseUrl, { transports: ["websocket"], forceNew: true });
  await eventOnce(socket, "connect");
  const joined = eventOnce(socket, "session:joined");
  socket.emit("session:join", { code, role: "phone", token, deviceId, deviceName, protocolVersion: 2 });
  await joined;
  return socket;
}

async function createIntegrationHarness(
  t,
  environment = {},
  persistedSessions = null,
  existingCode = ""
) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "voip-vc-integration-"));
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const logs = [];
  const sessionFilePath = path.join(directory, "sessions.json");
  if (persistedSessions) {
    await fs.writeFile(sessionFilePath, JSON.stringify(persistedSessions), "utf8");
  }
  const child = spawn(process.execPath, ["server/server.js"], {
    cwd: path.resolve("."),
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: "test",
      SESSION_FILE_PATH: sessionFilePath,
      SUPABASE_URL: "",
      SUPABASE_SECRET_KEY: "",
      SUPABASE_SERVICE_ROLE_KEY: "",
      SUPABASE_REQUIRED: "0",
      CAMPAIGN_DISCONNECT_GRACE_MS: "5000",
      CAMPAIGN_COMMAND_TIMEOUT_MS: "10000",
      CAMPAIGN_HANGUP_TIMEOUT_MS: "3000",
      ...environment
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (chunk) => logs.push(chunk.toString()));
  child.stderr.on("data", (chunk) => logs.push(chunk.toString()));

  const sockets = [];
  t.after(async () => {
    for (const socket of sockets) socket.disconnect();
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 5_000))]);
    }
    await fs.rm(directory, { recursive: true, force: true });
  });

  await waitForServer(baseUrl, child, logs);
  const dashboard = createSocketClient(baseUrl, { transports: ["websocket"], forceNew: true });
  sockets.push(dashboard);
  await eventOnce(dashboard, "connect");
  let code = existingCode;
  if (code) {
    const joined = eventOnce(dashboard, "session:joined");
    dashboard.emit("session:join", { code, role: "dashboard" });
    await joined;
  } else {
    const created = eventOnce(dashboard, "session:created");
    dashboard.emit("session:create");
    ({ code } = await created);
  }

  return {
    baseUrl,
    code,
    dashboard,
    logs,
    async addPhone(label, deviceId, deviceName) {
      const token = await createSlot(baseUrl, code, label);
      const phone = await pairAndJoin(baseUrl, code, token, deviceId, deviceName);
      sockets.push(phone);
      return phone;
    },
    async joinPhone(token, deviceId, deviceName) {
      const phone = await pairAndJoin(baseUrl, code, token, deviceId, deviceName);
      sockets.push(phone);
      return phone;
    }
  };
}

async function readWorkers(baseUrl, code) {
  const response = await fetch(`${baseUrl}/api/session/${code}/workers`);
  assert.equal(response.status, 200);
  return (await response.json()).workers;
}

async function readCampaign(baseUrl, code) {
  const response = await fetch(`${baseUrl}/api/session/${code}/campaign`);
  assert.equal(response.status, 200);
  return (await response.json()).campaign;
}

async function waitForValue(read, predicate, description, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;
  while (Date.now() < deadline) {
    lastValue = await read();
    if (predicate(lastValue)) return lastValue;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timeout esperando ${description}; último valor: ${JSON.stringify(lastValue)}`);
}

test("multi-device campaign keeps one active phone and fails over to standby", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "voip-vc-integration-"));
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const logs = [];
  const child = spawn(process.execPath, ["server/server.js"], {
    cwd: path.resolve("."),
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: "test",
      SESSION_FILE_PATH: path.join(directory, "sessions.json"),
      SUPABASE_URL: "",
      SUPABASE_SECRET_KEY: "",
      SUPABASE_SERVICE_ROLE_KEY: "",
      SUPABASE_REQUIRED: "0",
      CAMPAIGN_DISCONNECT_GRACE_MS: "5000",
      CAMPAIGN_COMMAND_TIMEOUT_MS: "10000"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (chunk) => logs.push(chunk.toString()));
  child.stderr.on("data", (chunk) => logs.push(chunk.toString()));

  const sockets = [];
  t.after(async () => {
    for (const socket of sockets) socket.disconnect();
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 5_000))]);
    }
    await fs.rm(directory, { recursive: true, force: true });
  });

  await waitForServer(baseUrl, child, logs);
  const dashboard = createSocketClient(baseUrl, { transports: ["websocket"], forceNew: true });
  sockets.push(dashboard);
  await eventOnce(dashboard, "connect");
  const created = eventOnce(dashboard, "session:created");
  dashboard.emit("session:create");
  const { code } = await created;

  const tokenA = await createSlot(baseUrl, code, "Dispositivo 1");
  const tokenB = await createSlot(baseUrl, code, "Dispositivo 2");
  let phoneA = await pairAndJoin(baseUrl, code, tokenA, "device-a", "Xiaomi A");
  const phoneB = await pairAndJoin(baseUrl, code, tokenB, "device-b", "Xiaomi B");
  sockets.push(phoneA, phoneB);

  const standbyCommands = [];
  const captureStandby = (payload) => standbyCommands.push(payload);
  phoneB.on("call:action", captureStandby);
  const commandAWait = eventOnce(phoneA, "call:action");
  const started = await fetch(`${baseUrl}/api/session/${code}/campaign/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contacts: [
      { id: "a", name: "A", phone: "979807000" },
      { id: "b", name: "B", phone: "998347281" },
      { id: "c", name: "C", phone: "940189035" }
    ] })
  });
  assert.equal(started.status, 200);
  const commandA = await commandAWait;
  await new Promise((resolve) => setTimeout(resolve, 200));
  phoneB.off("call:action", captureStandby);
  assert.deepEqual(standbyCommands, []);

  const status = (command, callState) => ({
    callState,
    phoneNumber: command.phoneNumber,
    contactId: command.contactId,
    commandId: command.commandId,
    callDirection: "outgoing",
    source: "integration_test",
    physicalObserved: true
  });

  const prematureIdleAckWait = eventOnce(phoneA, "phone:status_ack");
  const prematureIdleStateWait = eventOnce(dashboard, "state:changed");
  phoneA.emit("phone:status", status(commandA, "idle"));
  const prematureIdleAck = await prematureIdleAckWait;
  const prematureIdleState = await prematureIdleStateWait;
  assert.equal(prematureIdleAck.commandId, commandA.commandId);
  assert.equal(prematureIdleAck.contactId, commandA.contactId);
  assert.equal(prematureIdleAck.callState, "idle");
  assert.equal(prematureIdleAck.accepted, false);
  assert.equal(prematureIdleAck.terminal, false);
  assert.equal(prematureIdleState.callState, "dialing");
  assert.equal(
    prematureIdleState.phoneWorkers.find((worker) => worker.id === "device-a")?.callState,
    "dialing"
  );

  const campaignAfterPrematureIdle = await fetch(`${baseUrl}/api/session/${code}/campaign`);
  const prematureIdleSnapshot = (await campaignAfterPrematureIdle.json()).campaign;
  assert.equal(
    prematureIdleSnapshot.contacts.find((contact) => contact.id === commandA.contactId)?.status,
    "dialing"
  );

  const inCallAckWait = eventOnce(phoneA, "phone:status_ack");
  phoneA.emit("phone:status", status(commandA, "in_call"));
  assert.equal((await inCallAckWait).accepted, true);

  const regressiveAckWait = eventOnce(phoneA, "phone:status_ack");
  const regressiveStateWait = eventOnce(dashboard, "state:changed");
  phoneA.emit("phone:status", status(commandA, "ringing"));
  assert.equal((await regressiveAckWait).accepted, true);
  const regressiveState = await regressiveStateWait;
  assert.equal(regressiveState.callState, "in_call");
  assert.equal(
    regressiveState.phoneWorkers.find((worker) => worker.id === "device-a")?.callState,
    "in_call"
  );
  assert.equal(
    (await readCampaign(baseUrl, code)).contacts.find((contact) => contact.id === commandA.contactId)?.status,
    "in_call"
  );

  const standbyIdleStateWait = eventOnce(dashboard, "state:changed");
  phoneB.emit("phone:status", {
    callState: "idle",
    source: "integration_test",
    physicalObserved: true,
    noLiveCalls: true
  });
  const stateAfterStandbyIdle = await standbyIdleStateWait;
  assert.equal(stateAfterStandbyIdle.callState, "in_call");
  assert.equal(stateAfterStandbyIdle.lastNumber, commandA.phoneNumber);
  const workerStateById = new Map(stateAfterStandbyIdle.phoneWorkers.map((worker) => [worker.id, worker]));
  assert.equal(workerStateById.get("device-a").callState, "in_call");
  assert.equal(workerStateById.get("device-b").callState, "idle");

  const campaignWhileAIsActive = await readCampaign(baseUrl, code);
  const activeById = new Map(campaignWhileAIsActive.contacts.map((contact) => [contact.id, contact]));
  assert.equal(activeById.get("a").status, "in_call");
  assert.equal(activeById.get("b").status, "pending");
  assert.equal(activeById.get("c").status, "pending");

  const commandsBeforeForceRelease = [];
  const captureBeforeForceRelease = (payload) => commandsBeforeForceRelease.push(payload);
  phoneB.on("call:action", captureBeforeForceRelease);
  const disconnectedAt = Date.now();
  phoneA.disconnect();
  const quarantinedAfterDisconnect = await waitForValue(
    () => readCampaign(baseUrl, code),
    (campaign) => campaign.quarantinedCalls?.some((call) =>
      call.workerId === "device-a" &&
      call.callState === "unresponsive" &&
      /no se reconectó/i.test(call.reason)
    ),
    "disconnected physical call quarantined",
    8_000
  );
  assert.ok(Date.now() - disconnectedAt >= 4_500);
  assert.equal(
    quarantinedAfterDisconnect.quarantinedCalls.find((call) => call.workerId === "device-a")?.kind,
    "campaign"
  );
  phoneB.off("call:action", captureBeforeForceRelease);
  assert.deepEqual(commandsBeforeForceRelease, []);
  const failoverCommandWait = eventOnce(phoneB, "call:action", 5_000);
  const forceRelease = await fetch(`${baseUrl}/api/session/${code}/campaign/force-release`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workerId: "device-a", confirm: true })
  });
  assert.equal(forceRelease.status, 200);
  const commandB = await failoverCommandWait;
  assert.equal(commandB.action, "dial");
  assert.equal(commandB.contactId, "b");

  const phoneBInCallAckWait = eventOnce(phoneB, "phone:status_ack");
  phoneB.emit("phone:status", status(commandB, "in_call"));
  assert.equal((await phoneBInCallAckWait).accepted, true);

  phoneA = await pairAndJoin(baseUrl, code, tokenA, "device-a", "Xiaomi A");
  sockets.push(phoneA);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const staleStatusAckWait = eventOnce(phoneA, "phone:status_ack");
  const staleStateWait = eventOnce(dashboard, "state:changed");
  phoneA.emit("phone:status", {
    ...status(commandA, "ended"),
    noLiveCalls: true
  });
  await staleStatusAckWait;
  const stateAfterStaleEnded = await staleStateWait;
  assert.equal(stateAfterStaleEnded.callState, "in_call");
  assert.equal(stateAfterStaleEnded.lastNumber, commandB.phoneNumber);

  const campaign = await readCampaign(baseUrl, code);
  const byId = new Map(campaign.contacts.map((contact) => [contact.id, contact]));

  assert.equal(byId.get("a").status, "completed");
  assert.equal(byId.get("a").result, "contactado");
  assert.equal(byId.get("b").status, "in_call");
  assert.equal(byId.get("c").status, "pending");
  const workersResponse = await fetch(`${baseUrl}/api/session/${code}/workers`);
  const workers = (await workersResponse.json()).workers;
  assert.deepEqual(new Set(workers.map((worker) => worker.id)), new Set(["device-a", "device-b"]));
});

test("legacy snapshot remaps the worker and resumes its correlated ended after reconnect", async (t) => {
  const code = "LEG001";
  const token = "legacy-pairing-token";
  const snapshot = {
    [code]: {
      pairingSlots: [{
        id: "legacy-slot",
        token,
        label: "Dispositivo legado",
        deviceId: "device-restored",
        deviceName: "Xiaomi Restored",
        linkedAt: "2026-08-01T00:00:00.000Z"
      }],
      phoneWorkers: [{
        id: "android-worker",
        name: "Android bridge",
        pairingSlotId: "legacy-slot",
        socketId: "stale-socket",
        connected: true,
        callState: "in_call",
        currentNumber: "979807000",
        campaignContactId: "legacy-contact",
        campaignCommandId: "legacy-command",
        campaignCallPhase: "active",
        campaignLastState: "in_call"
      }],
      campaign: {
        status: "running",
        activeContactId: "legacy-contact",
        activeWorkerId: "android-worker",
        contacts: [
          {
            id: "legacy-contact",
            name: "Legacy",
            phone: "979807000",
            status: "in_call",
            assignedWorkerId: "android-worker",
            attempts: 1,
            wasAnswered: true
          },
          {
            id: "next-contact",
            name: "Next",
            phone: "998347281",
            status: "pending"
          }
        ]
      }
    }
  };
  const { baseUrl, joinPhone } = await createIntegrationHarness(t, {}, snapshot, code);

  const restoredWorkers = await readWorkers(baseUrl, code);
  assert.equal(restoredWorkers.length, 1);
  assert.equal(restoredWorkers[0].id, "device-restored");
  assert.equal(restoredWorkers[0].connected, false);
  const restoredCampaign = await readCampaign(baseUrl, code);
  const restoredContact = restoredCampaign.contacts.find((contact) => contact.id === "legacy-contact");
  assert.equal(restoredCampaign.activeWorkerId, "device-restored");
  assert.equal(restoredContact.assignedWorkerId, "device-restored");
  assert.equal(restoredContact.status, "in_call");

  const phone = await joinPhone(token, "device-restored", "Xiaomi Restored");
  const terminalAckWait = eventOnce(phone, "phone:status_ack");
  const nextCommandWait = eventOnce(phone, "call:action");
  phone.emit("phone:status", {
    callState: "ended",
    phoneNumber: "979807000",
    contactId: "legacy-contact",
    commandId: "legacy-command",
    callDirection: "outgoing",
    source: "integration_test",
    physicalObserved: true,
    noLiveCalls: true
  });
  const terminalAck = await terminalAckWait;
  const nextCommand = await nextCommandWait;
  assert.equal(terminalAck.accepted, true);
  assert.equal(terminalAck.terminal, true);
  assert.equal(nextCommand.contactId, "next-contact");

  const resumedCampaign = await readCampaign(baseUrl, code);
  const resumedById = new Map(resumedCampaign.contacts.map((contact) => [contact.id, contact]));
  assert.equal(resumedById.get("legacy-contact").status, "completed");
  assert.equal(resumedById.get("legacy-contact").result, "contactado");
  assert.equal(resumedById.get("next-contact").status, "dialing");
  assert.deepEqual((await readWorkers(baseUrl, code)).map((worker) => worker.id), ["device-restored"]);
});

test("manual dial without phones returns an immediate correlated NACK", async (t) => {
  const { baseUrl, dashboard } = await createIntegrationHarness(t);
  const commandId = "manual-no-phone";
  const rejectedAckWait = eventOnce(dashboard, "phone:command_ack", 2_000);

  dashboard.emit("call:action", {
    action: "dial",
    phoneNumber: "979807000",
    commandId
  });

  const rejectedAck = await rejectedAckWait;
  assert.equal(rejectedAck.commandId, commandId);
  assert.equal(rejectedAck.action, "dial");
  assert.equal(rejectedAck.ok, false);
  assert.match(rejectedAck.message, /no hay un teléfono disponible/i);

  const health = await fetch(`${baseUrl}/health`);
  assert.equal(health.status, 200);
  assert.equal(dashboard.connected, true);
});

test("manual dial NACK quarantines the worker until a physical idle", async (t) => {
  const { baseUrl, code, dashboard, addPhone } = await createIntegrationHarness(t);
  const phone = await addPhone("Dispositivo manual", "device-manual", "Xiaomi Manual");

  const firstCommandWait = eventOnce(phone, "call:action");
  dashboard.emit("call:action", {
    action: "dial",
    phoneNumber: "979807000",
    commandId: "manual-rejected-1"
  });
  const firstCommand = await firstCommandWait;
  assert.equal(firstCommand.action, "dial");
  assert.equal(firstCommand.commandId, "manual-rejected-1");

  const rejectedAckWait = eventOnce(dashboard, "phone:command_ack");
  phone.emit("phone:command_ack", {
    action: "dial",
    commandId: firstCommand.commandId,
    ok: false,
    message: "Marcación rechazada por Android"
  });
  const rejectedAck = await rejectedAckWait;
  assert.equal(rejectedAck.commandId, firstCommand.commandId);
  assert.equal(rejectedAck.ok, false);

  const workersAfterNack = await readWorkers(baseUrl, code);
  assert.equal(workersAfterNack[0].callState, "blocked");
  assert.notEqual(workersAfterNack[0].callState, "dialing");

  const campaignAfterNack = await readCampaign(baseUrl, code);
  assert.equal(
    campaignAfterNack.quarantinedCalls.some((call) =>
      call.workerId === "device-manual" && call.kind === "manual"
    ),
    true
  );

  const unprovenTerminalAckWait = eventOnce(phone, "phone:status_ack");
  phone.emit("phone:status", {
    callState: "idle",
    phoneNumber: firstCommand.phoneNumber,
    commandId: "untracked-terminal-without-proof",
    callDirection: "outgoing",
    source: "integration_test",
    physicalObserved: true,
    noLiveCalls: false
  });
  const unprovenTerminalAck = await unprovenTerminalAckWait;
  assert.equal(unprovenTerminalAck.accepted, false);
  assert.equal(unprovenTerminalAck.terminal, false);
  assert.equal((await readWorkers(baseUrl, code))[0].callState, "blocked");
  assert.equal(
    (await readCampaign(baseUrl, code)).quarantinedCalls.some((call) =>
      call.workerId === "device-manual"
    ),
    true
  );

  const provenTerminalAckWait = eventOnce(phone, "phone:status_ack");
  phone.emit("phone:status", {
    callState: "idle",
    phoneNumber: firstCommand.phoneNumber,
    commandId: "untracked-terminal-with-proof",
    callDirection: "outgoing",
    source: "integration_test",
    physicalObserved: true,
    noLiveCalls: true
  });
  const provenTerminalAck = await provenTerminalAckWait;
  assert.equal(provenTerminalAck.accepted, true);
  assert.equal(provenTerminalAck.terminal, true);
  await waitForValue(
    () => readWorkers(baseUrl, code),
    (workers) => workers[0]?.callState === "idle",
    "worker idle after manual NACK"
  );
  assert.equal(
    (await readCampaign(baseUrl, code)).quarantinedCalls.some((call) =>
      call.workerId === "device-manual"
    ),
    false
  );

  const secondCommandWait = eventOnce(phone, "call:action");
  dashboard.emit("call:action", {
    action: "dial",
    phoneNumber: "998347281",
    commandId: "manual-rejected-2"
  });
  const secondCommand = await secondCommandWait;
  assert.equal(secondCommand.action, "dial");
  assert.equal(secondCommand.commandId, "manual-rejected-2");
  assert.equal(secondCommand.phoneNumber, "998347281");
});

test("force release retries an unbound campaign quarantine by contact id", async (t) => {
  const { baseUrl, code, dashboard, addPhone } = await createIntegrationHarness(t);
  const phone = await addPhone("Dispositivo campaña", "device-campaign-quarantine", "Xiaomi Campaign");
  const contactId = "campaign-quarantine-retry";

  const dialCommandWait = eventOnce(phone, "call:action");
  const started = await fetch(`${baseUrl}/api/session/${code}/campaign/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contacts: [
      { id: contactId, name: "Retry quarantine", phone: "979807000" }
    ] })
  });
  assert.equal(started.status, 200);
  const dialCommand = await dialCommandWait;
  assert.equal(dialCommand.contactId, contactId);

  const rejectedAckWait = eventOnce(dashboard, "phone:command_ack");
  phone.emit("phone:command_ack", {
    action: "dial",
    commandId: dialCommand.commandId,
    ok: false,
    message: "Marcación rechazada por Android"
  });
  assert.equal((await rejectedAckWait).ok, false);

  const quarantinedCampaign = await waitForValue(
    () => readCampaign(baseUrl, code),
    (campaign) => campaign.quarantinedCalls.some((call) =>
      call.workerId === "device-campaign-quarantine" &&
      call.kind === "campaign" &&
      call.contactId === contactId
    ),
    "unbound campaign call quarantined"
  );
  assert.equal(quarantinedCampaign.quarantinedContactIds.includes(contactId), true);

  const forceRelease = await fetch(`${baseUrl}/api/session/${code}/campaign/force-release`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contactId, confirm: true, retry: true })
  });
  assert.equal(forceRelease.status, 200);
  const released = await forceRelease.json();
  assert.equal(released.ok, true);
  assert.equal(released.contact.id, contactId);
  assert.equal(released.contact.status, "reintentar");
  assert.equal(released.contact.result, "reintentar");
  assert.equal(released.campaign.quarantinedContactIds.includes(contactId), false);
  assert.equal(
    released.campaign.quarantinedCalls.some((call) => call.contactId === contactId),
    false
  );
});

test("blocked and unresponsive workers recover on idle and resume the campaign", async (t) => {
  const { baseUrl, code, addPhone } = await createIntegrationHarness(t);
  const phone = await addPhone("Dispositivo recuperación", "device-recovery", "Xiaomi Recovery");

  const firstCommandWait = eventOnce(phone, "call:action");
  const started = await fetch(`${baseUrl}/api/session/${code}/campaign/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contacts: [
      { id: "blocked-contact", name: "Blocked", phone: "979807000" },
      { id: "unresponsive-contact", name: "Unresponsive", phone: "998347281" },
      { id: "recovered-contact", name: "Recovered", phone: "940189035" }
    ] })
  });
  assert.equal(started.status, 200);
  const firstCommand = await firstCommandWait;

  phone.emit("phone:command_ack", {
    action: "dial",
    commandId: firstCommand.commandId,
    ok: false,
    message: "Marcación bloqueada"
  });
  await waitForValue(
    () => readWorkers(baseUrl, code),
    (workers) => workers[0]?.callState === "blocked",
    "worker blocked"
  );

  phone.emit("phone:status", {
    callState: "idle",
    source: "integration_test",
    physicalObserved: true
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal((await readWorkers(baseUrl, code))[0].callState, "blocked");

  const secondCommandWait = eventOnce(phone, "call:action");
  phone.emit("phone:status", {
    callState: "idle",
    source: "integration_test",
    physicalObserved: true,
    noLiveCalls: true
  });
  const secondCommand = await secondCommandWait;
  assert.equal(secondCommand.contactId, "unresponsive-contact");

  await waitForValue(
    () => readWorkers(baseUrl, code),
    (workers) => workers[0]?.callState === "unresponsive",
    "worker unresponsive",
    12_500
  );

  phone.emit("phone:status", {
    callState: "idle",
    source: "integration_test",
    physicalObserved: true
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal((await readWorkers(baseUrl, code))[0].callState, "unresponsive");

  const thirdCommandWait = eventOnce(phone, "call:action");
  phone.emit("phone:status", {
    callState: "idle",
    source: "integration_test",
    physicalObserved: true,
    noLiveCalls: true
  });
  const thirdCommand = await thirdCommandWait;
  assert.equal(thirdCommand.contactId, "recovered-contact");

  const campaign = await readCampaign(baseUrl, code);
  const byId = new Map(campaign.contacts.map((contact) => [contact.id, contact]));
  assert.equal(byId.get("blocked-contact").status, "failed");
  assert.equal(byId.get("unresponsive-contact").status, "failed");
  assert.equal(byId.get("recovered-contact").status, "dialing");
});

test("skip waits for a correlated ended before dispatching the next dial", async (t) => {
  const { baseUrl, code, dashboard, addPhone } = await createIntegrationHarness(t);
  const phone = await addPhone("Dispositivo skip", "device-skip", "Xiaomi Skip");

  const dialCommandWait = eventOnce(phone, "call:action");
  const started = await fetch(`${baseUrl}/api/session/${code}/campaign/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contacts: [
      { id: "skip-contact", name: "Skip", phone: "979807000" },
      { id: "next-contact", name: "Next", phone: "998347281" }
    ] })
  });
  assert.equal(started.status, 200);
  const dialCommand = await dialCommandWait;

  const inCallAckWait = eventOnce(phone, "phone:status_ack");
  phone.emit("phone:status", {
    callState: "in_call",
    phoneNumber: dialCommand.phoneNumber,
    contactId: dialCommand.contactId,
    commandId: dialCommand.commandId,
    callDirection: "outgoing",
    source: "integration_test",
    physicalObserved: true
  });
  const inCallAck = await inCallAckWait;
  assert.equal(inCallAck.accepted, true);

  const hangupCommandWait = eventOnce(phone, "call:action");
  const skippedResponse = await fetch(`${baseUrl}/api/session/${code}/campaign/skip`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contactId: dialCommand.contactId })
  });
  assert.equal(skippedResponse.status, 200);
  const hangupCommand = await hangupCommandWait;
  assert.equal(hangupCommand.action, "hangup");
  assert.equal(hangupCommand.contactId, dialCommand.contactId);
  assert.ok(hangupCommand.commandId);
  assert.notEqual(hangupCommand.commandId, dialCommand.commandId);

  const hangupAckWait = eventOnce(dashboard, "phone:command_ack");
  phone.emit("phone:command_ack", {
    action: "hangup",
    commandId: hangupCommand.commandId,
    ok: true,
    message: "Corte aceptado"
  });
  const hangupAck = await hangupAckWait;
  assert.equal(hangupAck.commandId, hangupCommand.commandId);
  assert.equal(hangupAck.ok, true);

  const callsBeforeEnded = [];
  const captureBeforeEnded = (payload) => callsBeforeEnded.push(payload);
  phone.on("call:action", captureBeforeEnded);
  await new Promise((resolve) => setTimeout(resolve, 250));
  phone.off("call:action", captureBeforeEnded);
  assert.deepEqual(callsBeforeEnded, []);

  const campaignBeforeEnded = await readCampaign(baseUrl, code);
  const beforeById = new Map(campaignBeforeEnded.contacts.map((contact) => [contact.id, contact]));
  assert.equal(beforeById.get("skip-contact").status, "in_call");
  assert.equal(beforeById.get("next-contact").status, "pending");

  const nextDialWait = eventOnce(phone, "call:action");
  phone.emit("phone:status", {
    callState: "ended",
    phoneNumber: dialCommand.phoneNumber,
    contactId: dialCommand.contactId,
    commandId: dialCommand.commandId,
    callDirection: "outgoing",
    source: "integration_test",
    physicalObserved: true,
    noLiveCalls: true
  });
  const nextDial = await nextDialWait;
  assert.equal(nextDial.action, "dial");
  assert.equal(nextDial.contactId, "next-contact");
  assert.ok(nextDial.commandId);
  assert.notEqual(nextDial.commandId, dialCommand.commandId);
  assert.notEqual(nextDial.commandId, hangupCommand.commandId);

  const campaignAfterEnded = await readCampaign(baseUrl, code);
  const afterById = new Map(campaignAfterEnded.contacts.map((contact) => [contact.id, contact]));
  assert.equal(afterById.get(nextDial.contactId).status, "dialing");
});

test("rejected campaign hangup keeps correlation and ignores an unrelated terminal", async (t) => {
  const { baseUrl, code, dashboard, addPhone } = await createIntegrationHarness(t);
  const phone = await addPhone("Dispositivo corte", "device-hangup", "Xiaomi Hangup");

  const dialCommandWait = eventOnce(phone, "call:action");
  const started = await fetch(`${baseUrl}/api/session/${code}/campaign/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contacts: [
      { id: "hangup-contact", name: "Hangup", phone: "979807000" },
      { id: "after-hangup", name: "After", phone: "998347281" }
    ] })
  });
  assert.equal(started.status, 200);
  const dialCommand = await dialCommandWait;

  const inCallAckWait = eventOnce(phone, "phone:status_ack");
  phone.emit("phone:status", {
    callState: "in_call",
    phoneNumber: dialCommand.phoneNumber,
    contactId: dialCommand.contactId,
    commandId: dialCommand.commandId,
    callDirection: "outgoing",
    source: "integration_test",
    physicalObserved: true
  });
  assert.equal((await inCallAckWait).accepted, true);

  const hangupCommandWait = eventOnce(phone, "call:action");
  dashboard.emit("call:action", { action: "hangup", commandId: "dashboard-hangup-1" });
  const hangupCommand = await hangupCommandWait;
  assert.equal(hangupCommand.action, "hangup");
  assert.equal(hangupCommand.contactId, dialCommand.contactId);
  assert.equal(hangupCommand.commandId, "dashboard-hangup-1");

  phone.emit("phone:command_ack", {
    action: "hangup",
    commandId: hangupCommand.commandId,
    ok: false,
    message: "Android no pudo cortar"
  });
  await waitForValue(
    () => readWorkers(baseUrl, code),
    (workers) => workers[0]?.callState === "blocked",
    "worker quarantined after rejected hangup"
  );

  const unexpectedDials = [];
  const captureUnexpected = (payload) => unexpectedDials.push(payload);
  phone.on("call:action", captureUnexpected);
  phone.emit("phone:status", {
    callState: "ended",
    phoneNumber: "966407384",
    callDirection: "incoming",
    source: "integration_test",
    physicalObserved: true
  });
  await new Promise((resolve) => setTimeout(resolve, 250));
  phone.off("call:action", captureUnexpected);
  assert.deepEqual(unexpectedDials, []);
  assert.equal((await readWorkers(baseUrl, code))[0].callState, "blocked");

  const nextDialWait = eventOnce(phone, "call:action");
  phone.emit("phone:status", {
    callState: "ended",
    phoneNumber: dialCommand.phoneNumber,
    contactId: dialCommand.contactId,
    commandId: dialCommand.commandId,
    callDirection: "outgoing",
    source: "integration_test",
    physicalObserved: true,
    noLiveCalls: true
  });
  const nextDial = await nextDialWait;
  assert.equal(nextDial.contactId, "after-hangup");

  const campaign = await readCampaign(baseUrl, code);
  const completed = campaign.contacts.find((contact) => contact.id === "hangup-contact");
  assert.equal(completed.status, "completed");
  assert.equal(completed.result, "contactado");
});

test("manual call owner isolates state and audio until the call ends", async (t) => {
  const { baseUrl, code, dashboard, addPhone } = await createIntegrationHarness(t);
  const phoneA = await addPhone("Dispositivo A", "device-owner-a", "Xiaomi Owner A");
  const phoneB = await addPhone("Dispositivo B", "device-owner-b", "Xiaomi Owner B");
  const manualNumber = "979807000";
  const incomingNumber = "966407384";

  const dialCommandWait = eventOnce(phoneA, "call:action");
  dashboard.emit("call:action", {
    action: "dial",
    phoneNumber: manualNumber,
    contactName: "Llamada manual A",
    commandId: "manual-owner-a"
  });
  const dialCommand = await dialCommandWait;
  assert.equal(dialCommand.action, "dial");
  assert.equal(dialCommand.commandId, "manual-owner-a");

  const prematureManualIdleAckWait = eventOnce(phoneA, "phone:status_ack");
  phoneA.emit("phone:status", {
    callState: "idle",
    phoneNumber: dialCommand.phoneNumber,
    commandId: dialCommand.commandId,
    contactId: dialCommand.contactId,
    callDirection: "outgoing",
    source: "integration_test",
    physicalObserved: true
  });
  const prematureManualIdleAck = await prematureManualIdleAckWait;
  assert.equal(prematureManualIdleAck.accepted, false);
  assert.equal(prematureManualIdleAck.terminal, false);
  assert.equal(
    (await readWorkers(baseUrl, code)).find((worker) => worker.id === "device-owner-a")?.callState,
    "dialing"
  );

  const ownerInCallAckWait = eventOnce(phoneA, "phone:status_ack");
  phoneA.emit("phone:status", {
    callState: "in_call",
    phoneNumber: dialCommand.phoneNumber,
    commandId: dialCommand.commandId,
    contactId: dialCommand.contactId,
    callDirection: "outgoing",
    source: "integration_test",
    physicalObserved: true
  });
  assert.equal((await ownerInCallAckWait).accepted, true);

  const competingStateWait = eventOnceMatching(
    dashboard,
    "state:changed",
    (state) => state.phoneWorkers.some((worker) =>
      worker.id === "device-owner-b" && worker.callState === "in_call"
    )
  );
  phoneB.emit("phone:status", {
    callState: "in_call",
    phoneNumber: incomingNumber,
    callDirection: "incoming",
    source: "integration_test",
    physicalObserved: true
  });
  const competingState = await competingStateWait;
  assert.equal(competingState.callState, "in_call");
  assert.equal(competingState.lastNumber, manualNumber);
  assert.equal(competingState.phoneDevice.id, "device-owner-a");
  assert.equal(competingState.phoneWorkers.find((worker) => worker.id === "device-owner-a")?.active, true);
  assert.equal(competingState.phoneWorkers.find((worker) => worker.id === "device-owner-b")?.callState, "in_call");
  assert.equal(competingState.phoneWorkers.find((worker) => worker.id === "device-owner-b")?.currentNumber, incomingNumber);

  const relayedPhoneAudio = [];
  const capturePhoneAudio = (payload) => relayedPhoneAudio.push(Buffer.from(payload));
  dashboard.on("audio:phone", capturePhoneAudio);
  phoneB.emit("audio:phone", Buffer.from([0x42]));
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(relayedPhoneAudio, []);

  const ownerPhoneAudioWait = eventOnce(dashboard, "audio:phone");
  const ownerPhoneFrame = Buffer.from([0x41]);
  phoneA.emit("audio:phone", ownerPhoneFrame);
  assert.deepEqual(Buffer.from(await ownerPhoneAudioWait), ownerPhoneFrame);
  dashboard.off("audio:phone", capturePhoneAudio);
  assert.deepEqual(relayedPhoneAudio, [ownerPhoneFrame]);

  const standbyDashboardAudio = [];
  const captureStandbyAudio = (payload) => standbyDashboardAudio.push(Buffer.from(payload));
  phoneB.on("audio:dashboard", captureStandbyAudio);
  const ownerDashboardAudioWait = eventOnce(phoneA, "audio:dashboard");
  const dashboardFrame = Buffer.from([0x51]);
  dashboard.emit("audio:dashboard", dashboardFrame);
  assert.deepEqual(Buffer.from(await ownerDashboardAudioWait), dashboardFrame);
  await new Promise((resolve) => setTimeout(resolve, 150));
  phoneB.off("audio:dashboard", captureStandbyAudio);
  assert.deepEqual(standbyDashboardAudio, []);

  const ownerEndedAckWait = eventOnce(phoneA, "phone:status_ack");
  const failoverStateWait = eventOnceMatching(
    dashboard,
    "state:changed",
    (state) => state.phoneDevice?.id === "device-owner-b" && state.lastNumber === incomingNumber
  );
  phoneA.emit("phone:status", {
    callState: "ended",
    phoneNumber: dialCommand.phoneNumber,
    commandId: dialCommand.commandId,
    contactId: dialCommand.contactId,
    callDirection: "outgoing",
    source: "integration_test",
    physicalObserved: true,
    noLiveCalls: true
  });
  const [ownerEndedAck, failoverState] = await Promise.all([ownerEndedAckWait, failoverStateWait]);
  assert.equal(ownerEndedAck.accepted, true);
  assert.equal(ownerEndedAck.terminal, true);
  assert.equal(failoverState.callState, "in_call");
  assert.equal(failoverState.lastNumber, incomingNumber);
  assert.equal(failoverState.phoneDevice.id, "device-owner-b");
  assert.equal(failoverState.phoneWorkers.find((worker) => worker.id === "device-owner-b")?.active, true);

  const incomingEndedStateWait = eventOnceMatching(
    dashboard,
    "state:changed",
    (state) => state.phoneWorkers.some((worker) =>
      worker.id === "device-owner-b" && worker.callState === "ended"
    )
  );
  phoneB.emit("phone:status", {
    callState: "ended",
    phoneNumber: incomingNumber,
    callDirection: "incoming",
    source: "integration_test",
    physicalObserved: true,
    noLiveCalls: true
  });
  const incomingEndedState = await incomingEndedStateWait;
  assert.equal(incomingEndedState.callState, "ended");
  assert.equal(
    incomingEndedState.phoneWorkers.find((worker) => worker.id === "device-owner-b")?.callState,
    "ended"
  );
});

test("manual hangup disconnected before confirmation is force released by worker id", async (t) => {
  const { baseUrl, code, dashboard, addPhone } = await createIntegrationHarness(t);
  const workerId = "device-manual-quarantine";
  const phone = await addPhone("Dispositivo cuarentena", workerId, "Xiaomi Quarantine");

  const dialCommandWait = eventOnce(phone, "call:action");
  dashboard.emit("call:action", {
    action: "dial",
    phoneNumber: "979807000",
    commandId: "manual-quarantine-dial"
  });
  const dialCommand = await dialCommandWait;

  const inCallAckWait = eventOnce(phone, "phone:status_ack");
  phone.emit("phone:status", {
    callState: "in_call",
    phoneNumber: dialCommand.phoneNumber,
    commandId: dialCommand.commandId,
    contactId: dialCommand.contactId,
    callDirection: "outgoing",
    source: "integration_test",
    physicalObserved: true
  });
  assert.equal((await inCallAckWait).accepted, true);

  const hangupCommandWait = eventOnce(phone, "call:action");
  dashboard.emit("call:action", {
    action: "hangup",
    commandId: "manual-quarantine-hangup"
  });
  const hangupCommand = await hangupCommandWait;
  assert.equal(hangupCommand.action, "hangup");
  assert.equal(hangupCommand.commandId, "manual-quarantine-hangup");

  phone.disconnect();
  const quarantinedCampaign = await waitForValue(
    () => readCampaign(baseUrl, code),
    (campaign) => campaign.quarantinedCalls.some((call) =>
      call.workerId === workerId && call.kind === "manual"
    ),
    "manual call quarantined after disconnect"
  );
  const quarantinedCall = quarantinedCampaign.quarantinedCalls.find((call) => call.workerId === workerId);
  assert.equal(quarantinedCall.kind, "manual");
  assert.equal(quarantinedCall.phoneNumber, dialCommand.phoneNumber);
  assert.equal(quarantinedCall.callState, "offline");

  const forceRelease = await fetch(`${baseUrl}/api/session/${code}/campaign/force-release`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workerId, confirm: true })
  });
  assert.equal(forceRelease.status, 200);
  const released = await forceRelease.json();
  assert.equal(released.ok, true);
  assert.equal(released.campaign.quarantinedCalls.some((call) => call.workerId === workerId), false);

  const campaignAfterRelease = await readCampaign(baseUrl, code);
  assert.equal(campaignAfterRelease.quarantinedCalls.some((call) => call.workerId === workerId), false);
});
