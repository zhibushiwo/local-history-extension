// IndexedDB 数据层：普通历史按年分库（history_2024~2040）+ 无痕单库 + meta
// ES module，页面与 Service Worker 共用
const DB_NAME = 'MyHistoryDB';
const DB_VERSION = 3; // v3：新增 history_incognito 无痕 store
export const START_YEAR = 2024;
export const END_YEAR = 2040;
const META_STORE = 'meta';
export const INCOGNITO_STORE = 'history_incognito';

let dbPromise = null;

function requiredStoreNames() {
  const names = [META_STORE];
  for (let y = START_YEAR; y <= END_YEAR; y++) {
    names.push('history_' + y);
  }
  return names;
}

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = e => {
      const db = e.target.result;

      // 删除旧的单表 store（第一版遗留），旧数据不迁移
      if (db.objectStoreNames.contains('history')) {
        db.deleteObjectStore('history');
      }

      // 创建所有需要的 store
      requiredStoreNames().forEach(name => {
        if (db.objectStoreNames.contains(name)) return;
        if (name === META_STORE) {
          db.createObjectStore(META_STORE, { keyPath: 'key' });
        } else {
          const store = db.createObjectStore(name, {
            keyPath: 'id',
            autoIncrement: true,
          });
          store.createIndex('timestamp', 'timestamp', { unique: false });
          store.createIndex('domain', 'domain', { unique: false });
          store.createIndex('url', 'url', { unique: false });
        }
      });

      // 无痕记录独立 store（单库不按年拆，数据永久保留直至手动删除）
      if (!db.objectStoreNames.contains(INCOGNITO_STORE)) {
        const inc = db.createObjectStore(INCOGNITO_STORE, {
          keyPath: 'id',
          autoIncrement: true,
        });
        inc.createIndex('timestamp', 'timestamp', { unique: false });
        inc.createIndex('domain', 'domain', { unique: false });
        inc.createIndex('url', 'url', { unique: false });
      }
    };

    req.onsuccess = () => {
      const db = req.result;
      // 其它连接请求版本升级时主动让路，避免升级被长期阻塞；下次调用 openDB 会重建连接
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => {
      console.warn('DB 升级被阻塞，请关闭其他打开此扩展的标签页后重试');
    };
  });
  return dbPromise;
}

// 本地日期 key（与 history.js 的 getDateKey 一致，勿用 UTC）
function localDateKey(d) {
  return (
    d.getFullYear() +
    '-' +
    String(d.getMonth() + 1).padStart(2, '0') +
    '-' +
    String(d.getDate()).padStart(2, '0')
  );
}

export function storeNameForTimestamp(ts) {
  let year = new Date(ts).getFullYear();
  if (year < START_YEAR) year = START_YEAR;
  if (year > END_YEAR) year = END_YEAR;
  return 'history_' + year;
}

export function storesForRange(start, end) {
  let startYear = new Date(start).getFullYear();
  let endYear = new Date(end).getFullYear();

  // 防御：无效日期（比如 MAX_SAFE_INTEGER 溢出）时用边界兜底
  if (isNaN(startYear)) startYear = START_YEAR;
  if (isNaN(endYear)) endYear = END_YEAR;

  if (startYear < START_YEAR) startYear = START_YEAR;
  if (endYear > END_YEAR) endYear = END_YEAR;
  if (startYear > endYear) return [];

  const stores = [];
  for (let y = startYear; y <= endYear; y++) {
    stores.push('history_' + y);
  }
  return stores;
}

function allHistoryStores() {
  const stores = [];
  for (let y = START_YEAR; y <= END_YEAR; y++) {
    stores.push('history_' + y);
  }
  return stores;
}

// ========== 写入 ==========

export async function addHistory(record) {
  const db = await openDB();
  const storeName = storeNameForTimestamp(record.timestamp);
  if (!db.objectStoreNames.contains(storeName)) {
    throw new Error('目标 store 不存在: ' + storeName);
  }
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const req = store.add(record);
    req.onsuccess = () => resolve({ id: req.result, storeName });
    req.onerror = () => reject(req.error);
  });
}

// 通用 patch：只合并给定字段，不动 visitCount（备注/星标等编辑用）
export async function patchRecord(storeName, id, patch) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const rec = getReq.result;
      if (!rec) return resolve(null);
      Object.keys(patch).forEach(k => {
        rec[k] = patch[k];
      });
      const putReq = store.put(rec);
      putReq.onsuccess = () => resolve(rec);
      putReq.onerror = () => reject(putReq.error);
    };
    getReq.onerror = () => reject(getReq.error);
  });
}

// 访问更新：visitCount+1 + lastVisit + 标题/图标
export async function updateRecord(storeName, id, patch) {
  const db = await openDB();
  const existing = await new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  if (!existing) return null;
  existing.visitCount = (existing.visitCount || 1) + 1;
  existing.lastVisit = patch.timestamp || Date.now();
  if (patch.title) existing.title = patch.title;
  if (patch.favicon) existing.favicon = patch.favicon;
  return patchRecord(storeName, id, existing);
}

// ========== 无痕记录（独立 store，普通查询路径不触碰） ==========

export async function addIncognitoHistory(record) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(INCOGNITO_STORE, 'readwrite');
    const req = tx.objectStore(INCOGNITO_STORE).add(record);
    req.onsuccess = () => resolve({ id: req.result, storeName: INCOGNITO_STORE });
    req.onerror = () => reject(req.error);
  });
}

export async function getIncognitoHistory(start, end) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(INCOGNITO_STORE, 'readonly');
    const req = tx
      .objectStore(INCOGNITO_STORE)
      .index('timestamp')
      .getAll(IDBKeyRange.bound(start, end));
    req.onsuccess = () => {
      const rows = req.result;
      rows.sort((a, b) => b.timestamp - a.timestamp);
      resolve(rows);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function deleteIncognitoHistory(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(INCOGNITO_STORE, 'readwrite');
    const req = tx.objectStore(INCOGNITO_STORE).delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// 批量删除无痕记录：items = [{ id }]（单库无需按年路由）
export async function deleteIncognitoRecords(items) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(INCOGNITO_STORE, 'readwrite');
    const store = tx.objectStore(INCOGNITO_STORE);
    items.forEach(it => store.delete(it.id));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function clearIncognitoHistory() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(INCOGNITO_STORE, 'readwrite');
    const req = tx.objectStore(INCOGNITO_STORE).clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// 停留时长累加：事务内读改写，避免并发丢秒数
// dayKey 缺省为结算当天（本地日期）；跨零点拆分结算时由调用方显式传入
export async function addDwellTime(storeName, id, seconds, dayKey) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const rec = getReq.result;
      if (!rec) return resolve(null);
      if (!rec.dwellByDay || typeof rec.dwellByDay !== 'object') {
        rec.dwellByDay = {};
      }
      const day = dayKey || localDateKey(new Date());
      rec.dwellByDay[day] = (rec.dwellByDay[day] || 0) + seconds;
      const putReq = store.put(rec);
      putReq.onsuccess = () => resolve(rec);
      putReq.onerror = () => reject(putReq.error);
    };
    getReq.onerror = () => reject(getReq.error);
  });
}

// ========== 查询 ==========

export async function getHistoryByRange(start, end) {
  const db = await openDB();
  const stores = storesForRange(start, end).filter(s =>
    db.objectStoreNames.contains(s),
  );
  if (stores.length === 0) return [];

  const results = await Promise.all(
    stores.map(storeName => {
      return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);
        const index = store.index('timestamp');
        const range = IDBKeyRange.bound(start, end);
        const req = index.getAll(range);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }),
  );

  const merged = results.flat();
  merged.sort((a, b) => b.timestamp - a.timestamp);
  return merged;
}

export async function getAllHistory() {
  // 用"明天"作为右边界，避免 MAX_SAFE_INTEGER 溢出
  const end = Date.now() + 86400000;
  return getHistoryByRange(0, end);
}

// 总条数：各 store count() 求和，不加载任何记录到内存
export async function countAll() {
  const db = await openDB();
  const stores = allHistoryStores().filter(s =>
    db.objectStoreNames.contains(s),
  );
  const counts = await Promise.all(
    stores.map(storeName => {
      return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const req = tx.objectStore(storeName).count();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }),
  );
  return counts.reduce((a, b) => a + b, 0);
}

// ========== 删除 ==========

export async function deleteHistory(id, timestamp) {
  const db = await openDB();
  const storeName = storeNameForTimestamp(timestamp);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const req = store.delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// 批量删除：items = [{ id, timestamp }]，按年份 store 分组，每 store 一个事务
export async function deleteRecords(items) {
  const db = await openDB();
  const byStore = {};
  for (const it of items) {
    const storeName = storeNameForTimestamp(it.timestamp);
    if (!byStore[storeName]) byStore[storeName] = [];
    byStore[storeName].push(it.id);
  }
  let deleted = 0;
  for (const [storeName, ids] of Object.entries(byStore)) {
    if (!db.objectStoreNames.contains(storeName)) continue;
    await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      ids.forEach(id => store.delete(id));
      tx.oncomplete = () => {
        deleted += ids.length;
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    });
  }
  return deleted;
}

// 检测并合并重复：同 URL 且时间差 < 2 分钟 → 合并 visitCount
// 保留最早一条作为主体，note/starred/title 空缺时从重复项补齐
export async function mergeDuplicates(windowMs) {
  const win = windowMs || 2 * 60 * 1000;
  const db = await openDB();
  const stores = allHistoryStores().filter(s =>
    db.objectStoreNames.contains(s),
  );
  let removed = 0;
  for (const storeName of stores) {
    const all = await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    if (all.length < 2) continue;

    const byUrl = new Map();
    for (const r of all) {
      if (!byUrl.has(r.url)) byUrl.set(r.url, []);
      byUrl.get(r.url).push(r);
    }

    const toDelete = [];
    const toPut = [];
    for (const group of byUrl.values()) {
      if (group.length < 2) continue;
      group.sort((a, b) => a.timestamp - b.timestamp);
      let keep = group[0];
      let changed = false;
      for (let i = 1; i < group.length; i++) {
        const cur = group[i];
        if (cur.timestamp - keep.timestamp < win) {
          keep.visitCount = (keep.visitCount || 1) + (cur.visitCount || 1);
          keep.lastVisit = Math.max(
            keep.lastVisit || keep.timestamp,
            cur.lastVisit || cur.timestamp,
          );
          if (!keep.title && cur.title) keep.title = cur.title;
          if (!keep.note && cur.note) keep.note = cur.note;
          if (!keep.starred && cur.starred) keep.starred = true;
          toDelete.push(cur.id);
          changed = true;
        } else {
          if (changed) toPut.push(keep);
          keep = cur;
          changed = false;
        }
      }
      if (changed) toPut.push(keep);
    }

    if (toDelete.length > 0) {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        toDelete.forEach(id => store.delete(id));
        toPut.forEach(rec => store.put(rec));
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      removed += toDelete.length;
    }
  }
  return removed;
}

export async function clearAllHistory() {
  const db = await openDB();
  const stores = allHistoryStores().filter(s =>
    db.objectStoreNames.contains(s),
  );
  await Promise.all(
    stores.map(storeName => {
      return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        const req = store.clear();
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    }),
  );
}

// ========== 导入 ==========

function normalizeRecord(r) {
  let domain = r.domain;
  if (!domain) {
    try {
      domain = new URL(r.url).hostname;
    } catch (e) {
      domain = '';
    }
  }
  return {
    url: String(r.url),
    title: r.title ? String(r.title) : String(r.url),
    domain: domain,
    timestamp: Number(r.timestamp),
    favicon: r.favicon || '',
    note: r.note ? String(r.note) : '',
    starred: Boolean(r.starred),
    ...(r.dwellByDay && typeof r.dwellByDay === 'object'
      ? { dwellByDay: r.dwellByDay }
      : {}),
    visitCount: Number(r.visitCount) || 1,
    lastVisit: Number(r.lastVisit) || Number(r.timestamp),
  };
}

export async function importRecords(records) {
  const db = await openDB();
  const result = { imported: 0, skipped: 0, invalid: 0 };

  const byStore = {};
  for (const raw of records) {
    if (!raw || !raw.url || !raw.timestamp) {
      result.invalid++;
      continue;
    }
    const rec = normalizeRecord(raw);
    const storeName = storeNameForTimestamp(rec.timestamp);
    if (!byStore[storeName]) byStore[storeName] = [];
    byStore[storeName].push(rec);
  }

  for (const [storeName, recs] of Object.entries(byStore)) {
    if (!db.objectStoreNames.contains(storeName)) continue;

    const existing = await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

    const existingKeys = new Set(
      existing.map(r => r.url + '|' + Math.floor(r.timestamp / 1000)),
    );

    const toAdd = [];
    for (const rec of recs) {
      const key = rec.url + '|' + Math.floor(rec.timestamp / 1000);
      if (existingKeys.has(key)) {
        result.skipped++;
        continue;
      }
      existingKeys.add(key);
      toAdd.push(rec);
    }

    if (toAdd.length > 0) {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        toAdd.forEach(rec => store.add(rec));
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      result.imported += toAdd.length;
    }
  }

  return result;
}
