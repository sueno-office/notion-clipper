// ========== 状態 ==========
let currentDb = null;
let formValues = {};
let activePreset = null;
let currentHiddenFields = new Set();
let currentTabUrl = '';
let currentSortedProperties = [];
let currentUiState = { blank: {}, today: {}, clipAutoTitle: true, clipAutoBody: false, clipEmptyBody: false, clipAiBody: false };
let clipMode = false;
let clipData = { title: '', imageUrl: '', bodyText: '', includeImage: true };
let allDatabases = [];
let savedPopupSize = { width: 520, height: 520 };
let savedRightColWidth = 175;
const BODY_PSEUDO = { name: '__body', type: '__body' };
const IMAGE_PSEUDO = { name: '__image', type: '__image' };
const DEFAULT_AI_PROMPT = '以下のページを要約してください。\n\nタイトル: {{title}}\nURL: {{url}}\n\n{{body}}';

// ========== 初期化 ==========
async function init() {
  const { apiKey, databases, lastDbId, lastPreset: lp, presets: rawPresets = {}, popupSize, rightColWidth } =
    await chrome.storage.local.get(['apiKey', 'databases', 'lastDbId', 'lastPreset', 'presets', 'popupSize', 'rightColWidth']);
  if (popupSize) {
    savedPopupSize = popupSize;
    document.body.style.width = savedPopupSize.width + 'px';
    document.body.style.height = savedPopupSize.height + 'px';
  }
  if (rightColWidth) savedRightColWidth = rightColWidth;
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

  // 旧形式（presets[dbId][name]）から新形式（presets[name]）へマイグレーション
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  if (Object.keys(rawPresets).some(k => uuidPattern.test(k))) {
    const migrated = {};
    for (const [dbId, dbPresets] of Object.entries(rawPresets)) {
      if (uuidPattern.test(dbId) && typeof dbPresets === 'object') {
        for (const [pName, pData] of Object.entries(dbPresets)) {
          if (typeof pData === 'object') migrated[pName] = { ...pData, __dbId: dbId };
        }
      }
    }
    await chrome.storage.local.set({ presets: migrated, lastPreset: null });
  }

  // lastPresetからinitialDbIdを決定
  const presets = Object.keys(rawPresets).some(k => uuidPattern.test(k))
    ? await chrome.storage.local.get('presets').then(r => r.presets || {})
    : rawPresets;
  let initialDbId = lastDbId;
  let initialPreset = null;
  if (lp && presets[lp]) {
    const dbId = presets[lp].__dbId;
    if (dbId && enabledDbs.some(d => d.id === dbId)) {
      initialDbId = dbId;
      initialPreset = lp;
    }
  }

  const sortedDbs = [...enabledDbs].sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  renderMain(sortedDbs, initialDbId, initialPreset);
}

// ========== メインUI描画 ==========
function renderMain(databases, lastDbId, initialPreset = null) {
  allDatabases = databases;
  const main = document.getElementById('main-content');
  main.innerHTML = `
    <div class="main-layout">
      <div class="left-col">
        <div class="form-area" id="form-area"></div>
      </div>
      <div class="col-divider" id="col-divider"></div>
      <div class="right-col" id="right-col">
        <div class="right-section">
          <div class="right-section-label">DB</div>
          <select id="db-select"></select>
        </div>
        <div class="right-section">
          <div class="right-section-header">
            <span class="right-section-label" style="margin-bottom:0">プリセット</span>
            <button class="btn-ghost-xs" id="save-preset-btn" title="プリセット保存">＋</button>
          </div>
          <div id="preset-chips"></div>
        </div>
        <div class="right-section">
          <div class="right-section-label">最近の保存</div>
          <div id="history-list"></div>
        </div>
      </div>
    </div>
  `;

  setupColDivider();

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

  dbSelect.addEventListener('change', () => { activePreset = null; loadDb(databases, dbSelect.value); });
  loadDb(databases, dbSelect.value, initialPreset);

  document.getElementById('save-preset-btn').addEventListener('click', openPresetDialog);

  renderHistory();
}

// ========== DBロード ==========
async function loadDb(databases, dbId, presetName = null) {
  currentDb = databases.find(d => d.id === dbId);
  if (!currentDb) return;

  await chrome.storage.local.set({ lastDbId: dbId });

  formValues = {};
  activePreset = null;
  currentUiState = { blank: {}, today: {} };

  const { hiddenFields = {}, propertyOrder = {}, presets = {} } = await chrome.storage.local.get(['hiddenFields', 'propertyOrder', 'presets']);

  // デフォルトは全フィールド折りたたみ（初回のみ）
  if (hiddenFields[dbId] === undefined) {
    currentHiddenFields = new Set(currentDb.properties.map(p => p.name));
  } else {
    currentHiddenFields = new Set(hiddenFields[dbId]);
  }

  // プロパティ順序を適用（__bodyを含む）
  const allProps = [...currentDb.properties, BODY_PSEUDO, IMAGE_PSEUDO];
  const order = propertyOrder[dbId];
  if (order && order.length > 0) {
    const sorted = order.map(name => allProps.find(p => p.name === name)).filter(Boolean);
    const remaining = allProps.filter(p => !order.includes(p.name));
    currentSortedProperties = [...sorted, ...remaining];
  } else {
    currentSortedProperties = allProps;
  }

  // 現在のタブURLを取得
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    currentTabUrl = tab?.url || '';
  } catch {
    currentTabUrl = '';
  }

  if (presetName && presets[presetName]) {
    activePreset = presetName;
    await applyPreset(presets[presetName]);
    renderPresets();
  } else {
    renderPresets();
    renderForm(currentSortedProperties);
  }
  renderHistory();
}


// ========== フォーム描画 ==========
// meta: { blank: {propName: bool}, today: {propName: bool} }
function renderForm(properties, presetValues = {}, meta = {}) {
  const area = document.getElementById('form-area');
  area.innerHTML = '';
  formValues = {};

  // タイトルを先頭に固定
  const titleProp = properties.find(p => p.type === 'title');
  const otherProps = properties.filter(p => p.type !== 'title');
  const sorted = titleProp ? [titleProp, ...otherProps] : [...otherProps];
  currentSortedProperties = sorted;

  sorted.forEach(prop => {
    // ヘッダ画像はクリップモードかつ画像がある場合のみ表示
    if (prop.type === '__image' && (!clipMode || !clipData.imageUrl)) return;
    let val = presetValues[prop.name] ?? getDefaultValue(prop);
    if (clipMode && prop.type === 'title' && currentUiState.clipAutoTitle) val = clipData.title;
    if (clipMode && prop.name === '__body') {
      if (currentUiState.clipAutoBody) val = clipData.bodyText;
      else if (currentUiState.clipEmptyBody) val = '';
    }
    if (prop.type !== '__image') formValues[prop.name] = val;
    const fieldMeta = {
      blank: meta.blank?.[prop.name] ?? false,
      today: meta.today?.[prop.name] ?? false,
    };
    area.appendChild(buildField(prop, val, fieldMeta));
  });

  setupDragAndDrop(area);

  // titleフィールド変更時に履歴の「保存済み」バッジを更新
  const titlePropDef = properties.find(p => p.type === 'title');
  if (titlePropDef) {
    const titleInput = area.querySelector(`[data-prop-name="${CSS.escape(titlePropDef.name)}"] input, [data-prop-name="${CSS.escape(titlePropDef.name)}"] textarea`);
    if (titleInput) titleInput.addEventListener('input', () => renderHistory());
  }
}

function getDefaultValue(prop) {
  if (prop.type === '__image') return undefined;
  if (prop.type === '__body') return clipData.bodyText;
  if (prop.type === 'checkbox') return false;
  if (prop.type === 'multi_select') return [];
  if (prop.type === 'url') return currentTabUrl;
  return '';
}

// ========== フィールドUI構築 ==========
function buildField(prop, currentVal, fieldMeta = {}) {
  const isHidden = prop.type !== 'title' && currentHiddenFields.has(prop.name);

  const div = document.createElement('div');
  div.className = 'field' + (isHidden ? ' field-hidden' : '');
  div.dataset.propName = prop.name;

  // ---- ヘッダー ----
  const header = document.createElement('div');
  header.className = 'field-header';

  const dragHandle = document.createElement('div');
  dragHandle.className = 'drag-handle';
  dragHandle.textContent = '≡';
  if (prop.type === 'title') {
    dragHandle.style.opacity = '0.2';
    dragHandle.style.cursor = 'default';
  } else {
    dragHandle.title = 'ドラッグして並び替え';
    dragHandle.addEventListener('mousedown', () => { div.draggable = true; });
    div.addEventListener('dragend', () => {
      div.draggable = false;
      div.classList.remove('dragging');
    });
  }
  header.appendChild(dragHandle);

  const label = document.createElement('label');
  const displayName = prop.type === '__body' ? '本文' : prop.type === '__image' ? 'ヘッダ画像' : escapeHtml(prop.name);
  const badgeText = prop.type === '__body' ? 'body' : prop.type === '__image' ? 'clip' : prop.type;
  label.innerHTML = `${displayName} <span class="type-badge">${badgeText}</span>`;
  header.appendChild(label);

  if (prop.type !== 'title') {
    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'field-toggle-btn';
    toggleBtn.title = isHidden ? '展開' : '折りたたむ';
    toggleBtn.textContent = isHidden ? '⊕' : '−';
    toggleBtn.addEventListener('click', () => toggleFieldVisibility(prop.name, div, toggleBtn));
    header.appendChild(toggleBtn);
  }

  div.appendChild(header);

  // ---- ボディ ----
  const body = document.createElement('div');
  body.className = 'field-body';

  switch (prop.type) {
    case '__image': {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:8px;align-items:center;';
      const thumb = document.createElement('img');
      thumb.className = 'clip-img-thumb';
      thumb.src = clipData.imageUrl;
      thumb.style.opacity = clipData.includeImage ? '1' : '0.3';
      const noImgCheck = document.createElement('input');
      noImgCheck.type = 'checkbox';
      noImgCheck.id = 'clip-no-image';
      noImgCheck.className = 'clip-check';
      noImgCheck.checked = !clipData.includeImage;
      const noImgLabel = document.createElement('label');
      noImgLabel.htmlFor = 'clip-no-image';
      noImgLabel.className = 'clip-label';
      noImgLabel.textContent = '画像なし';
      noImgCheck.addEventListener('change', () => {
        clipData.includeImage = !noImgCheck.checked;
        thumb.style.opacity = clipData.includeImage ? '1' : '0.3';
      });
      row.appendChild(thumb);
      row.appendChild(noImgCheck);
      row.appendChild(noImgLabel);
      body.appendChild(row);
      break;
    }
    case '__body': {
      const textarea = document.createElement('textarea');
      textarea.value = currentVal || '';
      textarea.style.cssText = 'flex:1;min-width:0;min-height:80px;width:auto;';
      textarea.placeholder = 'Notionページの本文として追加されます';
      textarea.addEventListener('input', () => {
        formValues[prop.name] = textarea.value;
        clipData.bodyText = textarea.value;
      });

      if (clipMode) {
        const mkCBRow = (id, labelText, checked) => {
          const row = document.createElement('div');
          row.style.cssText = 'display:flex;align-items:center;gap:3px;';
          const c = document.createElement('input');
          c.type = 'checkbox'; c.className = 'clip-check'; c.id = id; c.checked = checked;
          const l = document.createElement('label');
          l.htmlFor = id; l.className = 'url-blank-label'; l.textContent = labelText;
          row.appendChild(c); row.appendChild(l);
          return { c, l, row };
        };
        const { c: autoCheck, row: autoRow } = mkCBRow('clip-auto-body', '自動作成', currentUiState.clipAutoBody);
        const { c: emptyCheck, row: emptyRow } = mkCBRow('clip-empty-body', '空欄', currentUiState.clipEmptyBody);
        const { c: aiCheck, row: aiRow } = mkCBRow('clip-ai-body', 'AI作成', currentUiState.clipAiBody);

        const genBtn = document.createElement('button');
        genBtn.className = 'btn btn-secondary';
        genBtn.style.cssText = 'padding:2px 8px;font-size:11px;' + (aiCheck.checked ? '' : 'display:none;');
        genBtn.textContent = 'AI生成';
        genBtn.addEventListener('click', async () => {
          const { databases: dbs = [] } = await chrome.storage.local.get('databases');
          const dbEntry = dbs.find(d => d.id === currentDb.id);
          const prompt = dbEntry?.aiPrompt?.trim() || DEFAULT_AI_PROMPT;
          genBtn.disabled = true; genBtn.textContent = '生成中...';
          try {
            const result = await callGemini(fillAiTemplate(prompt));
            textarea.value = result; formValues[prop.name] = result; clipData.bodyText = result;
          } catch (e) { showStatus(`AI生成エラー: ${e.message}`, 'error'); }
          finally { genBtn.disabled = false; genBtn.textContent = 'AI生成'; }
        });

        // 排他制御
        const uncheckAll = (except) => {
          [autoCheck, emptyCheck, aiCheck].forEach(c => { if (c !== except) c.checked = false; });
          currentUiState.clipAutoBody = autoCheck.checked;
          currentUiState.clipEmptyBody = emptyCheck.checked;
          currentUiState.clipAiBody = aiCheck.checked;
          genBtn.style.display = aiCheck.checked ? '' : 'none';
        };
        autoCheck.addEventListener('change', () => {
          uncheckAll(autoCheck);
          if (autoCheck.checked) { textarea.value = clipData.bodyText; formValues[prop.name] = clipData.bodyText; textarea.disabled = true; }
          else { textarea.disabled = false; }
        });
        emptyCheck.addEventListener('change', () => {
          uncheckAll(emptyCheck);
          if (emptyCheck.checked) { textarea.value = ''; formValues[prop.name] = ''; textarea.disabled = true; }
          else { textarea.disabled = false; }
        });
        aiCheck.addEventListener('change', () => { uncheckAll(aiCheck); textarea.disabled = false; });

        // 初期状態
        if (autoCheck.checked) { textarea.value = clipData.bodyText; formValues[prop.name] = clipData.bodyText; textarea.disabled = true; }
        if (emptyCheck.checked) { textarea.value = ''; formValues[prop.name] = ''; textarea.disabled = true; }

        const sidePanel = document.createElement('div');
        sidePanel.style.cssText = 'display:flex;flex-direction:column;gap:4px;flex-shrink:0;padding-top:2px;';
        sidePanel.appendChild(autoRow);
        sidePanel.appendChild(emptyRow);
        sidePanel.appendChild(aiRow);
        sidePanel.appendChild(genBtn);

        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'display:flex;gap:6px;align-items:flex-start;';
        wrapper.appendChild(textarea);
        wrapper.appendChild(sidePanel);
        body.appendChild(wrapper);
      } else {
        textarea.style.cssText = 'min-height:80px;width:100%;';
        body.appendChild(textarea);
      }
      break;
    }
    case 'title': {
      const input = document.createElement('input');
      input.type = 'text';
      input.value = currentVal || '';
      input.addEventListener('input', () => {
        formValues[prop.name] = input.value;
        if (clipMode) clipData.title = input.value;
      });
      if (clipMode) {
        const row = document.createElement('div');
        row.className = 'url-input-row';
        row.appendChild(input);
        const autoCheck = document.createElement('input');
        autoCheck.type = 'checkbox';
        autoCheck.className = 'clip-check';
        autoCheck.id = 'clip-auto-title';
        autoCheck.checked = currentUiState.clipAutoTitle;
        const autoLabel = document.createElement('label');
        autoLabel.htmlFor = 'clip-auto-title';
        autoLabel.className = 'url-blank-label';
        autoLabel.textContent = '自動作成';
        if (autoCheck.checked) { input.value = clipData.title; formValues[prop.name] = clipData.title; input.disabled = true; }
        autoCheck.addEventListener('change', () => {
          currentUiState.clipAutoTitle = autoCheck.checked;
          if (autoCheck.checked) { input.value = clipData.title; formValues[prop.name] = clipData.title; input.disabled = true; }
          else { input.disabled = false; }
        });
        row.appendChild(autoCheck);
        row.appendChild(autoLabel);
        body.appendChild(row);
      } else {
        body.appendChild(input);
      }
      break;
    }
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
      if (clipMode || clipData.bodyText) {
        const aiBtn = document.createElement('button');
        aiBtn.className = 'btn btn-secondary';
        aiBtn.style.cssText = 'padding:2px 8px;font-size:11px;margin-top:4px;';
        aiBtn.textContent = 'AI提案';
        aiBtn.addEventListener('click', async () => {
          aiBtn.disabled = true;
          aiBtn.textContent = '提案中...';
          try {
            const existingNames = prop.options.map(o => o.name).join('、');
            const prompt = `以下のページから「${prop.name}」フィールドに最も適した値を1つ選んでください。まず既存の選択肢から選び、どれも合わない場合のみ新しい値を提案してください。\n既存の選択肢: ${existingNames}\n返答は値のみ（余計な説明・引用符不要）。\n\nタイトル: ${clipData.title || ''}\nURL: ${currentTabUrl || ''}\n\n${clipData.bodyText || ''}`;
            const result = await callGemini(prompt);
            const suggested = result.trim().replace(/^["'「」\s]+|["'「」\s]+$/g, '');
            if (!suggested) throw new Error('提案が取得できませんでした');
            const existingOpt = prop.options.find(o => o.name.toLowerCase() === suggested.toLowerCase());
            const name = existingOpt ? existingOpt.name : suggested;
            formValues[prop.name] = name;
            optContainer.querySelectorAll('.opt-chip').forEach(c => c.classList.remove('selected'));
            let chipFound = false;
            optContainer.querySelectorAll('.opt-chip').forEach(chip => {
              if (chip.textContent === name) { chip.classList.add('selected'); chipFound = true; }
            });
            if (!chipFound) {
              const newChip = document.createElement('button');
              newChip.className = 'opt-chip color-default selected';
              newChip.textContent = name;
              newChip.addEventListener('click', () => {
                if (formValues[prop.name] === name) {
                  formValues[prop.name] = '';
                  optContainer.querySelectorAll('.opt-chip').forEach(c => c.classList.remove('selected'));
                } else {
                  formValues[prop.name] = name;
                  optContainer.querySelectorAll('.opt-chip').forEach(c => c.classList.remove('selected'));
                  newChip.classList.add('selected');
                }
              });
              optContainer.appendChild(newChip);
            }
          } catch (e) {
            showStatus(`AI提案エラー: ${e.message}`, 'error');
          } finally {
            aiBtn.disabled = false;
            aiBtn.textContent = 'AI提案';
          }
        });
        body.appendChild(aiBtn);
      }
      break;
    }
    case 'multi_select': {
      const selected = Array.isArray(currentVal) ? currentVal : [];
      formValues[prop.name] = [...selected];
      const optContainer = document.createElement('div');
      optContainer.className = 'select-options';

      const addChip = (name, color = 'default') => {
        const chip = document.createElement('button');
        chip.className = `opt-chip color-${color}`;
        chip.textContent = name;
        if (formValues[prop.name].includes(name)) chip.classList.add('selected');
        chip.addEventListener('click', () => {
          const arr = formValues[prop.name];
          const idx = arr.indexOf(name);
          if (idx >= 0) { arr.splice(idx, 1); chip.classList.remove('selected'); }
          else { arr.push(name); chip.classList.add('selected'); }
        });
        optContainer.appendChild(chip);
        return chip;
      };
      prop.options.forEach(opt => addChip(opt.name, opt.color));

      // 手動タグ入力
      const tagInputRow = document.createElement('div');
      tagInputRow.style.cssText = 'display:flex;gap:4px;margin-top:4px;';
      const tagInput = document.createElement('input');
      tagInput.type = 'text';
      tagInput.placeholder = 'タグを追加...';
      tagInput.style.cssText = 'flex:1;padding:2px 6px;font-size:12px;border:1px solid #e9e9e7;border-radius:4px;outline:none;';
      const tagAddBtn = document.createElement('button');
      tagAddBtn.className = 'btn btn-secondary';
      tagAddBtn.style.cssText = 'padding:2px 8px;font-size:11px;';
      tagAddBtn.textContent = '追加';
      const doAddTag = () => {
        const strVal = tagInput.value.trim();
        if (!strVal) return;
        const existingOpt = prop.options.find(o => o.name.toLowerCase() === strVal.toLowerCase());
        const name = existingOpt ? existingOpt.name : strVal;
        const arr = formValues[prop.name];
        if (!arr.includes(name)) {
          arr.push(name);
          let chipFound = false;
          optContainer.querySelectorAll('.opt-chip').forEach(chip => {
            if (chip.textContent === name) { chip.classList.add('selected'); chipFound = true; }
          });
          if (!chipFound) addChip(name).classList.add('selected');
        }
        tagInput.value = '';
        tagInput.focus();
      };
      tagAddBtn.addEventListener('click', doAddTag);
      tagInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doAddTag(); } });
      tagInputRow.appendChild(tagInput);
      tagInputRow.appendChild(tagAddBtn);

      body.appendChild(optContainer);
      body.appendChild(tagInputRow);

      if (clipMode || clipData.bodyText) {
        const aiExtractBtn = document.createElement('button');
        aiExtractBtn.className = 'btn btn-secondary';
        aiExtractBtn.style.cssText = 'padding:2px 8px;font-size:11px;margin-top:4px;';
        aiExtractBtn.textContent = 'AI抽出';
        aiExtractBtn.addEventListener('click', async () => {
          aiExtractBtn.disabled = true;
          aiExtractBtn.textContent = '抽出中...';
          try {
            const existingNames = prop.options.map(o => o.name).join('、');
            const prompt = `以下のページから「${prop.name}」フィールドに設定する値をJSON配列のみで返してください。重複なし、余計な説明不要。まず既存の選択肢から選び、該当するものがない場合のみ新しい値を追加してください。\n既存の選択肢: ${existingNames}\n返答例: ["値1", "値2"]\n\nタイトル: ${clipData.title || ''}\nURL: ${currentTabUrl || ''}\n\n${clipData.bodyText || ''}`;
            const result = await callGemini(prompt);
            const match = result.match(/\[[\s\S]*\]/);
            if (!match) throw new Error('結果を解析できませんでした');
            let extracted;
            try { extracted = JSON.parse(match[0]); } catch { throw new Error('結果を解析できませんでした'); }
            if (!Array.isArray(extracted)) throw new Error('配列ではありません');
            extracted.forEach(val => {
              const strVal = String(val).trim();
              if (!strVal) return;
              const existingOpt = prop.options.find(o => o.name.toLowerCase() === strVal.toLowerCase());
              const name = existingOpt ? existingOpt.name : strVal;
              const arr = formValues[prop.name];
              if (arr.includes(name)) return;
              arr.push(name);
              let chipFound = false;
              optContainer.querySelectorAll('.opt-chip').forEach(chip => {
                if (chip.textContent === name) { chip.classList.add('selected'); chipFound = true; }
              });
              if (!chipFound) addChip(name).classList.add('selected');
            });
          } catch (e) {
            showStatus(`AI抽出エラー: ${e.message}`, 'error');
          } finally {
            aiExtractBtn.disabled = false;
            aiExtractBtn.textContent = 'AI抽出';
          }
        });
        body.appendChild(aiExtractBtn);
      }
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

    // タイトルを先頭に固定
    const tIdx = newProps.findIndex(p => p.type === 'title');
    if (tIdx > 0) { const [t] = newProps.splice(tIdx, 1); newProps.unshift(t); }

    const { propertyOrder = {} } = await chrome.storage.local.get('propertyOrder');
    propertyOrder[currentDb.id] = newProps.map(p => p.name);
    await chrome.storage.local.set({ propertyOrder });

    renderForm(newProps, { ...formValues }, {
      blank: { ...currentUiState.blank },
      today: { ...currentUiState.today }
    });
  });
}

// ========== カラム区切りリサイズ ==========
function setupColDivider() {
  const divider = document.getElementById('col-divider');
  const rightCol = document.getElementById('right-col');
  if (!divider || !rightCol) return;

  rightCol.style.width = savedRightColWidth + 'px';

  const MIN_LEFT = 160;
  const MIN_RIGHT = 120;
  let startX, startW;

  divider.addEventListener('mousedown', (e) => {
    e.preventDefault();
    startX = e.clientX;
    startW = rightCol.offsetWidth;
    divider.classList.add('dragging');
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  function onMove(e) {
    const delta = e.clientX - startX;
    const maxRight = document.body.offsetWidth - MIN_LEFT - divider.offsetWidth;
    const newRight = Math.max(MIN_RIGHT, Math.min(maxRight, startW - delta));
    rightCol.style.width = newRight + 'px';
  }

  async function onUp() {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    divider.classList.remove('dragging');
    savedRightColWidth = rightCol.offsetWidth;
    await chrome.storage.local.set({ rightColWidth: savedRightColWidth });
  }
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
  const { presets = {}, presetOrder = [] } = await chrome.storage.local.get(['presets', 'presetOrder']);
  const chips = document.getElementById('preset-chips');
  chips.innerHTML = '';

  const allNames = Object.keys(presets);
  const ordered = [
    ...presetOrder.filter(n => allNames.includes(n)),
    ...allNames.filter(n => !presetOrder.includes(n))
  ];

  ordered.forEach(name => {
    const dbName = allDatabases.find(d => d.id === presets[name].__dbId)?.name || '';
    const chip = document.createElement('button');
    chip.className = 'preset-chip' + (activePreset === name ? ' active' : '');
    chip.dataset.name = name;
    chip.draggable = true;
    chip.innerHTML = `
      <span class="preset-drag-handle">≡</span>
      <span class="preset-chip-inner">
        <span class="preset-chip-name">${escapeHtml(name)}</span>
        ${dbName ? `<span class="preset-db-badge">${escapeHtml(dbName)}</span>` : ''}
      </span>
      <span class="del-chip" data-name="${escapeHtml(name)}">×</span>`;

    chip.addEventListener('click', (e) => {
      if (e.target.closest('.del-chip') || e.target.closest('.preset-drag-handle')) return;
      applyPresetByName(name);
    });

    chip.querySelector('.del-chip').addEventListener('click', async (e) => {
      e.stopPropagation();
      const { presets: p = {}, lastPreset: lp, presetOrder: po = [] } = await chrome.storage.local.get(['presets', 'lastPreset', 'presetOrder']);
      delete p[name];
      const updates = { presets: p, presetOrder: po.filter(n => n !== name) };
      if (lp === name) updates.lastPreset = null;
      await chrome.storage.local.set(updates);
      if (activePreset === name) activePreset = null;
      renderPresets();
    });

    chips.appendChild(chip);
  });

  setupPresetDragDrop(chips);
}

function setupPresetDragDrop(container) {
  let dragSrc = null;

  container.addEventListener('dragstart', (e) => {
    dragSrc = e.target.closest('.preset-chip');
    if (!dragSrc) return;
    dragSrc.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', '');
  });

  container.addEventListener('dragend', () => {
    if (dragSrc) dragSrc.classList.remove('dragging');
    container.querySelectorAll('.preset-chip').forEach(c => c.classList.remove('drag-over'));
    dragSrc = null;
  });

  container.addEventListener('dragover', (e) => {
    e.preventDefault();
    const target = e.target.closest('.preset-chip');
    if (!target || target === dragSrc) return;
    container.querySelectorAll('.preset-chip').forEach(c => c.classList.remove('drag-over'));
    target.classList.add('drag-over');
  });

  container.addEventListener('dragleave', (e) => {
    if (!container.contains(e.relatedTarget)) {
      container.querySelectorAll('.preset-chip').forEach(c => c.classList.remove('drag-over'));
    }
  });

  container.addEventListener('drop', async (e) => {
    e.preventDefault();
    const target = e.target.closest('.preset-chip');
    if (!target || !dragSrc || target === dragSrc) return;
    const chipEls = [...container.querySelectorAll('.preset-chip')];
    const srcIdx = chipEls.indexOf(dragSrc);
    const dstIdx = chipEls.indexOf(target);
    const newOrder = chipEls.map(c => c.dataset.name);
    const [moved] = newOrder.splice(srcIdx, 1);
    newOrder.splice(dstIdx, 0, moved);
    await chrome.storage.local.set({ presetOrder: newOrder });
    renderPresets();
  });
}

// プリセット名から適用（DB切り替えも担当）
async function applyPresetByName(name) {
  const { presets = {} } = await chrome.storage.local.get('presets');
  const presetData = presets[name];
  if (!presetData) return;

  activePreset = name;
  await chrome.storage.local.set({ lastPreset: name });

  const dbId = presetData.__dbId;
  if (dbId && dbId !== currentDb?.id) {
    const dbSelect = document.getElementById('db-select');
    if (dbSelect && allDatabases.some(d => d.id === dbId)) {
      dbSelect.value = dbId;
      await loadDb(allDatabases, dbId, name);
      return;
    }
  }

  await applyPreset(presetData);
  renderPresets();
}

// プリセット適用
async function applyPreset(presetData) {
  const values = {};
  const blank = {};
  const today = {};
  let hidden = null;
  let order = null;
  let newClipMode = false;
  let clipAutoTitle = true, clipAutoBody = false, clipEmptyBody = false, clipAiBody = false;

  Object.entries(presetData).forEach(([k, v]) => {
    if (k === '__hidden') { hidden = v; return; }
    if (k === '__order') { order = v; return; }
    if (k === '__clipMode') { newClipMode = !!v; return; }
    if (k === '__clipAutoTitle') { clipAutoTitle = !!v; return; }
    if (k === '__clipAutoBody') { clipAutoBody = !!v; return; }
    if (k === '__clipEmptyBody') { clipEmptyBody = !!v; return; }
    if (k === '__clipAiBody') { clipAiBody = !!v; return; }
    if (k === '__clipAiPrompt') { return; }
    if (k.startsWith('__blank_')) { blank[k.slice(8)] = v; return; }
    if (k.startsWith('__today_')) { today[k.slice(8)] = v; return; }
    values[k] = v;
  });

  // クリップモード復元
  if (newClipMode !== clipMode) {
    clipMode = newClipMode;
    const clipBtn = document.getElementById('clip-mode-btn');
    if (clipBtn) clipBtn.classList.toggle('clip-active', clipMode);
    if (clipMode) await extractClipContent();
  }

  // 折りたたみ状態を適用
  if (hidden !== null) {
    currentHiddenFields = new Set(hidden);
    const { hiddenFields = {} } = await chrome.storage.local.get('hiddenFields');
    hiddenFields[currentDb.id] = hidden;
    await chrome.storage.local.set({ hiddenFields });
  }

  // プロパティ順序を適用
  if (order !== null) {
    const allPropsForPreset = [...currentDb.properties, BODY_PSEUDO, IMAGE_PSEUDO];
    const reordered = order
      .map(name => allPropsForPreset.find(p => p.name === name))
      .filter(Boolean)
      .concat(allPropsForPreset.filter(p => !order.includes(p.name)));
    currentSortedProperties = reordered;
    const { propertyOrder = {} } = await chrome.storage.local.get('propertyOrder');
    propertyOrder[currentDb.id] = order;
    await chrome.storage.local.set({ propertyOrder });
  }

  currentUiState = { blank: {}, today: {}, clipAutoTitle, clipAutoBody, clipEmptyBody, clipAiBody };
  if (clipMode) {
    const titleProp = currentSortedProperties.find(p => p.type === 'title');
    if (titleProp && clipAutoTitle) values[titleProp.name] = clipData.title;
    if (clipAutoBody) values['__body'] = clipData.bodyText;
    if (clipEmptyBody) values['__body'] = '';
  }
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

  const presetData = {
    __dbId: currentDb.id,
    __clipMode: clipMode,
    ...formValues,
    __hidden: [...currentHiddenFields],
    __order: currentSortedProperties.map(p => p.name),
  };
  Object.entries(currentUiState.blank).forEach(([k, v]) => { presetData[`__blank_${k}`] = v; });
  Object.entries(currentUiState.today).forEach(([k, v]) => { presetData[`__today_${k}`] = v; });
  if (clipMode) {
    presetData.__clipAutoTitle = currentUiState.clipAutoTitle;
    presetData.__clipAutoBody = currentUiState.clipAutoBody;
    presetData.__clipEmptyBody = currentUiState.clipEmptyBody;
    presetData.__clipAiBody = currentUiState.clipAiBody;
  }

  const { presets = {}, presetOrder = [] } = await chrome.storage.local.get(['presets', 'presetOrder']);
  presets[name] = presetData;
  const newOrder = presetOrder.includes(name) ? presetOrder : [...presetOrder, name];
  await chrome.storage.local.set({ presets, presetOrder: newOrder, lastPreset: name });

  activePreset = name;
  document.getElementById('preset-dialog').classList.add('hidden');
  renderPresets();
  showStatus(`プリセット「${name}」を保存しました`, 'success');
});

// ========== 保存履歴 ==========
function getCurrentTitle() {
  if (currentDb) {
    const tp = currentDb.properties.find(p => p.type === 'title');
    if (tp && formValues[tp.name]) return String(formValues[tp.name]);
  }
  if (clipMode && clipData.title) return clipData.title;
  return '';
}

async function renderHistory() {
  const listEl = document.getElementById('history-list');
  if (!listEl) return;

  const { saveHistory = [], historyCount = 5 } = await chrome.storage.local.get(['saveHistory', 'historyCount']);
  const count = Math.max(0, Number(historyCount) || 5);

  if (count === 0 || saveHistory.length === 0) {
    listEl.innerHTML = '<div class="history-empty">保存履歴はまだありません</div>';
    return;
  }

  const currentTitle = getCurrentTitle();
  listEl.innerHTML = '';
  saveHistory.slice(0, count).forEach(item => {
    const wrapper = document.createElement('div');
    wrapper.className = 'history-item-wrapper';

    const a = document.createElement('a');
    a.href = item.pageUrl;
    a.target = '_blank';
    a.rel = 'noopener';
    a.className = 'history-item';

    const titleSpan = document.createElement('span');
    titleSpan.className = 'history-item-title';
    titleSpan.textContent = item.title || '(タイトルなし)';
    a.appendChild(titleSpan);

    if (currentTitle && item.title && item.title === currentTitle) {
      const badge = document.createElement('span');
      badge.className = 'history-saved-badge';
      badge.textContent = '保存済み';
      a.appendChild(badge);
    }

    const dbSpan = document.createElement('span');
    dbSpan.className = 'history-item-db';
    dbSpan.textContent = item.dbName || '';
    a.appendChild(dbSpan);

    const delBtn = document.createElement('button');
    delBtn.className = 'history-del-btn';
    delBtn.textContent = '×';
    delBtn.title = '削除';
    delBtn.addEventListener('click', async () => {
      const { saveHistory: h = [] } = await chrome.storage.local.get('saveHistory');
      await chrome.storage.local.set({ saveHistory: h.filter(i => i.savedAt !== item.savedAt) });
      renderHistory();
    });

    wrapper.appendChild(a);
    wrapper.appendChild(delBtn);
    listEl.appendChild(wrapper);
  });
}

// ========== クリップモード ==========
async function toggleClipMode() {
  clipMode = !clipMode;
  document.getElementById('clip-mode-btn').classList.toggle('clip-active', clipMode);
  if (clipMode) {
    await extractClipContent();
    if (currentUiState.clipAutoTitle) {
      const titleProp = currentSortedProperties.find(p => p.type === 'title');
      if (titleProp) formValues[titleProp.name] = clipData.title;
    }
    if (currentUiState.clipAutoBody) formValues['__body'] = clipData.bodyText;
  }
  renderForm(currentSortedProperties, { ...formValues }, {
    blank: { ...currentUiState.blank },
    today: { ...currentUiState.today }
  });
}

async function extractClipContent() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const title = document.title;
        let ogImage = document.querySelector('meta[property="og:image:secure_url"]')?.content ||
                      document.querySelector('meta[property="og:image"]')?.content ||
                      document.querySelector('meta[name="twitter:image"]')?.content ||
                      document.querySelector('meta[name="twitter:image:src"]')?.content || '';
        if (ogImage.startsWith('//')) ogImage = 'https:' + ogImage;
        const mainEl = document.querySelector('article') ||
                       document.querySelector('[role="main"]') ||
                       document.querySelector('main') || document.body;
        const bodyText = mainEl.innerText.replace(/\n{3,}/g, '\n\n').trim().slice(0, 10000);
        return { title, ogImage, bodyText };
      }
    });
    if (result?.result) {
      clipData.title = result.result.title;
      clipData.imageUrl = result.result.ogImage;
      clipData.bodyText = result.result.bodyText;
      clipData.includeImage = true;
    }
  } catch (e) {
    console.error('extractClipContent error:', e);
    showStatus(`取得失敗: ${e.message}`, 'error');
  }
}


// ========== フォームクリア ==========
async function clearForm() {
  activePreset = null;
  currentUiState = { blank: {}, today: {}, clipAutoTitle: true, clipAutoBody: false, clipEmptyBody: false, clipAiBody: false };
  clipData.bodyText = '';
  clipData.title = '';
  clipData.imageUrl = '';
  await chrome.storage.local.set({ lastPreset: null });
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

  const pageBody = { parent: { database_id: currentDb.id }, properties };

  if (clipMode) {
    // ページURLをurl型プロパティに強制保存（空欄チェック等を無視）
    const urlProp = currentDb.properties.find(p => p.type === 'url');
    if (urlProp && currentTabUrl) {
      properties[urlProp.name] = { url: currentTabUrl };
    }

    // ヘッダ画像 → ページカバー
    if (clipData.includeImage && clipData.imageUrl.trim()) {
      pageBody.cover = { type: 'external', external: { url: clipData.imageUrl.trim() } };
    }
    // タイトル → title型プロパティが未入力なら補完
    const titleProp = currentDb.properties.find(p => p.type === 'title');
    if (titleProp && clipData.title && !properties[titleProp.name]) {
      properties[titleProp.name] = { title: [{ text: { content: clipData.title } }] };
    }
  }

  // 本文 → childrenブロック（Markdown変換）
  const bodyText = (formValues['__body'] || '').trim();
  if (bodyText) {
    pageBody.children = markdownToNotionBlocks(bodyText);
  }

  try {
    const response = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(pageBody)
    });

    if (!response.ok) {
      const err = await response.json();
      showStatus(`エラー: ${err.message || response.status}`, 'error');
    } else {
      const data = await response.json();
      // 履歴に追加
      const tp = currentDb.properties.find(p => p.type === 'title');
      let savedTitle = (tp && formValues[tp.name]) ? String(formValues[tp.name]) : '';
      if (!savedTitle && clipMode && clipData.title) savedTitle = clipData.title;
      const { saveHistory: hist = [] } = await chrome.storage.local.get('saveHistory');
      hist.unshift({ title: savedTitle, pageUrl: data.url, dbId: currentDb.id, dbName: currentDb.name, savedAt: Date.now() });
      if (hist.length > 50) hist.splice(50);
      await chrome.storage.local.set({ saveHistory: hist });
      renderHistory();
      const coverFailed = clipMode && clipData.includeImage && clipData.imageUrl && !data.cover;
      showStatus(coverFailed ? 'Notionに追加しました（画像カバーは設定できませんでした）' : 'Notionに追加しました！', coverFailed ? 'error' : 'success');
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
    if (prop.type === '__body') return;
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

// ========== Gemini AI ==========
async function callGemini(prompt) {
  const { geminiApiKey } = await chrome.storage.local.get('geminiApiKey');
  if (!geminiApiKey) throw new Error('設定でGemini APIキーを登録してください');
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiApiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    }
  );
  if (!res.ok) { const err = await res.json(); throw new Error(err.error?.message || res.status); }
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

function fillAiTemplate(template) {
  return template
    .replace(/\{\{title\}\}/g, clipData.title || '')
    .replace(/\{\{url\}\}/g, currentTabUrl || '')
    .replace(/\{\{body\}\}/g, clipData.bodyText || '');
}

// ========== Markdown → Notionブロック変換 ==========
function parseInline(text) {
  const parts = [];
  const regex = /\*\*\*(.*?)\*\*\*|\*\*(.*?)\*\*|\*(.*?)\*/g;
  let last = 0, m;
  while ((m = regex.exec(text)) !== null) {
    if (m.index > last) parts.push({ type: 'text', text: { content: text.slice(last, m.index) } });
    if (m[1] != null) parts.push({ type: 'text', text: { content: m[1] }, annotations: { bold: true, italic: true } });
    else if (m[2] != null) parts.push({ type: 'text', text: { content: m[2] }, annotations: { bold: true } });
    else if (m[3] != null) parts.push({ type: 'text', text: { content: m[3] }, annotations: { italic: true } });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ type: 'text', text: { content: text.slice(last) } });
  return parts.length > 0 ? parts : [{ type: 'text', text: { content: text } }];
}

function markdownToNotionBlocks(md, maxBlocks = 100) {
  const lines = md.split('\n');
  const blocks = [];
  let lastBullet = null;

  for (const line of lines) {
    if (blocks.length >= maxBlocks) break;
    if (!line.trim()) { lastBullet = null; continue; }

    if (/^-{3,}$/.test(line.trim())) {
      blocks.push({ object: 'block', type: 'divider', divider: {} });
      lastBullet = null; continue;
    }
    const h3 = line.match(/^### (.+)/);
    if (h3) { blocks.push({ object: 'block', type: 'heading_3', heading_3: { rich_text: parseInline(h3[1]) } }); lastBullet = null; continue; }
    const h2 = line.match(/^## (.+)/);
    if (h2) { blocks.push({ object: 'block', type: 'heading_2', heading_2: { rich_text: parseInline(h2[1]) } }); lastBullet = null; continue; }
    const h1 = line.match(/^# (.+)/);
    if (h1) { blocks.push({ object: 'block', type: 'heading_1', heading_1: { rich_text: parseInline(h1[1]) } }); lastBullet = null; continue; }

    // インデントされた箇条書き（ネスト）
    const nested = line.match(/^ {2,}[-*]\s+(.+)/);
    if (nested && lastBullet) {
      if (!lastBullet.bulleted_list_item.children) lastBullet.bulleted_list_item.children = [];
      lastBullet.bulleted_list_item.children.push({
        object: 'block', type: 'bulleted_list_item',
        bulleted_list_item: { rich_text: parseInline(nested[1]) }
      });
      continue;
    }

    const bullet = line.match(/^[-*]\s+(.+)/);
    if (bullet) {
      const b = { object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: parseInline(bullet[1]) } };
      blocks.push(b); lastBullet = b; continue;
    }

    const numbered = line.match(/^\d+\.\s+(.+)/);
    if (numbered) {
      blocks.push({ object: 'block', type: 'numbered_list_item', numbered_list_item: { rich_text: parseInline(numbered[1]) } });
      lastBullet = null; continue;
    }

    blocks.push({ object: 'block', type: 'paragraph', paragraph: { rich_text: parseInline(line) } });
    lastBullet = null;
  }
  return blocks;
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ========== リサイズ ==========
(function setupResize() {
  const handle = document.getElementById('resize-handle');
  let startX, startY, startW;

  let startH;

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    startX = e.clientX;
    startY = e.clientY;
    startW = document.body.offsetWidth;
    startH = document.body.offsetHeight;
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  function onMove(e) {
    const newW = Math.max(300, Math.min(700, startW + e.clientX - startX));
    const newH = Math.max(300, startH + e.clientY - startY);
    document.body.style.width = newW + 'px';
    document.body.style.height = newH + 'px';
  }

  async function onUp() {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    savedPopupSize = {
      width: document.body.offsetWidth,
      height: document.body.offsetHeight
    };
    await chrome.storage.local.set({ popupSize: savedPopupSize });
  }
})();

// ========== 起動 ==========
document.getElementById('open-options').addEventListener('click', openOptions);
document.getElementById('clip-mode-btn').addEventListener('click', toggleClipMode);
document.getElementById('submit-btn').addEventListener('click', submitToNotion);
document.getElementById('clear-btn').addEventListener('click', clearForm);
init();
