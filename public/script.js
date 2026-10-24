const API = "/.netlify/functions/api";
let session = null; // {owner_id, store_name}
let categories = [];
let products = [];
let activeCustomerId = null;
let summaryPeriod = "week";

function peso(n) { return "₱" + Number(n).toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2}); }

// ignore repeat taps while a request is running (prevents duplicate customers / payments)
function once(btnId, fn) {
  const btn = document.getElementById(btnId);
  let busy = false;
  btn.onclick = async () => {
    if (busy) return;
    busy = true;
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Please wait...";
    try { await fn(); }
    finally { busy = false; btn.disabled = false; btn.textContent = label; }
  };
}

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, ch => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[ch]));
}

// ---- session (stays logged in after refresh / reopen) ----
const SESSION_KEY = "tintaly_session";
function saveSession(s) {
  session = s;
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch {}
}
function loadSession() {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY));
    return s && s.owner_id ? s : null;
  } catch { return null; }
}
function doLogout() {
  if (!confirm("Log out of Tintaly?")) return;
  session = null;
  activeCustomerId = null;
  selectedCat = null;
  try { localStorage.removeItem(SESSION_KEY); } catch {}
  document.getElementById("login-user").value = "";
  document.getElementById("login-pass").value = "";
  document.getElementById("login-err").textContent = "";
  show("s-login");
}

async function api(action, opts = {}) {
  const { method = "GET", params = {}, body = null } = opts;
  const qs = new URLSearchParams({ action, ...params }).toString();
  const res = await fetch(`${API}?${qs}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

const NAV_ITEMS = [
  ["Dashboard", "s-dashboard", "dashboard.png"],
  ["Customer", "s-customers", "customer.png"],
  ["Add Customer", "s-addcustomer", "add_customer.png"],
  ["Products", "s-products", "products.png"],
  ["Summary", "s-summary", "summary.png"],
];
function buildNav(id, activeKey) {
  const el = document.getElementById(id); el.innerHTML = "";
  NAV_ITEMS.forEach(([label, key, icon]) => {
    const b = document.createElement("button");
    const img = document.createElement("img");
    img.src = `icon_file/${icon}`;
    img.alt = "";
    img.setAttribute("aria-hidden", "true");
    const text = document.createElement("span");
    text.textContent = label;
    b.append(img, text);
    if (key === activeKey) b.classList.add("active");
    b.onclick = () => show(key);
    el.appendChild(b);
  });
}

async function show(id) {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  document.getElementById(id).classList.add("active");
  try {
    if (id === "s-dashboard") { buildNav("nav-dashboard","s-dashboard"); await renderDashboard(); }
    if (id === "s-customers") { buildNav("nav-customers","s-customers"); await renderCustomers(); }
    if (id === "s-products") { buildNav("nav-products","s-products"); await renderProducts(); }
    if (id === "s-summary") { buildNav("nav-summary","s-summary"); await renderSummary(); }
    if (id === "s-addcustomer") { await loadProductsForItems(); resetItemRows("ac-items"); }
    if (id === "s-addproduct") { await renderCatOptions(); }
  } catch (e) { alert(e.message); }
}

// ---- auth ----
async function doLogin() {
  const username = document.getElementById("login-user").value.trim();
  const password = document.getElementById("login-pass").value;
  const err = document.getElementById("login-err");
  if (!username || !password) { err.textContent = "Username and password are required."; return; }
  try {
    saveSession(await api("login", { method: "POST", body: { username, password } }));
    document.getElementById("login-pass").value = "";
    err.textContent = "";
    show("s-dashboard");
  } catch (e) { err.textContent = e.message; }
}

async function doCreate() {
  const fields = {
    username: document.getElementById("c-user").value.trim(),
    email: document.getElementById("c-email").value.trim(),
    password: document.getElementById("c-pass").value,
    store_name: document.getElementById("c-store").value.trim(),
  };
  const err = document.getElementById("create-err");
  const missing = Object.entries(fields).filter(([,v]) => !v).map(([k]) => k);
  if (missing.length) { err.textContent = "Please fill in: " + missing.join(", "); return; }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields.email)) { err.textContent = "Please enter a valid e-mail address."; return; }
  if (fields.password.length < 6) { err.textContent = "Password must be at least 6 characters."; return; }
  const pass2 = document.getElementById("c-pass2").value;
  if (!pass2) { err.textContent = "Please re-enter your password."; return; }
  if (fields.password !== pass2) { err.textContent = "Passwords do not match."; return; }
  try {
    saveSession(await api("create_account", { method: "POST", body: fields }));
    ["c-user","c-email","c-pass","c-pass2","c-store"].forEach(id => document.getElementById(id).value = "");
    err.textContent = "";
    show("s-dashboard");
  } catch (e) { err.textContent = e.message; }
}

// ---- dashboard ----
async function renderDashboard() {
  document.getElementById("d-store").textContent = session.store_name;
  const totals = await api("dashboard_totals", { params: { owner_id: session.owner_id } });
  document.getElementById("d-total").textContent = peso(totals.total);
  document.getElementById("d-active").textContent = totals.active + " Active customer";
  const customers = await api("customers", { params: { owner_id: session.owner_id, search: "" } });
  const list = document.getElementById("d-list"); list.innerHTML = "";
  customers.slice(0, 10).forEach(c => {
    const row = document.createElement("div"); row.className = "row";
    row.innerHTML = `<b>${esc(c.full_name)}</b><span class="money-red">${peso(c.balance)}</span>`;
    list.appendChild(row);
  });
}

// ---- customers ----
async function renderCustomers() {
  document.getElementById("cu-store").textContent = session.store_name;
  const q = document.getElementById("cu-search").value;
  const customers = await api("customers", { params: { owner_id: session.owner_id, search: q } });
  const list = document.getElementById("cu-list"); list.innerHTML = "";
  customers.forEach(c => {
    const row = document.createElement("div"); row.className = "row"; row.style.cursor = "pointer";
    row.innerHTML = `<div><b>${esc(c.full_name)}</b><br><span class="small" style="color:var(--gray)">${esc(c.contact_number)}</span></div>
      <span class="${c.balance > 0 ? "money-red" : "money-green"}">${peso(c.balance)}</span>`;
    row.onclick = () => { activeCustomerId = c.customer_id; renderDetail(); show("s-detail"); };
    list.appendChild(row);
  });
}

// ---- shared item rows (add-customer + purchase) ----
async function loadProductsForItems() {
  products = await api("products", { params: { owner_id: session.owner_id } });
}
function itemRowEl() {
  const div = document.createElement("div");
  div.className = "itemRow";
  const opts = products.map(p => `<option value="${p.product_id}">${esc(p.product_name)} (${esc(p.category_name || "Uncategorized")})</option>`).join("");
  div.innerHTML = `
    <select class="item-product">${opts || "<option>No products yet</option>"}</select>
    <div class="qtyrow">
      <span>Qty:</span><input class="item-qty" type="number" min="0" value="0">
      <span class="item-price small">Price: 0</span>
    </div>`;
  div.querySelector(".item-product").onchange = () => updateTotals();
  div.querySelector(".item-qty").oninput = () => updateTotals();
  return div;
}
function resetItemRows(containerId) {
  const el = document.getElementById(containerId);
  el.innerHTML = "";
  el.appendChild(itemRowEl());
  updateTotals();
}
function getItems(containerId) {
  const rows = document.getElementById(containerId).querySelectorAll(".itemRow");
  const items = [];
  rows.forEach(r => {
    const pid = parseInt(r.querySelector(".item-product").value);
    const qty = parseInt(r.querySelector(".item-qty").value || 0);
    const prod = products.find(p => p.product_id === pid);
    if (prod) {
      r.querySelector(".item-price").textContent = "Price: " + prod.price;
      if (qty > 0) items.push({ product_id: prod.product_id, quantity: qty, unit_price: parseFloat(prod.price) });
    }
  });
  return items;
}
function updateTotals() {
  [["ac-items","ac-total"], ["pp-items","pp-total"]].forEach(([cid, tid]) => {
    const el = document.getElementById(cid);
    if (!el) return;
    const items = getItems(cid);
    const total = items.reduce((s, i) => s + i.quantity * i.unit_price, 0);
    document.getElementById(tid).textContent = peso(total);
  });
}

// ---- add customer ----
async function doAddCustomer() {
  const full_name = document.getElementById("ac-name").value.trim();
  const contact_number = document.getElementById("ac-number").value.trim();
  const err = document.getElementById("ac-err");
  if (!full_name) { err.textContent = "Customer name is required."; return; }
  if (!contact_number) { err.textContent = "Contact number is required."; return; }
  if (!/^\d{11}$/.test(contact_number)) {
    err.textContent = `Contact number must be exactly 11 digits (you entered ${contact_number.length}).`;
    return;
  }
  try {
    const { customer_id } = await api("add_customer", { method: "POST", body: { owner_id: session.owner_id, full_name, contact_number } });
    const items = getItems("ac-items");
    if (items.length) await api("add_purchase", { method: "POST", body: { customer_id, items } });
    err.textContent = "";
    document.getElementById("ac-name").value = ""; document.getElementById("ac-number").value = "";
    show("s-customers");
  } catch (e) { err.textContent = e.message; }
}

// ---- products ----
let selectedCat = null;
async function renderProducts() {
  document.getElementById("p-store").textContent = session.store_name;
  categories = await api("categories", { params: { owner_id: session.owner_id } });
  const chips = document.getElementById("p-chips"); chips.innerHTML = "";
  const allBtn = document.createElement("button");
  allBtn.className = "chip" + (selectedCat === null ? " sel" : ""); allBtn.textContent = "All";
  allBtn.onclick = () => { selectedCat = null; renderProducts(); }; chips.appendChild(allBtn);
  categories.forEach(cat => {
    const b = document.createElement("button");
    b.className = "chip" + (selectedCat === cat.category_id ? " sel" : ""); b.textContent = cat.category_name;
    b.onclick = () => { selectedCat = cat.category_id; renderProducts(); }; chips.appendChild(b);
  });
  const list = document.getElementById("p-list"); list.innerHTML = "";
  const prods = await api("products", { params: { owner_id: session.owner_id, category_id: selectedCat || "" } });
  prods.forEach(p => {
    const row = document.createElement("div"); row.className = "row";
    row.innerHTML = `<div><b>${esc(p.product_name)}</b><br><span class="small" style="color:var(--gray)">${esc(p.category_name || "Uncategorized")}</span></div><span>${peso(p.price)}</span>`;
    list.appendChild(row);
  });
}
async function renderCatOptions() {
  categories = await api("categories", { params: { owner_id: session.owner_id } });
  const sel = document.getElementById("ap-cat"); sel.innerHTML = "";
  categories.forEach(c => { const o = document.createElement("option"); o.value = c.category_id; o.textContent = c.category_name; sel.appendChild(o); });
}
async function doAddProduct() {
  const product_name = document.getElementById("ap-name").value.trim();
  const price = parseFloat(document.getElementById("ap-price").value);
  const err = document.getElementById("ap-err");
  if (!product_name || isNaN(price) || price <= 0) { err.textContent = "Product name and a price above 0 are required."; return; }
  try {
    await api("add_product", { method: "POST", body: { owner_id: session.owner_id, category_id: document.getElementById("ap-cat").value, product_name, price } });
    err.textContent = "";
    document.getElementById("ap-name").value = ""; document.getElementById("ap-price").value = "";
    show("s-products");
  } catch (e) { err.textContent = e.message; }
}

// ---- customer detail & purchase/payment ----
async function renderDetail() {
  const c = await api("customer", { params: { customer_id: activeCustomerId } });
  document.getElementById("det-name").textContent = c.full_name;
  document.getElementById("det-balance").textContent = peso(c.balance);
  const hist = document.getElementById("det-history"); hist.innerHTML = "";
  const txns = await api("customer_history", { params: { customer_id: activeCustomerId } });
  txns.forEach(t => {
    const isP = t.transaction_type === "purchase";
    const row = document.createElement("div"); row.className = "row";
    row.innerHTML = `<div><b style="color:${isP ? "var(--red)" : "var(--green)"}">${isP ? "UNPAID" : "PAID"}</b><br>
      <span class="small" style="color:var(--gray)">${esc(t.product_names || "Payment")}</span><br>
      <span class="small" style="color:var(--gray)">${t.transaction_date}</span></div>
      <span style="color:${isP ? "var(--red)" : "var(--green)"};font-weight:bold;">${isP ? "+" : "-"}${peso(t.amount)}</span>`;
    hist.appendChild(row);
  });
}
async function openPurchase() {
  await loadProductsForItems();
  resetItemRows("pp-items");
  document.getElementById("pp-amount").value = "";
  document.getElementById("pp-err").textContent = "";
  show("s-purchase");
}
async function doPurchase() {
  const items = getItems("pp-items");
  const err = document.getElementById("pp-err");
  if (!items.length) { err.textContent = "Choose a product and quantity."; return; }
  try {
    await api("add_purchase", { method: "POST", body: { customer_id: activeCustomerId, items } });
    await renderDetail(); show("s-detail");
  } catch (e) { err.textContent = e.message; }
}
async function doPayment() {
  const amount = parseFloat(document.getElementById("pp-amount").value);
  const err = document.getElementById("pp-err");
  if (!amount || amount <= 0) { err.textContent = "Enter an amount to pay."; return; }
  try {
    await api("add_payment", { method: "POST", body: { customer_id: activeCustomerId, amount } });
    await renderDetail(); show("s-detail");
  } catch (e) { err.textContent = e.message; }
}

// ---- summary ----
async function renderSummary() {
  document.getElementById("sm-store").textContent = session.store_name;
  const tog = document.getElementById("sm-toggles"); tog.innerHTML = "";
  [["Week","week"],["Month","month"],["Year","year"]].forEach(([label, key]) => {
    const b = document.createElement("button");
    b.textContent = label; if (key === summaryPeriod) b.classList.add("sel");
    b.onclick = () => { summaryPeriod = key; renderSummary(); };
    tog.appendChild(b);
  });
  const data = await api("summary", { params: { owner_id: session.owner_id, period: summaryPeriod } });
  document.getElementById("sm-unpaid").textContent = peso(data.total_unpaid);
  document.getElementById("sm-paid").textContent = peso(data.total_paid);
  const list = document.getElementById("sm-list"); list.innerHTML = "";
  data.rows.forEach(r => {
    const isP = r.transaction_type === "purchase";
    const row = document.createElement("div"); row.className = "row";
    row.innerHTML = `<div><b>${esc(r.full_name)}</b><br><span class="small" style="color:var(--gray)">${r.transaction_date}</span></div>
      <span style="color:${isP ? "var(--red)" : "var(--green)"};font-weight:bold;">${isP ? "+" : "-"}${peso(r.amount)}</span>`;
    list.appendChild(row);
  });
}

// ---- wire up static buttons ----
document.querySelectorAll("[data-goto]").forEach(el => el.addEventListener("click", () => show(el.dataset.goto)));
once("btn-login", doLogin);
once("btn-create", doCreate);
once("btn-addcustomer", doAddCustomer);
once("btn-addproduct", doAddProduct);
document.getElementById("ac-additem").onclick = () => { document.getElementById("ac-items").appendChild(itemRowEl()); updateTotals(); };
document.getElementById("pp-additem").onclick = () => { document.getElementById("pp-items").appendChild(itemRowEl()); updateTotals(); };
document.getElementById("btn-openpurchase1").onclick = openPurchase;
document.getElementById("btn-openpurchase2").onclick = openPurchase;
once("btn-dopurchase", doPurchase);
once("btn-dopayment", doPayment);
document.getElementById("cu-search").addEventListener("input", renderCustomers);

// customer number: digits only, max 11
document.getElementById("ac-number").addEventListener("input", e => {
  e.target.value = e.target.value.replace(/\D/g, "").slice(0, 11);
});

document.getElementById("btn-logout").onclick = doLogout;

// restore login after refresh / reopening the site
const savedSession = loadSession();
if (savedSession) { session = savedSession; show("s-dashboard"); }