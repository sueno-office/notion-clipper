// ========== 状態 ==========
let currentDb = null;
let formValues = {};
let activePreset = null;
let currentHiddenFields = new Set();
let currentTabUrl = '';
let currentSortedProperties = [];
let currentUiState = { blank: {}, today: {} }; // URL空欄・日付今日チェックの状態

// ========== 初期化 ==========
async function init() {
  const { apiKey, databases, lastDbId } = await chrome.storage.local.get(['apiKey', 'databases', 'lastDbId']);
  const main = document.getElementById('main-content');

  if (!apiKey || !databases || databases.length === 0) {
    main.innerHTML = `
      <div class="notice">
        設定が完了していません。<br>
        <a id="go-settings">設定画面を開く</a>
      </div>`;
    document.getElementById('go-settings').addEventListener('click', openOptions);
    return;
  }

  const enabledDbs = databases.filter(d => d.enabled !== false);

  if (enabledDbs.length === 0) {
    main.innerHTML = `
      <div class="notice">
        使用するDBが選択されていません。<br>
        <a id="go-settings">設定画面で選択してください</a>
      </div>`;
    document.getElementById('go-settings').addEventListener('click', openOptions);
    return;
  }

  // 名前順にソート
  const sortedDbs = [...enabledDbs].sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  renderMain(sortedDbs, lastDbId);
}

// ========== メインUI描画 ==========
function renderMain(databases, lastDbId) {
  const main = document.getElementById('main-content');
  main.innerHTML = `
    <div class="db-selector">
      <label>DB</label>
      <select id="db-select"></select>
    </div>
    <div class="preset-bar" id="preset-bar">
      <span class="preset-label">プリセット</span>
      <span id="preset-chips"></span>
    </div>
    <div class="form-area" id="form-area"></div>
    <div class="footer">
      <button class="btn btn-ghost" id="save-preset-btn">+ プリセット保存</button>
      <div style="display:flex;gap:8px;">
        <button class="btn btn-secondary" id="clear-btn">クリア</button>
        <button class="btn btn-primary" id="submit-btn">Notionに追加</button>
      </div>
    </div>
  `;

  const dbSelect = document.getElementById('db-select');
  databases.forEach(db => {
    const opt = document.createElement('option');
    opt.value = db.id;
    opt.textContent = db.name;
    dbSelect.appendChild(opt);
  });

  if (lastDbId && databases.some(d => d.id === lastDbId)) {
    dbSelect.value = lastDbId;
  }

  dbSelect.addEventListener('change', () => loadDb(databases, dbSelect.value));
  loadDb(databases, dbSelect.value);

  document.getElementById('submit-btn').addEventListener('click', submitToNotion);
  document.getElementById('clear-btn').addEventListener('click', clearForm);
  document.getElementById('save-preset-btn').addEventListener('click', openPresetDialog);
  document.getElementById('open-options').addEventListener('click', openOptions);
}

// ========== DBロード ==========
async function loadDb(databases, dbId) {
  currentDb = databases.find(d => d.id === dbId);
  if (!currentDb) return;

  await chrome.storage.local.set({ lastDbId: dbId });

  formValues = {};
  activePreset = null;
  currentUiState = { blank: {}, today: {} };

  const { hiddenFields = {}, propertyOrder = {} } = await chrome.storage.local.get(['hiddenFields', 'propertyOrder']);

  // デフォルトは全フィールド折りたたみ（初回のみ）
  if (hiddenFields[dbId] === undefined) {
    currentHiddenFields = new Set(currentDb.properties.map(p => p.name));
  } else {
    currentHiddenFields = new Set(hiddenFields[dbId]);
  }

  // プロパティ順序を適用
  const order = propertyOrder[dbId];
  if (order && order.length > 0) {
    const sorted = order
      .map(name => currentDb.properties.find(p => p.name === name))
      .filter(Boolean);
    const remaining = currentDb.properties.filter(p => !order.includes(p.name));
    currentSortedProperties = [...sorted, ...remaining];
  } else {
    currentSortedProperties = [...currentDb.properties];
  }

  // 現在のタブURLを取得
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    currentTabUrl = tab?.url || '';
  } catch {
    currentTabUrl = '';
  }

  renderPresets();
  renderForm(currentSortedProperties);
}

// ========== フォーム描画 ==========
// meta: { blank: {propName: bool}, today: {propName: bool} }
function renderForm(properties, presetValues = {}, meta = {}) {
  const area = document.getElementById('form-area');
  area.innerHTML = '';
  formValues = {};
  currentSortedProperties = properties;

  properties.forEach(prop => {
    const val = presetValues[prop.name] ?? getDefaultValue(prop);
    formValues[prop.name] = val;
    area.appendChild(buildField(prop, val, {
      blank: meta.blank?.[prop.name] ?? false,
      today: meta.today?.[prop.name] ?? false
    }));
  });

  setupDragAndDrop(area);
}

function getDefaultValue(prop) {
  if (prop.type === 'checkbox') return false;
  if (prop.type === 'multi_select') return [];
  if (prop.type === 'url') return currentTabUrl;
  return '';
}

// ========== フィールドUI構築 ==========
function buildField(prop, currentVal, fieldMeta = {}) {
  const isHidden = currentHiddenFields.has(prop.name);

  const div = document.createElement('div');
  div.className = 'field' + (isHidden ? ' field-hidden' : '');
  div.dataset.propName = prop.name;

  // ---- ヘッダー ----
  const header = document.createElement('div');
  header.className = 'field-header';

  const dragHandle = document.createElement('div');
  dragHandle.className = 'drag-handle';
  dragHandle.textContent = '≡';
  dragHandle.title = 'ドラッグして並び替え';
  dragHandle.addEventListener('mousedown', () => { div.draggable = true; });
  div.addEventListener('dragend', () => {
    div.draggable = false;
    div.classList.remove('dragging');
  });
  header.appendChild(dragHandle);

  const label = document.createElement('label');
  label.innerHTML = `${escapeHtml(prop.name)} <span class="type-badge">${prop.type}</span>`;
  header.appendChild(label);

  const toggleBtn = document.createElement('button');
  toggleBtn.className = 'field-toggle-btn';
  toggleBtn.title = isHidden ? '展開' : '折りたたむ';
  toggleBtn.textContent = isHidden ? '⊕' : '−';
  toggleBtn.addEventListener('click', () => toggleFieldVisibility(prop.name, div, toggleBtn));
  header.appendChild(toggleBtn);

  div.appendChild(header);

  // ---- ボディ ----
  const body = document.createElement('div');
  body.className = 'field-body';

  switch (prop.type) {
    case 'title':
    case 'rich_text':
    case 'email':
    case 'phone_number': {
      const input = document.createElement(prop.type === 'rich_text' ? 'textarea' : 'input');
      if (input.tagName === 'INPUT') {
        input.type = prop.type === 'email' ? 'email' : prop.type === 'phone_number' ? 'tel' : 'text';
      }
      input.value = currentVal || '';
      input.addEventListener('input', () => { formValues[prop.name] = input.value; });
      body.appendChild(input);
      break;
    }
    case 'url': {
      const row = document.createElement('div');
      row.className = 'url-input-row';

      const input = document.createElement('input');
      input.type = 'url';
      input.value = currentVal || '';
      input.addEventListener('input', () => { formValues[prop.name] = input.value; });

      const blankCheck = document.createElement('input');
      blankCheck.type = 'checkbox';
      blankCheck.id = `blank-${CSS.escape(prop.name)}`;
      const blankLabel = document.createElement('label');
      blankLabel.htmlFor = `blank-${CSS.escape(prop.name)}`;
      blankLabel.className = 'url-blank-label';
      blankLabel.textContent = '空欄';

      blankCheck.addEventListener('change', () => {
        currentUiState.blank[prop.name] = blankCheck.checked;
        if (blankCheck.checked) {
          input.disabled = true;
          input.value = '';
          formValues[prop.name] = '';
        } else {
          input.disabled = false;
          input.value = currentTabUrl;
          formValues[prop.name] = currentTabUrl;
        }
      });

      // メタからの初期化
      if (fieldMeta.blank) {
        blankCheck.checked = true;
        input.disabled = true;
        input.value = '';
        formValues[prop.name] = '';
        currentUiState.blank[prop.name] = true;
      }

      row.appendChild(input);
      row.appendChild(blankCheck);
      row.appendChild(blankLabel);
      body.appendChild(row);
      break;
    }
    case 'number': {
      const input = document.createElement('input');
      input.type = 'number';
      input.value = currentVal ?? '';
      input.addEventListener('input', () => { formValues[prop.name] = input.value === '' ? '' : Number(input.value); });
      body.appendChild(input);
      break;
    }
    case 'date': {
      const dateRow = document.createElement('div');
      dateRow.className = 'date-row';

      const input = document.createElement('input');
      input.type = 'date';
      input.value = currentVal || '';
      input.addEventListener('change', () => {
        formValues[prop.name] = input.value;
      });

      const todayCheck = document.createElement('input');
      todayCheck.type = 'checkbox';
      todayCheck.id = `today-${CSS.escape(prop.name)}`;
      const todayLabel = document.createElement('label');
      todayLabel.htmlFor = `today-${CSS.escape(prop.name)}`;
      todayLabel.className = 'date-today-label';
      todayLabel.textContent = '今日';

      const applyToday = () => {
        const today = new Date().toISOString().slice(0, 10);
        input.value = today;
        formValues[prop.name] = today;
        input.disabled = true;
        currentUiState.today[prop.name] = true;
      };
      const unapplyToday = () => {
        input.disabled = false;
        currentUiState.today[prop.name] = false;
      };

      todayCheck.addEventListener('change', () => {
        if (todayCheck.checked) applyToday();
        else unapplyToday();
      });

      // メタからの初期化
      if (fieldMeta.today) {
        todayCheck.checked = true;
        applyToday();
      }

      dateRow.appendChild(input);
      dateRow.appendChild(todayCheck);
      dateRow.appendChild(todayLabel);
      body.appendChild(dateRow);
      break;
    }
    case 'checkbox': {
      const row = document.createElement('div');
      row.className = 'checkbox-field';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = !!currentVal;
      const span = document.createElement('span');
      span.textContent = prop.name;
      input.addEventListener('change', () => { formValues[prop.name] = input.checked; });
      row.appendChild(input);
      row.appendChild(span);
      body.appendChild(row);
      break;
    }
    case 'select': {
      const optContainer = document.createElement('div');
      optContainer.className = 'select-options';
      prop.options.forEach(opt => {
        const chip = document.createElement('button');
        chip.className = `opt-chip color-${opt.color}`;
        chip.textContent = opt.name;
        if (currentVal === opt.name) chip.classList.add('selected');
        chip.addEventListener('click', () => {
          if (formValues[prop.name] === opt.name) {
            formValues[prop.name] = '';
            optContainer.querySelectorAll('.opt-chip').forEach(c => c.classList.remove('selected'));
          } else {
            formValues[prop.name] = opt.name;
            optContainer.querySelectorAll('.opt-chip').forEach(c => c.classList.remove('selected'));
            chip.classList.add('selected');
          }
        });
        optContainer.appendChild(chip);
      });
      body.appendChild(optContainer);
      break;
    }
    case 'multi_select': {
      const selected = Array.isArray(currentVal) ? currentVal : [];
      formValues[prop.name] = [...selected];
      const optContainer = document.createElement('div');
      optContainer.className = 'select-options';
      prop.options.forEach(opt => {
        const chip = document.createElement('button');
        chip.className = `opt-chip color-${opt.color}`;
        chip.textContent = opt.name;
        if (selected.includes(opt.name)) chip.classList.add('selected');
        chip.addEventListener('click', () => {
          const arr = formValues[prop.name];
          const idx = arr.indexOf(opt.name);
          if (idx >= 0) { arr.splice(idx, 1); chip.classList.remove('selected'); }
          else { arr.push(opt.name); chip.classList.add('selected'); }
        });
        optContainer.appendChild(chip);
      });
      body.appendChild(optContainer);
      break;
    }
  }

  div.appendChild(body);
  return div;
}

// ========== ドラッグ&ドロップ ==========
function setupDragAndDrop(area) {
  let dragSrcEl = null;

  area.addEventListener('dragstart', (e) => {
    dragSrcEl = e.target.closest('.field');
    if (!dragSrcEl) return;
    dragSrcEl.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', '');
  });

  area.addEventListener('dragend', () => {
    if (dragSrcEl) dragSrcEl.classList.remove('dragging');
    area.querySelectorAll('.field').forEach(f => f.classList.remove('drag-over'));
    dragSrcEl = null;
  });

  area.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const target = e.target.closest('.field');
    if (!target || target === dragSrcEl) return;
    area.querySelectorAll('.field').forEach(f => f.classList.remove('drag-over'));
    target.classList.add('drag-over');
  });

  area.addEventListener('dragleave', (e) => {
    if (!area.contains(e.relatedTarget)) {
      area.querySelectorAll('.field').forEach(f => f.classList.remove('drag-over'));
    }
  });

  area.addEventListener('drop', async (e) => {
    e.preventDefault();
    const target = e.target.closest('.field');
    if (!target || !dragSrcEl || target === dragSrcEl) return;

    const fields = [...area.querySelectorAll('.field')];
    const srcIdx = fields.indexOf(dragSrcEl);
    const dstIdx = fields.indexOf(target);
    if (srcIdx < 0 || dstIdx < 0) return;

    const newProps = [...currentSortedProperties];
    const [moved] = newProps.splice(srcIdx, 1);
    newProps.splice(dstIdx, 0, moved);

    const { propertyOrder = {} } = await chrome.storage.local.get('propertyOrder');
    propertyOrder[currentDb.id] = newProps.map(p => p.name);
    await chrome.storage.local.set({ propertyOrder });

    renderForm(newProps, { ...formValues }, {
      blank: { ...currentUiState.blank },
      today: { ...currentUiState.today }
    });
  });
}

// ========== フィールド表示切り替え ==========
async function toggleFieldVisibility(propName, fieldDiv, toggleBtn) {
  if (currentHiddenFields.has(propName)) {
    currentHiddenFields.delete(propName);
    fieldDiv.classList.remove('field-hidden');
    toggleBtn.textContent = '−';
    toggleBtn.title = '折りたたむ';
  } else {
    currentHiddenFields.add(propName);
    fieldDiv.classList.add('field-hidden');
    toggleBtn.textContent = '⊕';
    toggleBtn.title = '展開';
  }

  const { hiddenFields = {} } = await chrome.storage.local.get('hiddenFields');
  hiddenFields[currentDb.id] = [...currentHiddenFields];
  await chrome.storage.local.set({ hiddenFields });
}

// ========== プリセット ==========
async function renderPresets() {
  const { presets = {} } = await chrome.storage.local.get('presets');
  const dbPresets = presets[currentDb.id] || {};
  const chips = document.getElementById('preset-chips');
  chips.innerHTML = '';

  Object.keys(dbPresets).forEach(name => {
    const chip = document.createElement('button');
    chip.className = 'preset-chip' + (activePreset === name ? ' active' : '');
    chip.innerHTML = `${escapeHtml(name)} <span class="del-chip" data-name="${escapeHtml(name)}">×</span>`;

    chip.addEventListener('click', (e) => {
      if (e.target.dataset.name) return;
      activePreset = name;
      applyPreset(dbPresets[name]);
      renderPresets();
    });

    chip.querySelector('.del-chip').addEventListener('click', async (e) => {
      e.stopPropagation();
      const { presets: p = {} } = await chrome.storage.local.get('presets');
      delete (p[currentDb.id] || {})[name];
      await chrome.storage.local.set({ presets: p });
      if (activePreset === name) activePreset = null;
      renderPresets();
    });

    chips.appendChild(chip);
  });
}

// プリセット適用
async function applyPreset(presetData) {
  const values = {};
  const blank = {};
  const today = {};
  let hidden = null;
  let order = null;

  Object.entries(presetData).forEach(([k, v]) => {
    if (k === '__hidden') { hidden = v; return; }
    if (k === '__order') { order = v; return; }
    if (k.startsWith('__blank_')) { blank[k.slice(8)] = v; return; }
    if (k.startsWith('__today_')) { today[k.slice(8)] = v; return; }
    values[k] = v;
  });

  // 折りたたみ状態を適用
  if (hidden !== null) {
    currentHiddenFields = new Set(hidden);
    const { hiddenFields = {} } = await chrome.storage.local.get('hiddenFields');
    hiddenFields[currentDb.id] = hidden;
    await chrome.storage.local.set({ hiddenFields });
  }

  // プロパティ順序を適用
  if (order !== null) {
    const reordered = order
      .map(name => currentDb.properties.find(p => p.name === name))
      .filter(Boolean)
      .concat(currentDb.properties.filter(p => !order.includes(p.name)));
    currentSortedProperties = reordered;
    const { propertyOrder = {} } = await chrome.storage.local.get('propertyOrder');
    propertyOrder[currentDb.id] = order;
    await chrome.storage.local.set({ propertyOrder });
  }

  currentUiState = { blank: {}, today: {} };
  renderForm(currentSortedProperties, values, { blank, today });
}

function openPresetDialog() {
  const dialog = document.getElementById('preset-dialog');
  dialog.classList.remove('hidden');
  document.getElementById('preset-name-input').value = activePreset || '';
  document.getElementById('preset-name-input').focus();
}

document.getElementById('cancel-preset').addEventListener('click', () => {
  document.getElementById('preset-dialog').classList.add('hidden');
});

document.getElementById('confirm-preset').addEventListener('click', async () => {
  const name = document.getElementById('preset-name-input').value.trim();
  if (!name) return;

  // 現在の全状態をプリセットに保存
  const presetData = {
    ...formValues,
    __hidden: [...currentHiddenFields],
    __order: currentSortedProperties.map(p => p.name),
  };
  Object.entries(currentUiState.blank).forEach(([k, v]) => { presetData[`__blank_${k}`] = v; });
  Object.entries(currentUiState.today).forEach(([k, v]) => { presetData[`__today_${k}`] = v; });

  const { presets = {} } = await chrome.storage.local.get('presets');
  if (!presets[currentDb.id]) presets[currentDb.id] = {};
  presets[currentDb.id][name] = presetData;
  await chrome.storage.local.set({ presets });

  activePreset = name;
  document.getElementById('preset-dialog').classList.add('hidden');
  renderPresets();
  showStatus(`プリセット「${name}」を保存しました`, 'success');
});

// ========== フォームクリア ==========
function clearForm() {
  activePreset = null;
  currentUiState = { blank: {}, today: {} };
  renderForm(currentSortedProperties);
  renderPresets();
}

// ========== Notionに送信 ==========
async function submitToNotion() {
  const btn = document.getElementById('submit-btn');
  btn.disabled = true;
  showStatus('送信中...', 'loading');

  const { apiKey } = await chrome.storage.local.get('apiKey');
  const properties = buildNotionProperties(currentDb.properties, formValues);

  try {
    const response = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        parent: { database_id: currentDb.id },
        properties
      })
    });

    if (!response.ok) {
      const err = await response.json();
      showStatus(`エラー: ${err.message || response.status}`, 'error');
    } else {
      showStatus('Notionに追加しました！', 'success');
    }
  } catch (e) {
    showStatus(`通信エラー: ${e.message}`, 'error');
  } finally {
    btn.disabled = false;
  }
}

// ========== Notionプロパティ形式に変換 ==========
function buildNotionProperties(propDefs, values) {
  const result = {};
  propDefs.forEach(prop => {
    const val = values[prop.name];
    if (val === '' || val === null || val === undefined) return;
    if (Array.isArray(val) && val.length === 0) return;

    switch (prop.type) {
      case 'title':
        result[prop.name] = { title: [{ text: { content: String(val) } }] }; break;
      case 'rich_text':
        result[prop.name] = { rich_text: [{ text: { content: String(val) } }] }; break;
      case 'number':
        if (val !== '') result[prop.name] = { number: Number(val) }; break;
      case 'select':
        result[prop.name] = { select: { name: val } }; break;
      case 'multi_select':
        result[prop.name] = { multi_select: val.map(name => ({ name })) }; break;
      case 'date':
        result[prop.name] = { date: { start: val } }; break;
      case 'checkbox':
        result[prop.name] = { checkbox: !!val }; break;
      case 'url':
        result[prop.name] = { url: val }; break;
      case 'email':
        result[prop.name] = { email: val }; break;
      case 'phone_number':
        result[prop.name] = { phone_number: val }; break;
    }
  });
  return result;
}

// ========== ユーティリティ ==========
function showStatus(message, type) {
  const bar = document.getElementById('status-bar');
  bar.textContent = message;
  bar.className = `status-bar ${type}`;
  if (type === 'success') setTimeout(() => { bar.className = 'status-bar'; }, 3000);
}

function openOptions() { chrome.runtime.openOptionsPage(); }

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ========== 起動 ==========
document.getElementById('open-options').addEventListener('click', openOptions);
init();
