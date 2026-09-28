const viewNames = {
  inventory: '庫存總覽',
  receipt: '進貨入庫',
  shipment: '出貨領料',
  count: '定期盤點'
};

const inventoryRows = document.querySelector('#inventory-rows');
const mobileInventoryRows = document.querySelector('#mobile-inventory-rows');
const toast = document.querySelector('#toast');
let allBatches = [];
let toastTimer;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...options.headers }
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '操作失敗，請稍後再試。');
  return data;
}

function announce(message, isError = false) {
  window.clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.toggle('is-error', isError);
  toast.classList.add('is-visible');
  toastTimer = window.setTimeout(() => toast.classList.remove('is-visible'), 4200);
}

function formatDate(value, includeTime = true) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    month: '2-digit', day: '2-digit',
    ...(includeTime ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' } : {})
  }).format(date);
}

function setToday() {
  document.querySelector('#today-label').textContent = new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short'
  }).format(new Date());
  const localNow = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000);
  document.querySelector('#received-at').value = localNow.toISOString().slice(0, 16);
}

function renderInventory() {
  const warehouseFilter = document.querySelector('#warehouse-filter').value;
  const search = document.querySelector('#inventory-search').value.trim().toLocaleLowerCase();
  const batches = allBatches.filter(batch => {
    const matchesWarehouse = warehouseFilter === 'all' || String(batch.warehouseId) === warehouseFilter;
    const matchesSearch = `${batch.itemName} ${batch.location} ${batch.warehouseName}`.toLocaleLowerCase().includes(search);
    return matchesWarehouse && matchesSearch;
  });
  inventoryRows.replaceChildren();
  mobileInventoryRows.replaceChildren();

  if (!batches.length) {
    const empty = element('td', 'empty-cell', '沒有符合條件的庫存資料');
    empty.colSpan = 5;
    inventoryRows.append(element('tr'));
    inventoryRows.firstElementChild.append(empty);
    mobileInventoryRows.append(element('p', 'activity-empty', '沒有符合條件的庫存資料'));
  }

  for (const batch of batches) {
    const row = element('tr');
    const item = element('td', 'item-cell', batch.itemName);
    item.append(element('span', 'item-sub', batch.category));
    const warehouse = element('td');
    warehouse.append(element('span', 'warehouse-label', batch.warehouseName));
    row.append(item, warehouse);
    const location = element('td');
    location.append(element('span', 'location-code', batch.location));
    row.append(location);
    const received = element('td');
    received.append(element('span', 'date-code', formatDate(batch.receivedAt)));
    row.append(received);
    row.append(element('td', 'stock-quantity', `${batch.quantity} 箱`));
    inventoryRows.append(row);

    const mobileRow = element('article', 'mobile-stock-row');
    mobileRow.append(element('span', 'mobile-stock-name', batch.itemName));
    mobileRow.append(element('span', 'mobile-stock-quantity', `${batch.quantity} 箱`));
    const details = element('span', 'mobile-stock-details');
    details.append(element('span', '', `${batch.warehouseName} · ${batch.location}`));
    details.append(element('span', '', `入庫 ${formatDate(batch.receivedAt)}`));
    mobileRow.append(details);
    mobileInventoryRows.append(mobileRow);
  }
  document.querySelector('#record-count').textContent = `${batches.length} 個儲位批次`;
}

function movementLabel(type) {
  return ({ receipt: '進貨入庫', shipment: '銷售出貨', spoilage: '腐敗報廢', count_adjustment: '盤點校正' })[type] || type;
}

async function loadActivity() {
  const list = document.querySelector('#activity-list');
  const rows = await api('/api/activity');
  list.replaceChildren();
  if (!rows.length) {
    list.append(element('p', 'activity-empty', '尚無進出庫紀錄。完成第一筆作業後，異動會顯示在這裡。'));
    return;
  }
  for (const movement of rows) {
    const row = element('div', 'activity-row');
    row.append(element('span', 'activity-time', formatDate(movement.createdAt)));
    row.append(element('span', 'activity-item', movement.itemName));
    row.append(element('span', 'activity-kind', movementLabel(movement.type)));
    row.append(element('span', '', `${movement.warehouseName} · ${movement.location}`));
    const signed = movement.quantity > 0 ? `+${movement.quantity}` : String(movement.quantity);
    row.append(element('span', 'activity-qty', `${signed} 箱`));
    list.append(row);
  }
}

async function loadInventory() {
  const data = await api('/api/inventory');
  allBatches = data.batches;
  document.querySelector('#total-quantity').textContent = data.totalQuantity.toLocaleString('zh-TW');
  document.querySelector('#item-count').textContent = data.itemCount.toLocaleString('zh-TW');
  document.querySelector('#warehouse-one-total').textContent = (data.warehouses.find(warehouse => warehouse.id === 1)?.quantity || 0).toLocaleString('zh-TW');
  document.querySelector('#warehouse-two-total').textContent = (data.warehouses.find(warehouse => warehouse.id === 2)?.quantity || 0).toLocaleString('zh-TW');
  renderInventory();
  await loadActivity();
}

async function loadItems() {
  const items = await api('/api/items');
  const datalist = document.querySelector('#item-options');
  const shipmentItem = document.querySelector('#shipment-item');
  datalist.replaceChildren();
  shipmentItem.replaceChildren(new Option('請選擇品項', ''));
  for (const item of items) {
    datalist.append(new Option(item.name));
    const option = new Option(`${item.name} · ${item.category}`, String(item.id));
    shipmentItem.append(option);
  }
}

function switchView(viewName) {
  for (const view of document.querySelectorAll('.view')) {
    const active = view.id === `${viewName}-view`;
    view.hidden = !active;
    view.classList.toggle('is-visible', active);
  }
  for (const button of document.querySelectorAll('.nav-link')) {
    const active = button.dataset.view === viewName;
    button.classList.toggle('is-active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  document.querySelector('#breadcrumb-current').textContent = viewNames[viewName];
  if (viewName === 'count' && !document.querySelector('#count-form').dataset.loaded) loadCountSheet();
  if (viewName === 'shipment') updateFifoSuggestion();
}

async function updateFifoSuggestion() {
  const itemId = document.querySelector('#shipment-item').value;
  const warehouseId = document.querySelector('#shipment-warehouse').value;
  const suggestion = document.querySelector('#fifo-suggestion');
  suggestion.replaceChildren(element('span', 'fifo-tag', 'FIFO'));
  if (!itemId) {
    suggestion.append(document.createTextNode('選擇品項後，顯示最早入庫儲位。'));
    return;
  }
  try {
    const query = new URLSearchParams({ itemId });
    if (warehouseId !== 'all') query.set('warehouseId', warehouseId);
    const data = await api(`/api/fifo?${query}`);
    if (!data.suggested) {
      suggestion.append(document.createTextNode('目前沒有可出貨庫存。'));
      return;
    }
    const batch = data.suggested;
    const text = element('span');
    text.append(document.createTextNode('建議先取 '));
    text.append(element('strong', '', `${batch.warehouseName} · ${batch.location}`));
    text.append(document.createTextNode(`｜${formatDate(batch.receivedAt)} 入庫，現存 ${batch.quantity} 箱`));
    suggestion.append(text);
  } catch (error) {
    suggestion.append(document.createTextNode(error.message));
  }
}

async function loadCountSheet() {
  const warehouseId = document.querySelector('#count-warehouse').value;
  const form = document.querySelector('#count-form');
  const empty = document.querySelector('#count-empty');
  const rows = document.querySelector('#count-rows');
  const button = document.querySelector('#load-count-button');
  button.disabled = true;
  button.textContent = '讀取中…';
  try {
    const data = await api(`/api/counts?warehouseId=${warehouseId}`);
    rows.replaceChildren();
    form.dataset.loaded = 'true';
    if (!data.batches.length) {
      form.hidden = true;
      empty.hidden = false;
      empty.querySelector('h2').textContent = `${data.warehouse.name}目前沒有在庫批次。`;
      empty.querySelector('p').textContent = '新增進貨後即可進行盤點。';
      return;
    }
    for (const batch of data.batches) {
      const row = element('tr');
      const item = element('td', 'item-cell', batch.itemName);
      item.append(element('span', 'item-sub', `${batch.category} · ${batch.location}`));
      row.append(item, element('td', 'stock-quantity', `${batch.quantity} 箱`));
      for (const [name, value, label] of [['countedQuantity', batch.quantity, '實際數量'], ['damagedQuantity', 0, '腐敗報廢']]) {
        const cell = element('td');
        const input = element('input');
        input.type = 'number';
        input.name = name;
        input.min = '0';
        input.step = '1';
        input.value = String(value);
        input.setAttribute('aria-label', `${batch.itemName} ${batch.location} ${label}`);
        cell.append(input);
        row.append(cell);
      }
      row.dataset.batchId = String(batch.batchId);
      rows.append(row);
    }
    form.hidden = false;
    empty.hidden = true;
    document.querySelector('#count-description').textContent = `${data.warehouse.name}｜${data.batches.length} 個在庫批次。實際數量填現場所見總箱數，腐敗報廢填其中無法售賣的箱數。`;
  } catch (error) {
    announce(error.message, true);
  } finally {
    button.disabled = false;
    button.innerHTML = '載入盤點清單 <span aria-hidden="true">↻</span>';
  }
}

async function submitForm(form, endpoint, successMessage, onSuccess) {
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const result = await onSuccess();
    announce(typeof successMessage === 'function' ? successMessage(result) : successMessage);
    await Promise.all([loadInventory(), loadItems()]);
    return result;
  } catch (error) {
    announce(error.message, true);
    return null;
  } finally {
    button.disabled = false;
  }
}

for (const button of document.querySelectorAll('.nav-link')) {
  button.addEventListener('click', () => switchView(button.dataset.view));
}

document.querySelector('#refresh-button').addEventListener('click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    await Promise.all([loadInventory(), loadItems()]);
    announce('兩座冷凍庫的庫存已更新。');
  } catch (error) {
    announce(error.message, true);
  } finally {
    button.disabled = false;
  }
});

document.querySelector('#inventory-search').addEventListener('input', renderInventory);
document.querySelector('#warehouse-filter').addEventListener('change', renderInventory);

document.querySelector('#receipt-form').addEventListener('submit', event => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = new FormData(form);
  const receivedAt = new Date(values.get('receivedAt'));
  const body = {
    itemName: values.get('itemName').trim(),
    category: values.get('category'),
    quantity: Number(values.get('quantity')),
    warehouseId: Number(values.get('warehouseId')),
    location: values.get('location').trim(),
    receivedAt: receivedAt.toISOString()
  };
  submitForm(form, '/api/receipts', result => `已完成入庫，批次 #${result.batchId}，共 ${body.quantity} 箱。`, () => api('/api/receipts', { method: 'POST', body: JSON.stringify(body) })).then(result => {
    if (result) {
      form.elements.itemName.value = '';
      form.elements.location.value = '';
      form.elements.quantity.value = '2';
      setToday();
    }
  });
});

document.querySelector('#shipment-item').addEventListener('change', updateFifoSuggestion);
document.querySelector('#shipment-warehouse').addEventListener('change', updateFifoSuggestion);
document.querySelector('#shipment-form').addEventListener('submit', event => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = new FormData(form);
  const body = {
    itemId: Number(values.get('itemId')),
    quantity: Number(values.get('quantity')),
    warehouseId: values.get('warehouseId') === 'all' ? null : Number(values.get('warehouseId'))
  };
  submitForm(form, '/api/shipments', result => `已完成 ${result.itemName} ${result.shipped} 箱出貨；依 FIFO 從 ${result.picks.map(pick => `倉${pick.warehouseId} ${pick.location} ${pick.quantity}箱`).join('、')} 扣帳。`, () => api('/api/shipments', { method: 'POST', body: JSON.stringify(body) })).then(result => {
    if (result) {
      form.elements.quantity.value = '1';
      updateFifoSuggestion();
    }
  });
});

document.querySelector('#load-count-button').addEventListener('click', loadCountSheet);
document.querySelector('#count-warehouse').addEventListener('change', () => {
  document.querySelector('#count-form').dataset.loaded = '';
  loadCountSheet();
});
document.querySelector('#count-form').addEventListener('submit', event => {
  event.preventDefault();
  const form = event.currentTarget;
  const lines = [...form.querySelectorAll('tbody tr[data-batch-id]')].map(row => ({
    batchId: Number(row.dataset.batchId),
    countedQuantity: Number(row.querySelector('[name="countedQuantity"]').value),
    damagedQuantity: Number(row.querySelector('[name="damagedQuantity"]').value)
  }));
  const body = { warehouseId: Number(document.querySelector('#count-warehouse').value), lines };
  submitForm(form, '/api/counts', result => {
    const spoiled = result.results.reduce((sum, line) => sum + line.damaged, 0);
    const adjusted = result.results.filter(line => line.adjustment !== 0).length;
    return `盤點完成。登記報廢 ${spoiled} 箱，${adjusted} 個批次有盤點差異。`;
  }, () => api('/api/counts', { method: 'POST', body: JSON.stringify(body) })).then(result => {
    if (result) {
      form.dataset.loaded = '';
      loadCountSheet();
    }
  });
});

setToday();
Promise.all([loadInventory(), loadItems()]).catch(error => announce(error.message, true));