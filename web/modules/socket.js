const apiBaseFromQuery = new URLSearchParams(window.location.search).get("apiBase");
const API_BASE = String(window.VOIP_VC_API_BASE || apiBaseFromQuery || window.location.origin).replace(/\/+$/, "");

// Note: Assuming io is already available globally from the <script> tag in index.html
export const socket = io(API_BASE, { 
  transports: ["websocket"],
  timeout: 60000
});
export { API_BASE };
