/* 蛙蛙写作助手 v1.2.0 - 功能页逻辑
 *
 * 数据来源（均为蛙蛙写作官方接口，通过已登录标签页发起，自动携带 Cookie）：
 *   1. 投稿作品列表  POST /wrhp-api/api/v1/submission/novel/my_list
 *      body: { page, page_size }  ->  { code:200, data: { items, total } }
 *   2. 作品收益汇总  GET /wrhp-api/api/v1/submission/novel/my_revenue
 *      -> { code:200, data: [ { base_novel_id, total_revenue,
 *           latest:{ revenue, follow_user_cnt },
 *           previous:{ revenue, available, follow_user_cnt } }, ... ] }
 *
 * 本地存储：
 *   readerHistory  - 每日在读人数快照
 *   revenueHistory - 每日收益快照（v1.2.0 新增）
 */

'use strict';

const API_BASE = 'https://wawawriter.com';
const MY_LIST_PATH = '/wrhp-api/api/v1/submission/novel/my_list';
const MY_REVENUE_PATH = '/wrhp-api/api/v1/submission/novel/my_revenue';
const PAGE_SIZE = 50;
const MAX_PAGES = 60;
const HISTORY_KEY = 'readerHistory';
const REVENUE_HISTORY_KEY = 'revenueHistory';
const TOTAL_KEY = '__total__';

const DAILY_UPDATE_HOUR = 14;
const DAILY_UPDATE_MINUTE = 30;

const STATUS_MAP = {
  draft: ['草稿', ''],
  reviewing: ['投稿审核中', 'review'],
  approved: ['审核成功', 'signed'],
  rejected: ['审核失败', 'fail'],
  contracting: ['签约中', 'review'],
  contracted: ['已签约', 'signed'],
  contract_rejected: ['签约失败', 'fail']
};

const SORT_KEYS = ['title', 'status', 'totalWordCount', 'totalRevenue', 'yesterdayRevenue', 'latestRevenue', 'trend', 'readers', 'readersChange', 'fetchStatus'];

const state = {
  rows: [],
  isLoading: false,
  history: { books: {} },
  revenueHistory: { books: {} },
  sort: { key: null, asc: true },
  filter: { search: '', status: '', revenue: '' }
};

/* ---------------- 基础工具 ---------------- */

function $(id) {
  return document.getElementById(id);
}

function setStatus(message, type) {
  const el = $('status');
  if (!el) return;
  el.textContent = message;
  el.dataset.type = type || 'info';
}

function setButtonsDisabled(disabled) {
  ['loadBooks', 'fetchRevenue', 'exportExcel', 'exportChart'].forEach((id) => {
    const btn = $(id);
    if (btn) btn.disabled = disabled;
  });
}

function roundMoney(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.round(number * 100) / 100;
}

function formatMoney(value) {
  return roundMoney(value).toFixed(2);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char]));
}

function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function formatShortDate(date) {
  const part = String(date).split('-');
  return part.length === 3 ? `${part[1]}-${part[2]}` : date;
}

function getSnapshotDate() {
  const now = new Date();
  const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate(), DAILY_UPDATE_HOUR, DAILY_UPDATE_MINUTE, 0, 0);
  if (now < cutoff) {
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    return formatDate(yesterday);
  }
  return formatDate(now);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatSignedNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  const rounded = Math.round(number);
  return rounded > 0 ? `+${rounded}` : String(rounded);
}

/* ---------------- 标签页与请求 ---------------- */

async function getWawaTab(create) {
  const response = await chrome.runtime.sendMessage({ action: 'getWawaTab', create: Boolean(create) });
  if (!response?.success) throw new Error(response?.error || '无法获取蛙蛙写作标签页');
  return response.tab || null;
}

async function wawaApi(tabId, method, path, body) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: async (url, method, bodyText) => {
      try {
        const options = {
          method,
          credentials: 'include',
          headers: { 'Accept': 'application/json, text/plain, */*' },
          signal: AbortSignal.timeout(30000)
        };
        if (bodyText) {
          options.headers['Content-Type'] = 'application/json';
          options.body = bodyText;
        }
        const response = await fetch(url, options);
        const text = await response.text();
        if (response.status === 401 || response.status === 403) {
          return { __error: `登录态失效（HTTP ${response.status}），请在浏览器中重新登录蛙蛙写作` };
        }
        if (!response.ok) {
          return { __error: `接口请求失败（HTTP ${response.status}）：${text.slice(0, 120)}` };
        }
        try {
          return JSON.parse(text);
        } catch (error) {
          return { __error: `接口返回不是 JSON：${text.replace(/\s+/g, ' ').slice(0, 120)}` };
        }
      } catch (error) {
        return { __error: error?.message || String(error) };
      }
    },
    args: [API_BASE + path, method, body ? JSON.stringify(body) : '']
  });
  const result = results?.[0]?.result;
  if (!result) throw new Error('页面脚本执行失败，请刷新蛙蛙写作页面后重试');
  if (result.__error) throw new Error(result.__error);
  return result;
}

function ensureApiOk(json, fallbackMessage) {
  if (!json || typeof json !== 'object') throw new Error(fallbackMessage || '接口没有返回 JSON');
  if (json.code !== undefined && Number(json.code) !== 200) {
    throw new Error(json.message || json.msg || fallbackMessage || `接口返回 code=${json.code}`);
  }
}

/* ---------------- 数据加载 ---------------- */

async function fetchAllSubmissions(tabId) {
  const items = [];
  let total = Infinity;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const json = await wawaApi(tabId, 'POST', MY_LIST_PATH, { page, page_size: PAGE_SIZE });
    ensureApiOk(json, '投稿列表接口返回异常');
    const data = json.data || {};
    const batch = Array.isArray(data.items) ? data.items : [];
    items.push(...batch);
    if (Number.isFinite(Number(data.total))) total = Number(data.total);
    if (!batch.length || (total !== Infinity && items.length >= total) || batch.length < PAGE_SIZE) break;
    await sleep(250);
  }
  return items;
}

async function fetchAllSubmissionsWithDetails(tabId) {
  const items = await fetchAllSubmissions(tabId);
  if (!items.length) return items;

  setStatus(`已读取 ${items.length} 本作品，正在获取收益数据...`, 'loading');
  try {
    const revenueJson = await wawaApi(tabId, 'GET', MY_REVENUE_PATH);
    ensureApiOk(revenueJson, '收益汇总接口返回异常');
    const list = Array.isArray(revenueJson.data) ? revenueJson.data : [];
    const map = new Map();
    for (const rev of list) {
      const id = rev?.base_novel_id;
      if (id !== undefined && id !== null && id !== '') {
        map.set(String(id), rev);
      }
    }
    for (const item of items) {
      const id = item?.base_novel_id;
      if (id !== undefined && id !== null && id !== '') {
        const rev = map.get(String(id));
        if (rev && typeof rev === 'object') {
          item.revenue = rev;
        }
      }
    }
  } catch (error) {
    console.warn('获取收益汇总失败：', error);
  }

  return items;
}

async function applyRows(items) {
  state.rows = items.map((item) => ({
    item,
    ok: true,
    hasRevenue: Boolean(item?.revenue && item.revenue.total_revenue !== undefined)
  }));
  renderRows();
  await saveDailySnapshot();
  await saveRevenueSnapshot();
}

async function loadBooks() {
  if (state.isLoading) return;
  state.isLoading = true;
  setButtonsDisabled(true);
  try {
    setStatus('正在读取投稿作品列表...', 'loading');
    let tab = await getWawaTab(false);
    if (!tab) {
      setStatus('未找到蛙蛙写作标签页，正在后台打开...', 'loading');
      tab = await getWawaTab(true);
    }
    const items = await fetchAllSubmissionsWithDetails(tab.id);
    if (!items.length) {
      state.rows = [];
      renderRows();
      setStatus('没有读取到投稿作品。请确认已登录蛙蛙写作，且在蛙蛙写作中创建过投稿。', 'warning');
      return;
    }
    await applyRows(items);
    const signed = state.rows.filter((row) => row.hasRevenue).length;
    setStatus(`已加载 ${items.length} 本投稿作品，其中 ${signed} 本已匹配到收益数据。`, 'success');
    hideReminder();
  } catch (error) {
    setStatus(`加载作品失败：${error.message || error}`, 'error');
  } finally {
    state.isLoading = false;
    setButtonsDisabled(false);
  }
}

async function fetchRevenue() {
  if (state.isLoading) return;
  state.isLoading = true;
  setButtonsDisabled(true);
  try {
    setStatus('正在加载作品列表并获取收益...', 'loading');
    let tab = await getWawaTab(false);
    if (!tab) {
      setStatus('未找到蛙蛙写作标签页，正在后台打开...', 'loading');
      tab = await getWawaTab(true);
    }

    const items = await fetchAllSubmissionsWithDetails(tab.id);
    if (!items.length) {
      state.rows = [];
      renderRows();
      setStatus('没有读取到投稿作品。请确认已登录蛙蛙写作，且在蛙蛙写作中创建过投稿。', 'warning');
      return;
    }

    await applyRows(items);
    const signed = state.rows.filter((row) => row.hasRevenue).length;
    const total = state.rows.reduce((sum, row) => sum + getTotalRevenue(row), 0);
    setStatus(
      `收益统计完成：共 ${state.rows.length} 本投稿作品，其中 ${signed} 本已产生收益，历史总收益合计 ${formatMoney(total)} 元。${getSnapshotDate()} 在读人数快照已记录（按蛙蛙数据更新时间 14:30 归属日期）。`,
      'success'
    );
    hideReminder();
  } catch (error) {
    setStatus(`一键获取收益失败：${error.message || error}`, 'error');
  } finally {
    state.isLoading = false;
    setButtonsDisabled(false);
  }
}

/* ---------------- 每日在读人数快照 ---------------- */

async function loadHistory() {
  try {
    const stored = await chrome.storage.local.get(HISTORY_KEY);
    const history = stored?.[HISTORY_KEY];
    if (history && typeof history === 'object' && history.books && typeof history.books === 'object') {
      state.history = history;
    } else {
      state.history = { books: {} };
    }
  } catch (error) {
    state.history = { books: {} };
  }
  return state.history;
}

async function loadRevenueHistory() {
  try {
    const stored = await chrome.storage.local.get(REVENUE_HISTORY_KEY);
    const history = stored?.[REVENUE_HISTORY_KEY];
    if (history && typeof history === 'object' && history.books && typeof history.books === 'object') {
      state.revenueHistory = history;
    } else {
      state.revenueHistory = { books: {} };
    }
  } catch (error) {
    state.revenueHistory = { books: {} };
  }
  return state.revenueHistory;
}

function getBookId(item) {
  const id = item?.submission_id ?? item?.id;
  return id === undefined || id === null || id === '' ? String(item?.title || '未命名作品') : String(id);
}

async function saveDailySnapshot() {
  const snapshotDate = getSnapshotDate();
  const history = await loadHistory();
  const books = history.books || {};
  state.rows.forEach((row) => {
    const item = row.item || {};
    const readers = getReadersNum(row);
    if (readers === null) return;
    const id = getBookId(item);
    const entry = books[id] || { title: item.title || '未命名作品', points: {} };
    entry.title = item.title || entry.title;
    entry.points = entry.points || {};
    entry.points[snapshotDate] = readers;
    books[id] = entry;
  });
  history.books = books;
  state.history = history;
  try {
    await chrome.storage.local.set({ [HISTORY_KEY]: history });
  } catch (error) {
    // 存储失败不影响主流程
  }
  populateChartBooks();
  drawChart();
}

async function saveRevenueSnapshot() {
  const snapshotDate = getSnapshotDate();
  const history = await loadRevenueHistory();
  const books = history.books || {};
  state.rows.forEach((row) => {
    const item = row.item || {};
    if (!row.hasRevenue) return;
    const id = getBookId(item);
    const entry = books[id] || { title: item.title || '未命名作品', points: {} };
    entry.title = item.title || entry.title;
    entry.points = entry.points || {};
    entry.points[snapshotDate] = getTotalRevenue(row);
    books[id] = entry;
  });
  history.books = books;
  state.revenueHistory = history;
  try {
    await chrome.storage.local.set({ [REVENUE_HISTORY_KEY]: history });
  } catch (error) {
    // 存储失败不影响主流程
  }
  populateRevenueChartBooks();
  drawRevenueChart();
}

/* ---------------- 展示 ---------------- */

function getStatusText(item) {
  const mapped = STATUS_MAP[item?.status];
  const base = mapped ? mapped[0] : (item?.status || '未知');
  if (item?.status === 'contracted') {
    if (item?.finish_status === 'pending') return '完结审核中';
    if (item?.is_finished) return '已完结';
    return '已签约·连载中';
  }
  return base;
}

function getStatusClass(item) {
  return (STATUS_MAP[item?.status] || ['', ''])[1] || '';
}

function getTotalRevenue(row) {
  return roundMoney(row?.item?.revenue?.total_revenue);
}

function getLatestRevenue(row) {
  const latest = row?.item?.revenue?.latest;
  if (!latest || latest.revenue === undefined || latest.revenue === null) return null;
  return roundMoney(latest.revenue);
}

function getYesterdayRevenue(row) {
  const previous = row?.item?.revenue?.previous;
  if (!previous || !previous.available || previous.revenue === undefined || previous.revenue === null) return null;
  return roundMoney(previous.revenue);
}

function getTrend(row) {
  const latest = getLatestRevenue(row);
  const yesterday = getYesterdayRevenue(row);
  if (latest === null || yesterday === null) {
    return { text: '—', type: 'neutral' };
  }
  const diff = roundMoney(latest - yesterday);
  if (diff > 0) return { text: `增加${formatMoney(diff)}元`, type: 'up' };
  if (diff < 0) return { text: `降低${formatMoney(Math.abs(diff))}元`, type: 'down' };
  return { text: '持平0.00元', type: 'flat' };
}

function getReadersNum(row) {
  const latest = row?.item?.revenue?.latest;
  if (latest && Number.isFinite(Number(latest.follow_user_cnt)) && Number(latest.follow_user_cnt) >= 0) {
    return Number(latest.follow_user_cnt);
  }
  const previous = row?.item?.revenue?.previous;
  if (previous && Number.isFinite(Number(previous.follow_user_cnt)) && Number(previous.follow_user_cnt) >= 0) {
    return Number(previous.follow_user_cnt);
  }
  return null;
}

function getReaders(row) {
  const value = getReadersNum(row);
  return value === null ? '—' : value.toLocaleString();
}

function getReadersChange(row) {
  const item = row?.item || {};
  const latestCnt = getReadersNum(row);
  const previousCnt = item?.revenue?.previous?.follow_user_cnt;
  const snapshotDate = getSnapshotDate();

  let diff = null;
  if (latestCnt !== null && Number.isFinite(Number(previousCnt))) {
    diff = latestCnt - Number(previousCnt);
  } else {
    const id = getBookId(item);
    const points = state.history?.books?.[id]?.points;
    if (points && latestCnt !== null) {
      const dates = Object.keys(points).sort();
      for (let i = dates.length - 1; i >= 0; i -= 1) {
        if (dates[i] < snapshotDate && Number.isFinite(Number(points[dates[i]]))) {
          diff = latestCnt - Number(points[dates[i]]);
          break;
        }
      }
    }
  }

  if (diff === null) return { text: '—', type: 'neutral', diff: null };
  const rounded = Math.round(diff);
  if (rounded > 0) return { text: `增加${rounded}`, type: 'up', diff: rounded };
  if (rounded < 0) return { text: `减少${Math.abs(rounded)}`, type: 'down', diff: rounded };
  return { text: '持平', type: 'flat', diff: 0 };
}

function moneyText(value) {
  return value === null ? '—' : formatMoney(value);
}

/* ---------------- 排序 ---------------- */

function getSortValue(row, key) {
  const item = row.item || {};
  switch (key) {
    case 'title':
      return item.title || '未命名作品';
    case 'status':
      return getStatusText(item);
    case 'totalWordCount':
      return Number.isFinite(Number(item.total_word_count)) ? Number(item.total_word_count) : -1;
    case 'totalRevenue':
      return row.hasRevenue ? getTotalRevenue(row) : null;
    case 'yesterdayRevenue':
      return getYesterdayRevenue(row);
    case 'latestRevenue':
      return getLatestRevenue(row);
    case 'trend': {
      const t = getTrend(row);
      if (t.type === 'neutral') return null;
      const latest = getLatestRevenue(row);
      const yesterday = getYesterdayRevenue(row);
      return (latest !== null && yesterday !== null) ? roundMoney(latest - yesterday) : null;
    }
    case 'readers':
      return getReadersNum(row);
    case 'readersChange':
      return getReadersChange(row).diff;
    case 'fetchStatus':
      return row.hasRevenue ? 1 : 0;
    default:
      return null;
  }
}

function compareSortValues(a, b, key) {
  const va = getSortValue(a, key);
  const vb = getSortValue(b, key);
  if (va === vb) return 0;
  if (va === null || va === undefined) return 1;
  if (vb === null || vb === undefined) return -1;
  if (typeof va === 'string' && typeof vb === 'string') {
    return va.localeCompare(vb, 'zh-CN');
  }
  return va < vb ? -1 : 1;
}

function getProcessedRows() {
  let rows = state.rows;

  const f = state.filter;
  if (f.search) {
    const q = f.search.toLowerCase();
    rows = rows.filter((row) => {
      const item = row.item || {};
      return (item.title || '').toLowerCase().includes(q) ||
             (item.pen_name || '').toLowerCase().includes(q);
    });
  }
  if (f.status) {
    rows = rows.filter((row) => (row.item?.status) === f.status);
  }
  if (f.revenue === 'has') {
    rows = rows.filter((row) => row.hasRevenue);
  } else if (f.revenue === 'none') {
    rows = rows.filter((row) => !row.hasRevenue);
  }

  if (!state.sort.key) return rows.slice();
  const key = state.sort.key;
  const dir = state.sort.asc ? 1 : -1;
  return rows.slice().sort((a, b) => compareSortValues(a, b, key) * dir);
}

function toggleSort(key) {
  if (state.sort.key === key) {
    if (state.sort.asc) {
      state.sort.asc = false;
    } else {
      state.sort.key = null;
      state.sort.asc = true;
      renderRows();
      return;
    }
  } else {
    state.sort.key = key;
    state.sort.asc = true;
  }
  renderRows();
}

function initSortHeaders() {
  const ths = document.querySelectorAll('.revenue-table thead th');
  ths.forEach((th, index) => {
    if (index >= SORT_KEYS.length) return;
    const key = SORT_KEYS[index];
    th.classList.add('sortable');
    th.dataset.sortKey = key;
    th.addEventListener('click', () => toggleSort(key));
  });
}

function updateSortIndicators() {
  const ths = document.querySelectorAll('.revenue-table thead th');
  ths.forEach((th) => {
    th.classList.remove('sort-asc', 'sort-desc');
    const arrow = th.querySelector('.sort-arrow');
    if (arrow) arrow.remove();
    if (th.dataset.sortKey === state.sort.key) {
      th.classList.add(state.sort.asc ? 'sort-asc' : 'sort-desc');
      const span = document.createElement('span');
      span.className = 'sort-arrow';
      span.textContent = state.sort.asc ? ' ▲' : ' ▼';
      th.appendChild(span);
    }
  });
}

/* ---------------- 搜索 / 筛选 ---------------- */

function initFilters() {
  const searchInput = $('searchInput');
  const searchClear = $('searchClear');
  const filterStatus = $('filterStatus');
  const filterRevenue = $('filterRevenue');

  searchInput.addEventListener('input', () => {
    state.filter.search = searchInput.value.trim();
    searchClear.style.display = searchInput.value ? '' : 'none';
    renderRows();
  });

  searchClear.addEventListener('click', () => {
    searchInput.value = '';
    state.filter.search = '';
    searchClear.style.display = 'none';
    renderRows();
    searchInput.focus();
  });

  filterStatus.addEventListener('change', () => {
    state.filter.status = filterStatus.value;
    renderRows();
  });

  filterRevenue.addEventListener('change', () => {
    state.filter.revenue = filterRevenue.value;
    renderRows();
  });
}

/* ---------------- 渲染 ---------------- */

function renderRows() {
  const body = $('tableBody');
  if (!body) return;

  const processed = getProcessedRows();

  const filterCount = $('filterCount');
  const hasFilter = state.filter.search || state.filter.status || state.filter.revenue;
  if (filterCount) {
    if (hasFilter && state.rows.length) {
      filterCount.textContent = `${processed.length} / ${state.rows.length} 条`;
    } else {
      filterCount.textContent = '';
    }
  }

  if (!processed.length) {
    const msg = !state.rows.length ? '暂无数据' : '没有匹配的作品';
    body.innerHTML = `<tr><td colspan="10" class="empty">${msg}</td></tr>`;
    renderSummary();
    return;
  }

  body.innerHTML = processed.map((row) => {
    const item = row.item || {};
    const trend = getTrend(row);
    const trendClass = trend.type === 'down' ? 'warn' : 'ok';
    const change = getReadersChange(row);
    const changeClass = change.type === 'down' ? 'warn' : (change.type === 'neutral' ? 'neutral' : 'ok');
    const revenueAvailable = row.hasRevenue;
    const statusText = getStatusText(item);
    return [
      '<tr class="' + (revenueAvailable ? '' : 'has-warning') + '">',
      '<td><b>' + escapeHtml(item.title || '未命名作品') + '</b></td>',
      '<td><span class="tag ' + getStatusClass(item) + '">' + escapeHtml(statusText) + '</span></td>',
      '<td>' + (Number.isFinite(Number(item.total_word_count)) ? Number(item.total_word_count).toLocaleString() : '—') + '</td>',
      '<td class="money">' + moneyText(revenueAvailable ? getTotalRevenue(row) : null) + '</td>',
      '<td class="money">' + moneyText(getYesterdayRevenue(row)) + '</td>',
      '<td class="money">' + moneyText(getLatestRevenue(row)) + '</td>',
      '<td><span class="anomaly ' + trendClass + '">' + escapeHtml(trend.text) + '</span></td>',
      '<td>' + escapeHtml(getReaders(row)) + '</td>',
      '<td><span class="anomaly ' + changeClass + '">' + escapeHtml(change.text) + '</span></td>',
      '<td>' + (revenueAvailable ? '成功（收益统计成功）' : '待核查（未签约或暂无收益数据）') + '</td>',
      '</tr>'
    ].join('');
  }).join('');

  updateSortIndicators();
  renderSummary();
}

function renderSummary() {
  const rows = state.rows;
  $('sumBooks').textContent = String(rows.length);

  const total = rows.reduce((sum, row) => sum + getTotalRevenue(row), 0);
  const yesterday = rows.reduce((sum, row) => {
    const value = getYesterdayRevenue(row);
    return sum + (value === null ? 0 : value);
  }, 0);
  const latest = rows.reduce((sum, row) => {
    const value = getLatestRevenue(row);
    return sum + (value === null ? 0 : value);
  }, 0);

  $('sumTotal').textContent = formatMoney(total);
  $('sumYesterday').textContent = formatMoney(yesterday);
  $('sumLatest').textContent = formatMoney(latest);

  // 日均收益：从收益历史中计算
  const revDates = new Set();
  Object.values(state.revenueHistory.books || {}).forEach((book) => {
    Object.keys(book.points || {}).forEach((d) => revDates.add(d));
  });
  const dayCount = revDates.size;
  if (dayCount >= 2) {
    const sortedDates = [...revDates].sort();
    const firstDate = sortedDates[0];
    const lastDate = sortedDates[sortedDates.length - 1];
    const firstTotals = {};
    const lastTotals = {};
    Object.entries(state.revenueHistory.books || {}).forEach(([id, book]) => {
      if (book.points?.[firstDate] !== undefined) firstTotals[id] = book.points[firstDate];
      if (book.points?.[lastDate] !== undefined) lastTotals[id] = book.points[lastDate];
    });
    let totalDiff = 0;
    Object.keys(lastTotals).forEach((id) => {
      if (firstTotals[id] !== undefined) {
        totalDiff += lastTotals[id] - firstTotals[id];
      }
    });
    const d0 = new Date(firstDate);
    const d1 = new Date(lastDate);
    const spanDays = Math.max(1, Math.round((d1 - d0) / 86400000));
    $('sumDailyAvg').textContent = formatMoney(totalDiff / spanDays);
  } else {
    $('sumDailyAvg').textContent = '0.00';
  }

  // 千字收益 = 历史总收益 / (总字数 / 1000)
  const totalWords = rows.reduce((sum, row) => {
    const wc = Number(row.item?.total_word_count);
    return sum + (Number.isFinite(wc) ? wc : 0);
  }, 0);
  if (totalWords > 0 && total > 0) {
    $('sumPerKilo').textContent = formatMoney(total / (totalWords / 1000));
  } else {
    $('sumPerKilo').textContent = '0.00';
  }

  // 预估月收益 = 日均收益 * 30
  if (dayCount >= 2) {
    const dailyAvgText = $('sumDailyAvg').textContent.replace(/,/g, '');
    const dailyAvg = parseFloat(dailyAvgText) || 0;
    $('sumEstMonth').textContent = formatMoney(dailyAvg * 30);
  } else {
    $('sumEstMonth').textContent = '0.00';
  }

  // 在读总人数
  const totalReaders = rows.reduce((sum, row) => {
    const r = getReadersNum(row);
    return sum + (r !== null ? r : 0);
  }, 0);
  $('sumReaders').textContent = totalReaders.toLocaleString();
}

/* ---------------- 在读人数曲线 ---------------- */

function getSeries(key) {
  const books = state.history?.books || {};
  const dates = new Set();
  if (key === TOTAL_KEY) {
    Object.values(books).forEach((book) => {
      Object.keys(book.points || {}).forEach((date) => dates.add(date));
    });
  } else {
    Object.keys(books[key]?.points || {}).forEach((date) => dates.add(date));
  }
  const sorted = [...dates].sort();
  const points = sorted.map((date) => {
    let value = 0;
    let found = false;
    if (key === TOTAL_KEY) {
      Object.values(books).forEach((book) => {
        const v = book.points?.[date];
        if (Number.isFinite(v)) {
          value += v;
          found = true;
        }
      });
    } else {
      const v = books[key]?.points?.[date];
      if (Number.isFinite(v)) {
        value = v;
        found = true;
      }
    }
    return found ? { date, value } : null;
  }).filter(Boolean);
  const title = key === TOTAL_KEY ? '全部作品合计' : (books[key]?.title || '未知作品');
  return { title, points };
}

function getRevenueSeries(key) {
  const books = state.revenueHistory?.books || {};
  const dates = new Set();
  if (key === TOTAL_KEY) {
    Object.values(books).forEach((book) => {
      Object.keys(book.points || {}).forEach((date) => dates.add(date));
    });
  } else {
    Object.keys(books[key]?.points || {}).forEach((date) => dates.add(date));
  }
  const sorted = [...dates].sort();
  const points = sorted.map((date) => {
    let value = 0;
    let found = false;
    if (key === TOTAL_KEY) {
      Object.values(books).forEach((book) => {
        const v = book.points?.[date];
        if (Number.isFinite(v)) {
          value += v;
          found = true;
        }
      });
    } else {
      const v = books[key]?.points?.[date];
      if (Number.isFinite(v)) {
        value = v;
        found = true;
      }
    }
    return found ? { date, value } : null;
  }).filter(Boolean);
  const title = key === TOTAL_KEY ? '全部作品合计' : (books[key]?.title || '未知作品');
  return { title, points };
}

function populateChartBooks() {
  const select = $('chartBook');
  if (!select) return;
  const previous = select.value;
  const books = state.history?.books || {};
  const ids = Object.keys(books).sort((a, b) => {
    const lastOf = (id) => {
      const points = books[id]?.points || {};
      const dates = Object.keys(points).sort();
      return dates.length ? Number(points[dates[dates.length - 1]]) : -1;
    };
    return lastOf(b) - lastOf(a);
  });
  const options = ['<option value="' + TOTAL_KEY + '">全部作品合计</option>']
    .concat(ids.map((id) => '<option value="' + escapeHtml(id) + '">' + escapeHtml(books[id]?.title || '未命名作品') + '</option>'));
  select.innerHTML = options.join('');
  if (previous && (previous === TOTAL_KEY || books[previous])) select.value = previous;
  else select.value = TOTAL_KEY;
}

function populateRevenueChartBooks() {
  const select = $('revenueChartBook');
  if (!select) return;
  const previous = select.value;
  const books = state.revenueHistory?.books || {};
  const ids = Object.keys(books).sort((a, b) => {
    const lastOf = (id) => {
      const points = books[id]?.points || {};
      const dates = Object.keys(points).sort();
      return dates.length ? Number(points[dates[dates.length - 1]]) : -1;
    };
    return lastOf(b) - lastOf(a);
  });
  const options = ['<option value="' + TOTAL_KEY + '">全部作品合计</option>']
    .concat(ids.map((id) => '<option value="' + escapeHtml(id) + '">' + escapeHtml(books[id]?.title || '未命名作品') + '</option>'));
  select.innerHTML = options.join('');
  if (previous && (previous === TOTAL_KEY || books[previous])) select.value = previous;
  else select.value = TOTAL_KEY;
}

/* ---------------- 通用折线图绘制 ---------------- */

function drawLineChart(canvas, series, opts) {
  if (!canvas) return;
  const {
    lineColor = '#2bb673',
    emptyText = '暂无数据',
    unitPrefix = '',
    isMoney = false
  } = opts || {};
  const gridColor = '#e8f2ec';
  const textColor = '#64748b';

  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(280, canvas.clientWidth || 500);
  const height = 240;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  if (series.points.length === 0) {
    ctx.fillStyle = '#94a3b8';
    ctx.font = '13px "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(emptyText, width / 2, height / 2);
    return;
  }

  const pad = { left: 56, right: 20, top: 26, bottom: 34 };
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;

  const values = series.points.map((p) => p.value);
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (min === max) { min -= 1; max += 1; }
  const span = max - min;
  min -= span * 0.08;
  max += span * 0.08;

  const xOf = (i) => pad.left + (series.points.length === 1 ? plotWidth / 2 : (i / (series.points.length - 1)) * plotWidth);
  const yOf = (v) => pad.top + plotHeight - ((v - min) / (max - min)) * plotHeight;

  const formatVal = isMoney
    ? (v) => unitPrefix + roundMoney(v).toFixed(0)
    : (v) => unitPrefix + Math.round(v).toLocaleString();

  // 网格
  ctx.font = '11px "PingFang SC", "Microsoft YaHei", sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  const steps = 4;
  for (let i = 0; i <= steps; i += 1) {
    const value = min + ((max - min) * i) / steps;
    const y = yOf(value);
    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(width - pad.right, y);
    ctx.stroke();
    ctx.fillStyle = textColor;
    ctx.fillText(formatVal(value), pad.left - 6, y);
  }

  // X 轴标签
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const labelCount = Math.min(6, series.points.length);
  for (let i = 0; i < labelCount; i += 1) {
    const index = labelCount === 1 ? 0 : Math.round((i * (series.points.length - 1)) / (labelCount - 1));
    ctx.fillStyle = textColor;
    ctx.fillText(formatShortDate(series.points[index].date), xOf(index), height - pad.bottom + 10);
  }

  if (series.points.length === 1) {
    const p = series.points[0];
    ctx.beginPath();
    ctx.arc(xOf(0), yOf(p.value), 4, 0, Math.PI * 2);
    ctx.fillStyle = lineColor;
    ctx.fill();
    ctx.fillStyle = '#172033';
    ctx.font = 'bold 12px "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(formatVal(p.value), xOf(0), yOf(p.value) - 8);
  } else {
    // 面积
    const gradient = ctx.createLinearGradient(0, pad.top, 0, pad.top + plotHeight);
    gradient.addColorStop(0, lineColor + '40');
    gradient.addColorStop(1, lineColor + '00');
    ctx.beginPath();
    ctx.moveTo(xOf(0), pad.top + plotHeight);
    series.points.forEach((p, i) => ctx.lineTo(xOf(i), yOf(p.value)));
    ctx.lineTo(xOf(series.points.length - 1), pad.top + plotHeight);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();

    // 折线
    ctx.beginPath();
    series.points.forEach((p, i) => {
      if (i === 0) ctx.moveTo(xOf(i), yOf(p.value));
      else ctx.lineTo(xOf(i), yOf(p.value));
    });
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 2.5;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();

    // 数据点
    series.points.forEach((p, i) => {
      ctx.beginPath();
      ctx.arc(xOf(i), yOf(p.value), 3, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.strokeStyle = lineColor;
      ctx.lineWidth = 2;
      ctx.stroke();
    });

    // 最后点标签
    const last = series.points[series.points.length - 1];
    ctx.fillStyle = '#172033';
    ctx.font = 'bold 12px "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillText(formatVal(last.value), xOf(series.points.length - 1) + 4, yOf(last.value) - 6);
  }
}

function drawChart() {
  const canvas = $('readerChart');
  const hint = $('chartHint');
  const key = $('chartBook')?.value || TOTAL_KEY;
  const series = getSeries(key);
  drawLineChart(canvas, series, { lineColor: '#2bb673', emptyText: '暂无在读人数记录，请先执行一次统计' });

  if (hint) {
    if (series.points.length === 0) {
      hint.textContent = '每次"加载作品列表"或"一键获取收益"都会记录当天各作品的在读人数。连续多天统计后即可生成曲线。';
    } else {
      const base = '当前曲线：' + series.title + '（' + series.points.length + ' 天数据）。';
      const extra = series.points.length >= 2
        ? '数据按蛙蛙官方更新时间 14:30 归属日期，逐日累积形成曲线。'
        : '只有 1 天数据，明天 14:30 之后再统计一次即可看到变化趋势。';
      hint.textContent = base + extra;
    }
  }
}

function drawRevenueChart() {
  const canvas = $('revenueChart');
  const hint = $('revenueChartHint');
  const key = $('revenueChartBook')?.value || TOTAL_KEY;
  const series = getRevenueSeries(key);
  drawLineChart(canvas, series, { lineColor: '#f59e0b', emptyText: '暂无收益趋势记录，请多次"一键获取收益"累积数据', isMoney: true, unitPrefix: '¥' });

  if (hint) {
    if (series.points.length === 0) {
      hint.textContent = '每次"一键获取收益"都会记录当天各作品的收益快照，逐日累积形成收益趋势曲线。';
    } else {
      const base = '当前曲线：' + series.title + '（' + series.points.length + ' 天数据）。';
      const extra = series.points.length >= 2 ? '连续获取即可看到收益变化趋势。' : '明天再获取一次即可看到变化。';
      hint.textContent = base + extra;
    }
  }
}

/* ---------------- 数据备份 / 恢复 ---------------- */

function backupData() {
  const payload = {
    version: '1.2.0',
    exportDate: new Date().toISOString(),
    readerHistory: state.history,
    revenueHistory: state.revenueHistory
  };
  const json = JSON.stringify(payload, null, 2);
  const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
  downloadBlob(blob, `蛙蛙写作助手备份_${formatDate(new Date())}.json`);
  setStatus('本地数据已备份（在读人数 + 收益趋势历史）。', 'success');
}

function restoreData(file) {
  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const data = JSON.parse(e.target.result);
      if (!data || typeof data !== 'object') throw new Error('文件格式不正确');

      let restored = [];

      if (data.readerHistory && data.readerHistory.books && typeof data.readerHistory.books === 'object') {
        state.history = data.readerHistory;
        await chrome.storage.local.set({ [HISTORY_KEY]: data.readerHistory });
        const readerDays = new Set();
        Object.values(data.readerHistory.books).forEach((b) => Object.keys(b.points || {}).forEach((d) => readerDays.add(d)));
        restored.push(`在读人数 ${readerDays.size} 天`);
      }

      if (data.revenueHistory && data.revenueHistory.books && typeof data.revenueHistory.books === 'object') {
        state.revenueHistory = data.revenueHistory;
        await chrome.storage.local.set({ [REVENUE_HISTORY_KEY]: data.revenueHistory });
        const revDays = new Set();
        Object.values(data.revenueHistory.books).forEach((b) => Object.keys(b.points || {}).forEach((d) => revDays.add(d)));
        restored.push(`收益趋势 ${revDays.size} 天`);
      }

      if (!restored.length) throw new Error('备份文件中没有可恢复的数据');

      populateChartBooks();
      drawChart();
      populateRevenueChartBooks();
      drawRevenueChart();
      setStatus(`数据已恢复：${restored.join('、')}。`, 'success');
    } catch (error) {
      setStatus(`恢复数据失败：${error.message || error}`, 'error');
    }
  };
  reader.readAsText(file);
}

/* ---------------- 自动刷新提醒 ---------------- */

function checkRefreshReminder() {
  const now = new Date();
  const todayCutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate(), DAILY_UPDATE_HOUR, DAILY_UPDATE_MINUTE, 0, 0);

  if (now < todayCutoff) return;

  const snapshotDate = getSnapshotDate();
  const revBooks = state.revenueHistory?.books || {};
  const hasTodayData = Object.values(revBooks).some((book) => book.points?.[snapshotDate] !== undefined);

  if (!hasTodayData && state.rows.length > 0) {
    showReminder();
  }
}

function showReminder() {
  const el = $('refreshReminder');
  if (el) el.style.display = '';
}

function hideReminder() {
  const el = $('refreshReminder');
  if (el) el.style.display = 'none';
}

function initReminder() {
  const closeBtn = $('reminderClose');
  const fetchBtn = $('reminderFetch');
  if (closeBtn) closeBtn.addEventListener('click', hideReminder);
  if (fetchBtn) fetchBtn.addEventListener('click', () => {
    hideReminder();
    fetchRevenue();
  });
}

/* ---------------- Excel 导出 ---------------- */

function excelCell(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildDailyReaderRows() {
  const books = state.history?.books || {};
  const dateSet = new Set();
  Object.values(books).forEach((book) => {
    Object.keys(book.points || {}).forEach((date) => dateSet.add(date));
  });
  const dates = [...dateSet].sort();
  if (!dates.length) return [];

  const rows = [];
  dates.forEach((date, index) => {
    let total = 0;
    let found = false;
    Object.values(books).forEach((book) => {
      const v = book.points?.[date];
      if (Number.isFinite(v)) { total += v; found = true; }
    });
    if (!found) return;
    const previousValue = index > 0 ? sumAt(books, dates[index - 1]) : null;
    const diff = previousValue === null ? '—' : formatSignedNumber(total - previousValue);
    rows.push([date, '全部作品合计', total, diff]);
  });
  Object.keys(books).sort((a, b) => String(books[a]?.title || '').localeCompare(String(books[b]?.title || ''), 'zh-CN')).forEach((id) => {
    const book = books[id];
    const points = book.points || {};
    const bookDates = Object.keys(points).sort();
    bookDates.forEach((date, index) => {
      const value = Number(points[date]);
      if (!Number.isFinite(value)) return;
      const previousValue = index > 0 ? Number(points[bookDates[index - 1]]) : NaN;
      const diff = index > 0 && Number.isFinite(previousValue) ? formatSignedNumber(value - previousValue) : '—';
      rows.push([date, book.title || '未命名作品', value, diff]);
    });
  });
  return rows;
}

function sumAt(books, date) {
  let total = 0;
  let found = false;
  Object.values(books).forEach((book) => {
    const v = book.points?.[date];
    if (Number.isFinite(v)) { total += v; found = true; }
  });
  return found ? total : null;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function exportExcel() {
  const rows = state.rows;
  if (!rows.length) {
    setStatus('没有可导出的收益数据，请先"加载作品列表"或"一键获取收益"。', 'warning');
    return;
  }

  const exportDate = formatDate(new Date());
  const headers = ['书名', '笔名', '状态', '总字数', '历史总收益', '昨日收益', '最新收益', '收益趋势', '在读人数', '在读变化', '导出日期'];
  const bodyRows = rows.map((row) => {
    const item = row.item || {};
    return [
      item.title || '未命名作品',
      item.pen_name || '—',
      getStatusText(item),
      Number.isFinite(Number(item.total_word_count)) ? Number(item.total_word_count) : '—',
      row.hasRevenue ? formatMoney(getTotalRevenue(row)) : '—',
      moneyText(getYesterdayRevenue(row)),
      moneyText(getLatestRevenue(row)),
      getTrend(row).text,
      getReaders(row),
      getReadersChange(row).text,
      exportDate
    ];
  });

  const dailyReaderRows = buildDailyReaderRows();
  const dailyReaderTable = dailyReaderRows.length ? [
    '<br/><h3>每日在读人数统计</h3>',
    '<table border="1">',
    '<thead><tr><th>日期</th><th>作品</th><th>在读人数</th><th>较前一日变化</th></tr></thead>',
    '<tbody>',
    dailyReaderRows.map((line) => '<tr>' + line.map((cell, index) => '<td' + (index === 2 ? ' class="num"' : '') + '>' + excelCell(cell) + '</td>').join('') + '</tr>').join(''),
    '</tbody></table>'
  ].join('') : '';

  const tableHtml = [
    '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">',
    '<head><meta charset="UTF-8"><style>td{mso-number-format:"\\@";} .num{mso-number-format:"0.00";}</style></head>',
    '<body><table border="1">',
    '<thead><tr>' + headers.map((item) => '<th>' + excelCell(item) + '</th>').join('') + '</tr></thead>',
    '<tbody>',
    bodyRows.map((line) => '<tr>' + line.map((cell, index) => '<td' + (index >= 4 && index <= 6 ? ' class="num"' : '') + '>' + excelCell(cell) + '</td>').join('') + '</tr>').join(''),
    '</tbody></table>',
    dailyReaderTable,
    '</body></html>'
  ].join('');

  const blob = new Blob(['\ufeff' + tableHtml], { type: 'application/vnd.ms-excel;charset=utf-8' });
  downloadBlob(blob, `蛙蛙写作收益统计_${exportDate}.xls`);

  const chartExported = exportChart(true);
  if (chartExported) {
    setStatus('Excel（含每日在读人数明细）与在读人数曲线图已导出。', 'success');
  } else {
    setStatus('Excel 已导出（含每日在读人数明细）。在读人数曲线需要至少 2 天快照，明天统计一次后即可导出曲线图。', 'success');
  }
}

function exportChart(silent) {
  const key = $('chartBook')?.value || TOTAL_KEY;
  const series = getSeries(key);
  if (series.points.length < 2) {
    if (!silent) {
      setStatus('当前选中曲线只有 ' + series.points.length + ' 天数据，至少需要 2 天快照才能导出曲线图。请明天再统计一次。', 'warning');
    }
    return false;
  }
  const canvas = $('readerChart');
  if (!canvas) return false;
  try {
    const exportCanvas = document.createElement('canvas');
    const scale = canvas.width / Math.max(1, canvas.clientWidth || 800);
    const headerHeight = Math.round(86 * scale);
    exportCanvas.width = canvas.width;
    exportCanvas.height = canvas.height + headerHeight;
    const ctx = exportCanvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, exportCanvas.width, exportCanvas.height);

    ctx.fillStyle = '#172033';
    ctx.font = 'bold ' + Math.round(22 * scale) + 'px "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('每日在读人数曲线 - ' + series.title, Math.round(24 * scale), Math.round(20 * scale));
    ctx.fillStyle = '#65738a';
    ctx.font = Math.round(14 * scale) + 'px "PingFang SC", "Microsoft YaHei", sans-serif';
    const range = `${series.points[0].date} 至 ${series.points[series.points.length - 1].date}（${series.points.length} 天）`;
    ctx.fillText(range, Math.round(24 * scale), Math.round(54 * scale));

    ctx.drawImage(canvas, 0, headerHeight);

    exportCanvas.toBlob((blob) => {
      if (!blob) return;
      downloadBlob(blob, `蛙蛙写作在读人数曲线_${series.title}_${formatDate(new Date())}.png`);
    }, 'image/png');
    if (!silent) setStatus('在读人数曲线图已导出。', 'success');
    return true;
  } catch (error) {
    if (!silent) setStatus(`曲线图导出失败：${error.message || error}`, 'error');
    return false;
  }
}

/* ---------------- 初始化 ---------------- */

$('loadBooks').addEventListener('click', loadBooks);
$('fetchRevenue').addEventListener('click', fetchRevenue);
$('exportExcel').addEventListener('click', () => exportExcel());
$('exportChart').addEventListener('click', () => exportChart(false));
$('chartBook').addEventListener('change', drawChart);
$('revenueChartBook').addEventListener('change', drawRevenueChart);

$('backupData').addEventListener('click', backupData);
$('restoreData').addEventListener('click', () => $('restoreFile')?.click());
$('restoreFile').addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (file) {
    restoreData(file);
    e.target.value = '';
  }
});

window.addEventListener('resize', () => {
  drawChart();
  drawRevenueChart();
});

initSortHeaders();
initFilters();
initReminder();

(async function init() {
  await loadHistory();
  await loadRevenueHistory();
  populateChartBooks();
  drawChart();
  populateRevenueChartBooks();
  drawRevenueChart();
  checkRefreshReminder();
})();
