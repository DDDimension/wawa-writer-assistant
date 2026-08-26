/* 蛙蛙写作助手 - 功能页逻辑
 *
 * 数据来源（均为蛙蛙写作官方接口，通过已登录标签页发起，自动携带 Cookie）：
 *   1. 投稿作品列表  POST /wrhp-api/api/v1/submission/novel/my_list
 *      body: { page, page_size }  ->  { code:200, data: { items, total } }
 *      item: submission_id / base_novel_id / title / pen_name / story_type /
 *            status / contract_status / is_finished / total_word_count
 *   2. 作品收益汇总  GET /wrhp-api/api/v1/submission/novel/my_revenue
 *      -> { code:200, data: [ { base_novel_id, total_revenue,
 *           latest:{ revenue, follow_user_cnt },
 *           previous:{ revenue, available, follow_user_cnt } }, ... ] }
 *      收益数据按 base_novel_id 与列表中的作品匹配。
 *
 * 每日在读人数统计：
 *   每次「加载作品列表 / 一键获取收益」都会把当天每本作品的在读人数
 *   快照写入 chrome.storage.local（key: readerHistory），逐日累积形成曲线。
 *   结构：{ books: { [submission_id]: { title, points: { 'YYYY-MM-DD': 数值 } } } }
 */

'use strict';

const API_BASE = 'https://wawawriter.com';
const MY_LIST_PATH = '/wrhp-api/api/v1/submission/novel/my_list';
const MY_REVENUE_PATH = '/wrhp-api/api/v1/submission/novel/my_revenue';
const PAGE_SIZE = 50;
const MAX_PAGES = 60; // 最多 3000 本，防御性上限
const HISTORY_KEY = 'readerHistory';
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

const state = {
  rows: [],
  isLoading: false,
  history: { books: {} }
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

// 蛙蛙官方每天约 14:30 更新数据；在此之前统计，应归属为「前一天」数据。
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

// 通过 background 查找（或创建）一个已登录的 wawawriter.com 标签页。
async function getWawaTab(create) {
  const response = await chrome.runtime.sendMessage({ action: 'getWawaTab', create: Boolean(create) });
  if (!response?.success) throw new Error(response?.error || '无法获取蛙蛙写作标签页');
  return response.tab || null;
}

// 在 wawawriter.com 标签页内发起 fetch，返回 { code, data, message }。
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

// 分页拉取投稿作品列表（基础字段，不含收益详情）。
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
    await sleep(250); // 轻微限速，避免请求过密
  }
  return items;
}

// 拉取列表后，再调用一次 my_revenue 获取全部收益，按 base_novel_id 匹配。
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
    // 收益接口失败不影响列表展示
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

function getBookId(item) {
  const id = item?.submission_id ?? item?.id;
  return id === undefined || id === null || id === '' ? String(item?.title || '未命名作品') : String(id);
}

// 把各作品的在读人数写入本地历史（按蛙蛙数据更新时间 14:30 归属日期，同一天多次统计只覆盖该日期数值）。
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
    // 存储失败不影响主流程，只是曲线暂时无法累积
  }
  populateChartBooks();
  drawChart();
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

// 在读人数变化：优先用官方接口的最新-昨日口径，接口缺失时回退本地快照的前一天。
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
      // 找到当前快照日期之前最近的一次快照
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

function renderRows() {
  const body = $('tableBody');
  if (!body) return;

  if (!state.rows.length) {
    body.innerHTML = '<tr><td colspan="10" class="empty">暂无数据</td></tr>';
    renderSummary();
    return;
  }

  body.innerHTML = state.rows.map((row) => {
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

function drawChart() {
  const canvas = $('readerChart');
  if (!canvas) return;
  const hint = $('chartHint');
  const key = $('chartBook')?.value || TOTAL_KEY;
  const series = getSeries(key);

  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(320, canvas.clientWidth || 800);
  const height = 260;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const textColor = '#64748b';
  const lineColor = '#2bb673';
  const gridColor = '#e8f2ec';

  if (series.points.length === 0) {
    ctx.fillStyle = '#94a3b8';
    ctx.font = '14px "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('暂无在读人数记录，请先执行一次统计', width / 2, height / 2);
    if (hint) hint.textContent = '每次“加载作品列表”或“一键获取收益”都会记录当天各作品的在读人数（数据保存在本地浏览器中，不上传任何服务器）。连续多天统计后即可生成在读人数变化曲线。';
    return;
  }

  const pad = { left: 58, right: 24, top: 30, bottom: 36 };
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;

  const values = series.points.map((p) => p.value);
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (min === max) { min -= 1; max += 1; }
  const span = max - min;
  min -= span * 0.08;
  max += span * 0.08;

  const xOf = (index) => pad.left + (series.points.length === 1 ? plotWidth / 2 : (index / (series.points.length - 1)) * plotWidth);
  const yOf = (value) => pad.top + plotHeight - ((value - min) / (max - min)) * plotHeight;

  // 网格与 Y 轴刻度
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
    ctx.fillText(Math.round(value).toLocaleString(), pad.left - 8, y);
  }

  // X 轴日期标签（最多 6 个，均匀抽取）
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const labelCount = Math.min(6, series.points.length);
  for (let i = 0; i < labelCount; i += 1) {
    const index = labelCount === 1 ? 0 : Math.round((i * (series.points.length - 1)) / (labelCount - 1));
    ctx.fillStyle = textColor;
    ctx.fillText(formatShortDate(series.points[index].date), xOf(index), height - pad.bottom + 10);
  }

  if (series.points.length === 1) {
    // 单点：画一个点 + 数值
    const p = series.points[0];
    ctx.beginPath();
    ctx.arc(xOf(0), yOf(p.value), 4, 0, Math.PI * 2);
    ctx.fillStyle = lineColor;
    ctx.fill();
    ctx.fillStyle = '#172033';
    ctx.font = 'bold 13px "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(p.value.toLocaleString(), xOf(0), yOf(p.value) - 10);
  } else {
    // 面积填充
    const gradient = ctx.createLinearGradient(0, pad.top, 0, pad.top + plotHeight);
    gradient.addColorStop(0, 'rgba(63, 215, 129, 0.25)');
    gradient.addColorStop(1, 'rgba(63, 215, 129, 0)');
    ctx.beginPath();
    ctx.moveTo(xOf(0), pad.top + plotHeight);
    series.points.forEach((p, index) => ctx.lineTo(xOf(index), yOf(p.value)));
    ctx.lineTo(xOf(series.points.length - 1), pad.top + plotHeight);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();

    // 折线
    ctx.beginPath();
    series.points.forEach((p, index) => {
      const x = xOf(index);
      const y = yOf(p.value);
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 2.5;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();

    // 数据点
    series.points.forEach((p, index) => {
      ctx.beginPath();
      ctx.arc(xOf(index), yOf(p.value), 3.5, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.strokeStyle = lineColor;
      ctx.lineWidth = 2;
      ctx.stroke();
    });

    // 最后一个点的数值标签
    const last = series.points[series.points.length - 1];
    ctx.fillStyle = '#172033';
    ctx.font = 'bold 13px "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillText(last.value.toLocaleString(), xOf(series.points.length - 1) + 6, yOf(last.value) - 8);
  }

  if (hint) {
    const base = '当前曲线：' + series.title + '（' + series.points.length + ' 天数据）。';
    const extra = series.points.length >= 2
      ? '数据按蛙蛙官方更新时间 14:30 归属日期，逐日累积形成曲线。'
      : '只有 1 天数据，明天 14:30 之后再统计一次即可看到变化趋势。';
    hint.textContent = base + extra;
  }
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
  // 合计行
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
  // 每本书的明细
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
    setStatus('没有可导出的收益数据，请先“加载作品列表”或“一键获取收益”。', 'warning');
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

  // 同时导出在读人数曲线 PNG（数据不足 2 天时跳过）
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
    const scale = canvas.width / Math.max(1, canvas.clientWidth || 800); // canvas 内部像素已是 dpr 缩放
    const headerHeight = Math.round(86 * scale);
    exportCanvas.width = canvas.width;
    exportCanvas.height = canvas.height + headerHeight;
    const ctx = exportCanvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, exportCanvas.width, exportCanvas.height);

    // 标题
    ctx.fillStyle = '#172033';
    ctx.font = 'bold ' + Math.round(22 * scale) + 'px "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('每日在读人数曲线 - ' + series.title, Math.round(24 * scale), Math.round(20 * scale));
    ctx.fillStyle = '#65738a';
    ctx.font = Math.round(14 * scale) + 'px "PingFang SC", "Microsoft YaHei", sans-serif';
    const range = `${series.points[0].date} 至 ${series.points[series.points.length - 1].date}（${series.points.length} 天）`;
    ctx.fillText(range, Math.round(24 * scale), Math.round(54 * scale));

    // 曲线本体绘制在标题下方
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
window.addEventListener('resize', drawChart);

(async function init() {
  await loadHistory();
  populateChartBooks();
  drawChart();
})();
