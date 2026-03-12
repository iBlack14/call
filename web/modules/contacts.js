const CALLED_COUNTS_KEY = "voip vc.calledCounts";
const CONTACT_ROW_STATUS_KEY = "voip vc.contactRowStatus";
const NOTE_REMINDERS_DISMISSED_KEY = "voip vc.noteRemindersDismissed";

export let contacts = [];
export let calledCounts = {};
export let contactRowStatus = {};
export let dismissedReminderIds = {};

export function loadContacts() {
  try { contacts = JSON.parse(localStorage.getItem("voip vc.contacts") || "[]"); }
  catch { contacts = []; }
  return contacts;
}

export function saveContacts() {
  localStorage.setItem("voip vc.contacts", JSON.stringify(contacts));
}

export function loadCalledCounts() {
  try { calledCounts = JSON.parse(localStorage.getItem(CALLED_COUNTS_KEY) || "{}"); }
  catch { calledCounts = {}; }
  return calledCounts;
}

export function saveCalledCounts() {
  localStorage.setItem(CALLED_COUNTS_KEY, JSON.stringify(calledCounts));
}

export function loadContactRowStatus() {
  try { contactRowStatus = JSON.parse(localStorage.getItem(CONTACT_ROW_STATUS_KEY) || "{}"); }
  catch { contactRowStatus = {}; }
  return contactRowStatus;
}

export function saveContactRowStatus() {
  localStorage.setItem(CONTACT_ROW_STATUS_KEY, JSON.stringify(contactRowStatus));
}

export function loadDismissedReminders() {
  try { dismissedReminderIds = JSON.parse(localStorage.getItem(NOTE_REMINDERS_DISMISSED_KEY) || "{}"); }
  catch { dismissedReminderIds = {}; }
  return dismissedReminderIds;
}

export function saveDismissedReminders() {
  localStorage.setItem(NOTE_REMINDERS_DISMISSED_KEY, JSON.stringify(dismissedReminderIds));
}

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
}

export function addContact(contact) {
  contacts.unshift(contact);
  saveContacts();
}
