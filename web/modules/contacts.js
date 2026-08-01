const CALLED_COUNTS_KEY = "voip vc.calledCounts";
const CONTACT_ROW_STATUS_KEY = "voip vc.contactRowStatus";
const CONTACT_CALL_DURATIONS_KEY = "voip vc.callDurations";
const NOTE_REMINDERS_DISMISSED_KEY = "voip vc.noteRemindersDismissed";

export let contacts = [];
export let calledCounts = {};
export let contactRowStatus = {};
export let callDurations = {};
export let dismissedReminderIds = {};
export let lists = ["Principal"];
export let activeList = "Principal";

const LISTS_KEY = "voip vc.lists";
let persistenceListener = null;
let applyingSnapshot = false;

function notifyPersistence() {
  if (!applyingSnapshot && typeof persistenceListener === "function") persistenceListener();
}

export function setPersistenceListener(listener) {
  persistenceListener = typeof listener === "function" ? listener : null;
}

export function getSnapshot() {
  return {
    contacts,
    lists,
    activeList,
    calledCounts,
    contactRowStatus,
    callDurations,
    dismissedReminderIds
  };
}

export function applySnapshot(snapshot = {}) {
  applyingSnapshot = true;
  contacts = Array.isArray(snapshot.contacts) ? snapshot.contacts : [];
  contacts.forEach((contact) => { if (!contact.list) contact.list = "Principal"; });
  lists = Array.isArray(snapshot.lists) && snapshot.lists.length ? snapshot.lists : ["Principal"];
  if (!lists.includes("Principal")) lists.unshift("Principal");
  activeList = lists.includes(snapshot.activeList) ? snapshot.activeList : "Principal";
  calledCounts = snapshot.calledCounts && typeof snapshot.calledCounts === "object" ? snapshot.calledCounts : {};
  contactRowStatus = snapshot.contactRowStatus && typeof snapshot.contactRowStatus === "object" ? snapshot.contactRowStatus : {};
  callDurations = snapshot.callDurations && typeof snapshot.callDurations === "object" ? snapshot.callDurations : {};
  dismissedReminderIds = snapshot.dismissedReminderIds && typeof snapshot.dismissedReminderIds === "object" ? snapshot.dismissedReminderIds : {};
  saveContacts(); saveLists(); saveCalledCounts(); saveContactRowStatus(); saveCallDurations(); saveDismissedReminders();
  applyingSnapshot = false;
}

export function loadContacts() {
  try { contacts = JSON.parse(localStorage.getItem("voip vc.contacts") || "[]"); }
  catch { contacts = []; }
  
  // Ensure all contacts have a list property
  contacts.forEach(c => { if (!c.list) c.list = "Principal"; });
  
  loadLists();
  return contacts;
}

export function loadLists() {
  try { lists = JSON.parse(localStorage.getItem(LISTS_KEY) || "[\"Principal\"]"); }
  catch { lists = ["Principal"]; }
  if (!lists.includes("Principal")) lists.unshift("Principal");
}

export function saveLists() {
  localStorage.setItem(LISTS_KEY, JSON.stringify(lists));
  notifyPersistence();
}

export function saveContacts() {
  localStorage.setItem("voip vc.contacts", JSON.stringify(contacts));
  notifyPersistence();
}

// ... original load/save functions (calledCounts, etc.) ...
export function loadCalledCounts() {
  try { calledCounts = JSON.parse(localStorage.getItem(CALLED_COUNTS_KEY) || "{}"); }
  catch { calledCounts = {}; }
  return calledCounts;
}
export function saveCalledCounts() { localStorage.setItem(CALLED_COUNTS_KEY, JSON.stringify(calledCounts)); notifyPersistence(); }
export function loadContactRowStatus() {
  try { contactRowStatus = JSON.parse(localStorage.getItem(CONTACT_ROW_STATUS_KEY) || "{}"); }
  catch { contactRowStatus = {}; }
  return contactRowStatus;
}
export function saveContactRowStatus() { localStorage.setItem(CONTACT_ROW_STATUS_KEY, JSON.stringify(contactRowStatus)); notifyPersistence(); }
export function loadCallDurations() {
  try { callDurations = JSON.parse(localStorage.getItem(CONTACT_CALL_DURATIONS_KEY) || "{}"); }
  catch { callDurations = {}; }
  return callDurations;
}
export function saveCallDurations() { localStorage.setItem(CONTACT_CALL_DURATIONS_KEY, JSON.stringify(callDurations)); notifyPersistence(); }
export function loadDismissedReminders() {
  try { dismissedReminderIds = JSON.parse(localStorage.getItem(NOTE_REMINDERS_DISMISSED_KEY) || "{}"); }
  catch { dismissedReminderIds = {}; }
  return dismissedReminderIds;
}
export function saveDismissedReminders() { localStorage.setItem(NOTE_REMINDERS_DISMISSED_KEY, JSON.stringify(dismissedReminderIds)); notifyPersistence(); }

export function updateContact(id, newData) {
  const idx = contacts.findIndex(c => c.id === id);
  if (idx !== -1) {
    contacts[idx] = { ...contacts[idx], ...newData };
    saveContacts();
    return true;
  }
  return false;
}

export function deleteContact(id) {
  contacts = contacts.filter(c => c.id !== id);
  saveContacts();
  delete calledCounts[id];
  saveCalledCounts();
  delete contactRowStatus[id];
  saveContactRowStatus();
  delete callDurations[id];
  saveCallDurations();
}

export function setActiveList(name) {
  activeList = name;
}

export function addList(name) {
  if (!lists.includes(name)) {
    lists.push(name);
    saveLists();
  }
}

export function deleteList(name) {
  if (name === "Principal") return;
  contacts = contacts.filter(c => c.list !== name);
  lists = lists.filter(l => l !== name);
  saveLists();
  saveContacts();
  if (activeList === name) activeList = "Principal";
}

export function addContact(contact, listName = "Principal") {
  addContacts([contact], listName);
}

export function addContacts(contactList, listName = "Principal") {
  const processed = contactList.map(c => ({ ...c, list: listName }));
  contacts = [...processed, ...contacts];
  saveContacts();
}
