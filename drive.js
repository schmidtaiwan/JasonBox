"use strict";

const drive = (() => {
  const folder = "application/vnd.google-apps.folder";
  const filesUrl = "https://www.googleapis.com/drive/v3/files";
  const uploadUrl = "https://www.googleapis.com/upload/drive/v3/files";
  const fields = "id,name,mimeType,parents,appProperties,createdTime,modifiedTime";
  const itemFilter = "appProperties has { key='jasonBoxItem' and value='1' }";
  let token;
  let expiresAt;
  let root;
  let accountInfo;

  class SessionExpired extends Error {}

  async function request(url, options = {}) {
    if (!token || Date.now() >= expiresAt) throw new SessionExpired("登入已逾時，請重新登入。");
    const headers = new Headers(options.headers);
    headers.set("Authorization", "Bearer " + token);
    const response = await fetch(url, { ...options, headers, cache: "no-store" });
    if (response.status === 401) throw new SessionExpired("登入已逾時，請重新登入。");
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error?.message || "Google Drive 請求失敗（" + response.status + "）。");
    }
    return response;
  }

  function logout() {
    token = undefined;
    expiresAt = undefined;
    root = undefined;
    accountInfo = undefined;
  }

  async function login(config) {
    const oauth = window.google?.accounts?.oauth2;
    if (!oauth) throw new Error("Google 登入元件尚未載入，請稍後再試。");
    const scope = "https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/userinfo.email";
    const result = await new Promise((resolve, reject) => {
      const client = oauth.initTokenClient({
        client_id: config.clientId,
        scope,
        hint: config.owner,
        callback: response => response.error ? reject(new Error("Google 登入未完成。")) : resolve(response),
        error_callback: () => reject(new Error("Google 登入視窗未完成，請重試。"))
      });
      client.requestAccessToken({ prompt: "select_account" });
    });
    try {
      token = result.access_token;
      expiresAt = Date.now() + Number(result.expires_in) * 1000;
      const response = await request("https://www.googleapis.com/oauth2/v2/userinfo");
      const account = await response.json();
      if (account.email?.toLowerCase() !== config.owner || account.verified_email !== true) {
        throw new Error("請用 " + config.owner + " 登入。");
      }
      accountInfo = account;
      if (!oauth.hasGrantedAllScopes(result, ...scope.split(" "))) {
        throw new Error("請允許 Google Drive 存取權限後重新登入。");
      }
      if (!account.picture || !account.name) {
        try {
          const details = await (await request("https://www.googleapis.com/drive/v3/about?fields=user(displayName,photoLink)")).json();
          account.picture ||= details.user?.photoLink;
          account.name ||= details.user?.displayName;
        } catch (error) {
          if (error instanceof SessionExpired) throw error;
        }
      }
      const roots = await list("'root' in parents and 'me' in owners and name='JasonBox' and mimeType='" + folder + "'");
      roots.sort((a, b) => a.createdTime.localeCompare(b.createdTime));
      const selected = roots[0] ?? await write({ name: "JasonBox", mimeType: folder, parents: ["root"] });
      root = selected.id;
    } catch (error) {
      logout();
      throw error;
    }
  }

  async function list(query) {
    const results = [];
    const params = new URLSearchParams({ q: "trashed=false and (" + query + ")", fields: "nextPageToken,files(" + fields + ")", pageSize: "1000", spaces: "drive" });
    do {
      const response = await request(filesUrl + "?" + params);
      const data = await response.json();
      results.push(...(data.files ?? []));
      if (!data.nextPageToken) break;
      params.set("pageToken", data.nextPageToken);
    } while (true);
    return results;
  }

  function entryFromFile(file, level) {
    if (file.appProperties?.jasonBoxItem === "1") level = 4;
    const hasPhoto = file.mimeType === "image/jpeg";
    return {
      id: file.id,
      name: level === 4 ? file.name.replace(/\.(jpg|json)$/, "") : file.name,
      parent: file.parents[0] === root ? null : file.parents[0],
      level,
      hasPhoto,
      createdAt: file.createdTime,
      updatedAt: file.appProperties?.updatedAt || file.modifiedTime,
      x: file.appProperties?.x === undefined ? undefined : Number(file.appProperties.x),
      y: file.appProperties?.y === undefined ? undefined : Number(file.appProperties.y),
      scale: Number(file.appProperties?.scale) || 1
    };
  }

  async function readEntries() {
    let parents = [root];
    const entries = [];
    for (let level = 0; level < 5 && parents.length; level++) {
      const next = [];
      for (let offset = 0; offset < parents.length; offset += 30) {
        const group = parents.slice(offset, offset + 30);
        const within = group.map(id => "'" + id + "' in parents").join(" or ");
        const kind = "(mimeType='" + folder + "' or " + itemFilter + ")";
        const children = await list("(" + within + ") and " + kind);
        for (const child of children) {
          entries.push(entryFromFile(child, level));
          if (child.mimeType === folder) next.push(child.id);
        }
      }
      parents = next;
    }
    return entries.sort((a, b) => a.name.localeCompare(b.name, "zh-Hant", { numeric: true }));
  }

  async function write(metadata, id, content, contentType) {
    const path = id ? "/" + encodeURIComponent(id) : "";
    const options = { method: id ? "PATCH" : "POST" };
    let url = filesUrl + path + "?fields=" + encodeURIComponent(fields);
    if (content) {
      const boundary = "jasonbox-" + crypto.randomUUID();
      url = uploadUrl + path + "?uploadType=multipart&fields=" + encodeURIComponent(fields);
      options.headers = { "Content-Type": "multipart/related; boundary=" + boundary };
      options.body = new Blob([
        "--" + boundary + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n",
        JSON.stringify(metadata),
        "\r\n--" + boundary + "\r\nContent-Type: " + contentType + "\r\n\r\n",
        content,
        "\r\n--" + boundary + "--\r\n"
      ]);
    } else {
      options.headers = { "Content-Type": "application/json" };
      options.body = JSON.stringify(metadata);
    }
    return (await request(url, options)).json();
  }

  async function save(record) {
    const { id, name, parent, level, photo, hasPhoto, photoRemoved } = record;
    const metadata = { name, appProperties: { updatedAt: new Date().toISOString() } };
    if (Number.isFinite(record.x) && Number.isFinite(record.y)) {
      metadata.appProperties.x = String(record.x);
      metadata.appProperties.y = String(record.y);
      metadata.appProperties.scale = String(Math.min(2.5, Math.max(.5, Number(record.scale) || 1)));
    }
    if (!id) {
      const parentId = parent ?? root;
      const parentInfo = await request(filesUrl + "/" + encodeURIComponent(parentId) + "?fields=trashed,mimeType");
      const data = await parentInfo.json();
      if (data.trashed || data.mimeType !== folder) throw new Error("原收納位置已不存在。");
      metadata.parents = [parentId];
    }
    if (level < 4) {
      if (!id) metadata.mimeType = folder;
      return entryFromFile(await write(metadata, id), level);
    }
    const jpeg = Boolean(photo || (hasPhoto && !photoRemoved));
    metadata.name += jpeg ? ".jpg" : ".json";
    metadata.appProperties.jasonBoxItem = "1";
    const type = jpeg ? "image/jpeg" : "application/json";
    const content = photo || ((!id || photoRemoved) ? new Blob(["{}"], { type }) : undefined);
    if (content) metadata.mimeType = type;
    return entryFromFile(await write(metadata, id, content, type), level);
  }

  async function remove(entry) {
    if (entry.level < 4 && (await list("'" + entry.id + "' in parents")).length) {
      throw new Error("請先清空這個 Google Drive 資料夾，再刪除。");
    }
    await write({ trashed: true }, entry.id);
  }

  async function photo(id) {
    const response = await request(filesUrl + "/" + encodeURIComponent(id) + "?alt=media");
    return response.blob();
  }

  async function touch(entry) {
    return entryFromFile(await write({ appProperties: { updatedAt: new Date().toISOString() } }, entry.id), entry.level);
  }

  async function quota() {
    const response = await request("https://www.googleapis.com/drive/v3/about?fields=storageQuota");
    const data = await response.json();
    if (!data.storageQuota) throw new Error("無法取得雲端硬碟容量。");
    return data.storageQuota;
  }

  return { login, logout, readEntries, save, remove, photo, touch, quota, account: () => accountInfo, SessionExpired };
})();
