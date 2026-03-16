// ---- 状態表示ヘルパー ----
function showStatus(el, message, type) {
  el.textContent = message;
  el.className = `status ${type}`;
}

// ---- APIキー保存 ----
document.getElementById('save-key-btn').addEventListener('click', async () => {
  const key = document.getElementById('api-key').value.trim();
  const status = document.getElementById('key-status');
  if (!key) {
    showStatus(status, 'APIキーを入力してください', 'error');
    return;
  }
  await chrome.storage.local.set({ apiKey: key });
  showStatus(status, '保存しました', 'success');
});

// ---- DBリスト描画 ----
function renderDatabases(databases) {
  const list = document.getElementById('db-list');
  if (!databases || databases.length === 0) {
    list.innerHTML = '<div class="empty-state">Databaseがまだ追加されていません</div>';
    return;
  }
  // 名前順で表示（storage内の順序は変えない）
  const sorted = [...databases].sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  list.innerHTML = sorted.map(db => `
    <div class="db-item">
      <label class="db-enable">
        <input type="checkbox" class="db-enable-check" data-id="${db.id}" ${db.enabled !== false ? 'checked' : ''}>
        <span class="db-enable-label">使用する</span>
      </label>
      <div class="db-info">
        <div class="db-name">${escapeHtml(db.name)}</div>
        <div class="db-id">${db.id}</div>
      </div>
      <div class="db-actions">
        <button class="btn btn-danger" data-id="${db.id}" data-action="delete">削除</button>
      </div>
    </div>
  `).join('');

  list.querySelectorAll('.db-enable-check').forEach(check => {
    check.addEventListener('change', async () => {
      const { databases: dbs = [] } = await chrome.storage.local.get('databases');
      const db = dbs.find(d => d.id === check.dataset.id);
      if (db) db.enabled = check.checked;
      await chrome.storage.local.set({ databases: dbs });
    });
  });

  list.querySelectorAll('[data-action="delete"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const { databases: dbs = [] } = await chrome.storage.local.get('databases');
      const idx = dbs.findIndex(d => d.id === btn.dataset.id);
      if (idx >= 0) dbs.splice(idx, 1);
      await chrome.storage.local.set({ databases: dbs });
      renderDatabases(dbs);
    });
  });
}

// ---- 全DB取得 ----
let allFetchedDbs = []; // 取得済みDBキャッシュ

document.getElementById('fetch-dbs-btn').addEventListener('click', async () => {
  const status = document.getElementById('fetch-status');
  const { apiKey } = await chrome.storage.local.get('apiKey');
  if (!apiKey) {
    showStatus(status, '先にAPIキーを保存してください', 'error');
    return;
  }

  const btn = document.getElementById('fetch-dbs-btn');
  btn.disabled = true;
  showStatus(status, '取得中...', 'info');

  try {
    const dbs = await fetchAllDatabases(apiKey);
    allFetchedDbs = dbs;
    showStatus(status, `${dbs.length} 件のDatabaseが見つかりました`, 'success');
    document.getElementById('api-db-panel').classList.add('visible');
    document.getElementById('api-db-search').value = '';
    renderApiDbList(dbs, '');
  } catch (e) {
    showStatus(status, `取得エラー: ${e.message}`, 'error');
  } finally {
    btn.disabled = false;
  }
});

async function fetchAllDatabases(apiKey) {
  const results = [];
  let cursor = undefined;

  do {
    const body = {
      filter: { value: 'database', property: 'object' },
      page_size: 100
    };
    if (cursor) body.start_cursor = cursor;

    const res = await fetch('https://api.notion.com/v1/search', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.message || res.status);
    }

    const data = await res.json();
    data.results.forEach(db => {
      results.push({
        id: db.id,
        name: extractPlainText(db.title) || '(タイトルなし)'
      });
    });

    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);

  return results.sort((a, b) => a.name.localeCompare(b.name, 'ja'));
}

// ---- 取得DBリスト描画 ----
function renderApiDbList(dbs, query) {
  const list = document.getElementById('api-db-list');
  const filtered = query
    ? dbs.filter(db => db.name.toLowerCase().includes(query.toLowerCase()))
    : dbs;

  if (filtered.length === 0) {
    list.innerHTML = '<div class="empty-state">該当するDBがありません</div>';
    return;
  }

  list.innerHTML = filtered.map(db => `
    <div class="api-db-item">
      <input type="checkbox" class="api-db-check" id="api-${db.id}" value="${db.id}" data-name="${escapeHtml(db.name)}">
      <label for="api-${db.id}">
        ${escapeHtml(db.name)}
        <span class="api-db-id">${db.id}</span>
      </label>
    </div>
  `).join('');
}

// 検索絞り込み
document.getElementById('api-db-search').addEventListener('input', (e) => {
  renderApiDbList(allFetchedDbs, e.target.value);
});

// すべて選択 / 解除
document.getElementById('select-all-btn').addEventListener('click', () => {
  const checks = document.querySelectorAll('.api-db-check');
  const allChecked = [...checks].every(c => c.checked);
  checks.forEach(c => { c.checked = !allChecked; });
});

// 選択したDBを追加
document.getElementById('add-selected-btn').addEventListener('click', async () => {
  const status = document.getElementById('fetch-status');
  const { apiKey } = await chrome.storage.local.get('apiKey');
  const checks = [...document.querySelectorAll('.api-db-check:checked')];

  if (checks.length === 0) {
    showStatus(status, 'DBを選択してください', 'error');
    return;
  }

  const btn = document.getElementById('add-selected-btn');
  btn.disabled = true;
  showStatus(status, '追加中...', 'info');

  try {
    const { databases: dbs = [] } = await chrome.storage.local.get('databases');
    let added = 0;
    let skipped = 0;

    for (const check of checks) {
      const rawId = check.value.replace(/-/g, '');
      const formattedId = `${rawId.slice(0,8)}-${rawId.slice(8,12)}-${rawId.slice(12,16)}-${rawId.slice(16,20)}-${rawId.slice(20)}`;

      if (dbs.some(d => d.id === formattedId)) {
        skipped++;
        continue;
      }

      // プロパティを取得
      const res = await fetch(`https://api.notion.com/v1/databases/${formattedId}`, {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Notion-Version': '2022-06-28'
        }
      });

      if (!res.ok) continue;
      const data = await res.json();
      const properties = parseProperties(data.properties);
      dbs.push({ id: formattedId, name: check.dataset.name, properties, enabled: true });
      added++;
    }

    await chrome.storage.local.set({ databases: dbs });
    renderDatabases(dbs);

    let msg = `${added} 件追加しました`;
    if (skipped > 0) msg += `（${skipped} 件は重複のためスキップ）`;
    showStatus(status, msg, 'success');
  } catch (e) {
    showStatus(status, `エラー: ${e.message}`, 'error');
  } finally {
    btn.disabled = false;
  }
});

// ---- 手動 DB読み込み・追加 ----
document.getElementById('load-db-btn').addEventListener('click', async () => {
  const rawId = document.getElementById('db-id-input').value.trim();
  const status = document.getElementById('db-status');

  if (!rawId) {
    showStatus(status, 'Database IDを入力してください', 'error');
    return;
  }

  const dbId = rawId.replace(/-/g, '');
  if (dbId.length !== 32) {
    showStatus(status, 'Database IDは32文字（ハイフンなし）で入力してください', 'error');
    return;
  }
  const formattedId = `${dbId.slice(0,8)}-${dbId.slice(8,12)}-${dbId.slice(12,16)}-${dbId.slice(16,20)}-${dbId.slice(20)}`;

  const { apiKey } = await chrome.storage.local.get('apiKey');
  if (!apiKey) {
    showStatus(status, '先にAPIキーを保存してください', 'error');
    return;
  }

  showStatus(status, '読み込み中...', 'info');

  try {
    const response = await fetch(`https://api.notion.com/v1/databases/${formattedId}`, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Notion-Version': '2022-06-28'
      }
    });

    if (!response.ok) {
      const err = await response.json();
      showStatus(status, `エラー: ${err.message || response.status}`, 'error');
      return;
    }

    const data = await response.json();
    const dbName = extractPlainText(data.title) || '(タイトルなし)';

    const { databases: dbs = [] } = await chrome.storage.local.get('databases');

    if (dbs.some(d => d.id === formattedId)) {
      showStatus(status, 'このDatabaseはすでに追加されています', 'error');
      return;
    }

    const properties = parseProperties(data.properties);
    dbs.push({ id: formattedId, name: dbName, properties, enabled: true });
    await chrome.storage.local.set({ databases: dbs });

    document.getElementById('db-id-input').value = '';
    showStatus(status, `「${dbName}」を追加しました（プロパティ ${properties.length} 件）`, 'success');
    renderDatabases(dbs);

  } catch (e) {
    showStatus(status, `通信エラー: ${e.message}`, 'error');
  }
});

// ---- Notionプロパティを解析 ----
function parseProperties(props) {
  const supported = ['title', 'rich_text', 'number', 'select', 'multi_select', 'date', 'checkbox', 'url', 'email', 'phone_number'];
  return Object.entries(props)
    .filter(([, v]) => supported.includes(v.type))
    .map(([name, v]) => {
      const prop = { name, type: v.type };
      if (v.type === 'select') {
        prop.options = v.select.options.map(o => ({ id: o.id, name: o.name, color: o.color }));
      }
      if (v.type === 'multi_select') {
        prop.options = v.multi_select.options.map(o => ({ id: o.id, name: o.name, color: o.color }));
      }
      return prop;
    });
}

// ---- ユーティリティ ----
function extractPlainText(richTexts) {
  if (!Array.isArray(richTexts)) return '';
  return richTexts.map(t => t.plain_text || '').join('');
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---- 初期ロード ----
async function init() {
  const { apiKey, databases } = await chrome.storage.local.get(['apiKey', 'databases']);
  if (apiKey) {
    document.getElementById('api-key').value = apiKey;
  }
  renderDatabases(databases || []);
}

init();
