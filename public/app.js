/**
 * app.js —— 云聊前端逻辑
 * 同一 Worker 同时托管静态页面与后端 API/WS，因此 API 与 WS 均使用当前来源。
 */
(() => {
  const $ = (id) => document.getElementById(id);

  const lobby = $("lobby");
  const chat = $("chat");
  const errEl = $("lobby-error");
  const messagesEl = $("messages");
  const nicknameEl = $("nickname");
  const roomCodeEl = $("room-code");
  const roomNameEl = $("room-name");
  const roomSearchEl = $("room-search");
  const roomListEl = $("room-list");
  const roomListItemsEl = $("room-list-items");
  const roomListEmptyEl = $("room-list-empty");
  const btnJoin = $("btn-join");
  const btnCreate = $("btn-create");
  const btnDefault = $("btn-default");
  const btnSend = $("btn-send");
  const btnLeave = $("btn-leave");
  const btnEditNick = $("btn-edit-nick");
  const btnEditRoom = $("btn-edit-room");
  const btnAdmin = $("btn-admin");
  const chatInput = $("chat-input");

  let ws = null;
  let myNickname = "";
  let currentRoom = null;
  let reconnectTimer = null; // 重连定时器句柄
  let isAdmin = false; // 是否处于管理员模式
  let adminPassword = ""; // 管理密码（仅保存在内存，不持久化）

  // ---------- 会话持久化（localStorage） ----------
  const STORE_KEY = "cloud-chat-session";
  function saveSession() {
    if (!myNickname || !currentRoom) return;
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify({ nickname: myNickname, room: currentRoom })
    );
  }
  function loadSession() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }
  function clearSession() {
    localStorage.removeItem(STORE_KEY);
  }

  // ---------- 工具 ----------
  function setError(msg) {
    errEl.textContent = msg || "";
  }

  function toggleScreen(toLobby) {
    lobby.classList.toggle("hidden", !toLobby);
    chat.classList.toggle("hidden", toLobby);
  }

  function cleanCode(v) {
    return v.toUpperCase().replace(/[^A-Z0-9]/g, "");
  }

  // 判断昵称是否被禁止：不能为"游客"/"Guest"或包含这些字样
  function isForbiddenName(name) {
    return (name || "").toLowerCase().includes("游客") || (name || "").toLowerCase().includes("guest");
  }

  function urlBase() {
    // 页面由同一 Worker 提供，直接使用当前来源
    return `${location.protocol}//${location.host}`;
  }

  async function api(path, options = {}) {
    const res = await fetch(`${urlBase()}${path}`, options);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || `请求失败 (${res.status})`);
    }
    return data;
  }

  // ---------- 标签切换 ----------
  $("tab-join").addEventListener("click", () => switchTab("join"));
  $("tab-create").addEventListener("click", () => switchTab("create"));

  function switchTab(which) {
    $("tab-join").classList.toggle("active", which === "join");
    $("tab-create").classList.toggle("active", which === "create");
    $("panel-join").classList.toggle("hidden", which !== "join");
    $("panel-create").classList.toggle("hidden", which !== "create");
    setError();
  }

  // ---------- 创建房间 ----------
  btnCreate.addEventListener("click", async () => {
    const name = roomNameEl.value.trim();
    if (!name) return setError("请输入房间名称");
    btnCreate.disabled = true;
    setError();
    try {
      const room = await api("/api/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      enterRoom(room);
    } catch (e) {
      setError(e.message);
    } finally {
      btnCreate.disabled = false;
    }
  });

  // ---------- 加入房间 ----------
  btnJoin.addEventListener("click", async () => {
    const code = cleanCode(roomCodeEl.value);
    if (!code) return setError("请输入房间号");
    // 直接读取输入框当前的昵称（不能用全局变量，因为那是内存状态，跨页面不共享）
    const name = nicknameEl.value.trim();
    if (!name) return setError("请先输入昵称");
    if (isForbiddenName(name)) return setError("昵称不能为游客/Guest 或包含该字样");
    myNickname = name;
    setError();
    btnJoin.disabled = true;
    try {
      // 先查询房间信息，用于显示房间名/房间号，并校验房间是否存在
      const room = await api(`/api/rooms/${code}`);
      enterRoom(room);
    } catch (e) {
      setError(e.message);
    } finally {
      btnJoin.disabled = false;
    }
  });

  // ---------- 进入默认房间 Yanverse ----------
  btnDefault.addEventListener("click", async () => {
    const name = nicknameEl.value.trim();
    if (!name) return setError("请先输入昵称");
    if (isForbiddenName(name)) return setError("昵称不能为游客/Guest 或包含该字样");
    myNickname = name;
    setError();
    btnDefault.disabled = true;
    try {
      const defRoom = await api("/api/rooms/default");
      enterRoom(defRoom);
    } catch (e) {
      setError(e.message);
    } finally {
      btnDefault.disabled = false;
    }
  });

  // ---------- 搜索在线房间 ----------
  let searchTimer = null;
  async function searchRooms() {
    const q = roomSearchEl.value.trim();
    try {
      const path = q ? `/api/rooms/search?q=${encodeURIComponent(q)}` : "/api/rooms";
      const data = await api(path);
      renderRooms(data.rooms || []);
    } catch (e) {
      renderRooms([]);
    }
  }

  function renderRooms(rooms) {
    roomListEl.classList.remove("hidden");
    roomListItemsEl.innerHTML = "";
    roomListEmptyEl.style.display = rooms.length ? "none" : "block";
    rooms.forEach((r) => {
      const item = document.createElement("div");
      item.className = "room-item";
      const meta = `${r.onlineCount} 人在线 · ${formatRelative(r.lastActiveAt)}`;
      item.innerHTML =
        `<span class="room-item-name"></span>` +
        `<span class="room-item-meta">${escapeHtml(meta)}</span>`;
      item.querySelector(".room-item-name").textContent = r.name;
      item.title = `${r.name}（房间号 ${r.code}）`;
      item.addEventListener("click", () => enterRoom(r));
      roomListItemsEl.appendChild(item);
    });
  }

  function formatRelative(ts) {
    const diff = Date.now() - ts;
    const min = Math.floor(diff / 60000);
    if (min < 1) return "刚刚活跃";
    if (min < 60) return `${min} 分钟前活跃`;
    return `${Math.floor(min / 60)} 小时前活跃`;
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  roomSearchEl.addEventListener("input", () => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(searchRooms, 250);
  });
  roomSearchEl.addEventListener("focus", () => {
    if (searchTimer) clearTimeout(searchTimer);
    searchRooms();
  });
  // 页面加载时加载一次在线房间列表
  searchRooms();

  // ---------- 进入聊天 ----------
  function enterRoom(room) {
    currentRoom = room;
    $("chat-room-name").textContent = room.name;
    $("chat-room-code").textContent = "房间号 " + room.code;
    // 默认房间不可修改名称，隐藏"改房名"按钮
    const isDefault = room.code.toUpperCase() === "YAN812";
    btnEditRoom.style.display = isDefault ? "none" : "";
    saveSession();
    connect(room.code);
  }

  function connect(code) {
    const name = nicknameEl.value.trim();
    if (!name) return setError("请输入昵称");
    if (isForbiddenName(name)) {
      // 兜底：禁止昵称不允许连接，回退到随机 UUID
      const uuid = randomNickname();
      myNickname = uuid;
      nicknameEl.value = uuid;
    } else {
      myNickname = name;
    }

    const wsUrl =
      `${(location.protocol === "https:" ? "wss" : "ws")}://${location.host}/ws` +
      `?room=${encodeURIComponent(code)}&name=${encodeURIComponent(name)}`;

    const btnState = (dis) => {
      btnSend.disabled = dis;
      chatInput.disabled = dis;
      if (dis) chatInput.placeholder = "连接中…";
    };
    btnState(true);

    setError();
    toggleScreen(false);
    messagesEl.innerHTML = "";
    chatInput.value = "";

    // 清理可能存在的旧连接，避免其 onclose 再次触发重连
    if (ws) {
      try { ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null; ws.close(); } catch {}
      ws = null;
    }

    let wsEverOpened = false;
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      wsEverOpened = true;
      btnState(false);
      chatInput.placeholder = "输入消息，回车发送…";
      chatInput.focus();
      showNotice();
    };

    ws.onmessage = (e) => {
      let data;
      try { data = JSON.parse(e.data); } catch { return; }
      handleServerMessage(data);
    };

    ws.onclose = () => {
      btnState(true);
      if (wsEverOpened) {
        // 曾经成功连接，属于连接中断，走自动重连
        scheduleReconnect();
      } else {
        // 从未连上（如房间已关闭/不存在），查询房间状态后决定是否重试
        handleJoinFailure(code);
      }
    };

    ws.onerror = () => {
      // 错误后由 onclose 统一处理
      try { ws.close(); } catch {}
    };
  }

  // ---------- 自动重连 ----------
  function scheduleReconnect() {
    if (!currentRoom) return;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    addSystemMsg("连接已断开，正在重新连接…");
    reconnectTimer = setTimeout(() => {
      if (currentRoom) connect(currentRoom.code);
    }, 2000);
  }

  // 停止自动重连
  function stopReconnect() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  // 连接阶段失败（WebSocket 升级被拒，如房间已关闭/不存在）时的处理
  async function handleJoinFailure(code) {
    try {
      const res = await fetch(`/api/rooms/${code}`);
      if (res.ok) {
        const info = await res.json();
        if (info.closed) {
          stopReconnect();
          addSystemMsg("🔒 房间已关闭，无法进入。如需开放，请点击右上角 ⚙ 以管理员身份登录后开放房间。");
          setStatus("房间已关闭", true);
          return;
        }
      } else if (res.status === 404) {
        stopReconnect();
        addSystemMsg("⚠️ 房间不存在");
        setStatus("房间不存在", true);
        return;
      }
    } catch {}
    // 其他情况（网络抖动等）仍走自动重连
    scheduleReconnect();
  }

  // ---------- 服务端消息处理 ----------
  function handleServerMessage(data) {
    if (data.type === "history") {
      messagesEl.innerHTML = "";
      if (data.messages.length > 0) {
        addHistoryDivider(`—— 聊天记录（${data.messages.length} 条）——`);
        data.messages.forEach((m) => (m.type === "system" ? addSystemMsg(m.text) : addMessage(m)));
      } else {
        addSystemMsg("房间还没有消息，快来发第一条吧！");
      }
      scrollBottom();
    } else if (data.type === "message") {
      addMessage(data);
    } else if (data.type === "system") {
      addSystemMsg(data.text);
    } else if (data.type === "users") {
      $("online-count").textContent = `${data.count} 人在线`;
    } else if (data.type === "adminDelete") {
      // 管理员删除了若干条消息，按 id 移除本地节点
      const ids = new Set((data.ids || []).map(String));
      removeMessageEls((el) => ids.has(el.dataset.msgId));
    } else if (data.type === "adminDeleteUser") {
      // 管理员删除了某用户的全部消息，按 user 移除本地节点
      removeMessageEls((el) => el.dataset.user === data.user);
    } else if (data.type === "renamed") {
      // 服务端确认昵称修改结果；若带 error 说明昵称被拒绝
      if (data.error) {
        showToast(data.error || "昵称不可使用");
        return;
      }
      myNickname = data.name;
      saveSession();
      showToast(`昵称已修改为「${data.name}」`);
    } else if (data.type === "roomRenamed") {
      // 房间名被修改：更新头部显示
      $("chat-room-name").textContent = data.name;
      if (currentRoom) currentRoom.name = data.name;
      saveSession();
      addSystemMsg(`房间名已改为「${data.name}」`);
      showToast(`房间名已修改为「${data.name}」`);
    } else if (data.type === "roomRenameError") {
      showToast(data.message || "无法修改房间名");
    } else if (data.type === "roomClosed") {
      // 房间被管理员关闭：停止自动重连并提示
      stopReconnect();
      btnSend.disabled = true;
      chatInput.disabled = true;
      chatInput.placeholder = "房间已关闭";
      addSystemMsg("房间已被管理员关闭");
      showToast("房间已被管理员关闭");
    } else if (data.type === "roomOpened") {
      addSystemMsg("房间已被管理员重新打开");
    } else if (data.type === "roomReset") {
      // 房间被管理员重置：停止自动重连，提示已被移出（管理员本人会随后自动重连）
      stopReconnect();
      btnSend.disabled = true;
      chatInput.disabled = true;
      chatInput.placeholder = "房间已重置";
      addSystemMsg("🧹 房间已被管理员重置，聊天记录已清空，你已被移出房间。");
      showToast("房间已被重置，你已被移出");
    }
  }

  function addMessage(m) {
    const isOwn = m.user === myNickname;
    const div = document.createElement("div");
    div.className = "msg " + (isOwn ? "own" : "other");
    if (m.id != null) div.dataset.msgId = String(m.id);
    div.dataset.user = m.user || "";
    const time = new Date(m.time).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = isOwn ? `我 · ${time}` : `${m.user} · ${time}`;
    div.appendChild(meta);
    div.appendChild(document.createTextNode(m.text));
    // 管理员模式下显示操作按钮
    if (isAdmin && m.id != null) {
      div.appendChild(makeAdminActions(m));
    }
    messagesEl.appendChild(div);
    scrollBottom();
  }

  // 管理员操作按钮（删除单条 / 删除该用户全部消息）
  function makeAdminActions(m) {
    const wrap = document.createElement("span");
    wrap.className = "admin-actions";
    const delBtn = document.createElement("button");
    delBtn.className = "admin-btn";
    delBtn.textContent = "删除";
    delBtn.title = "删除这条消息";
    delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteMessagesByIds([m.id]);
    });
    const delUserBtn = document.createElement("button");
    delUserBtn.className = "admin-btn";
    delUserBtn.textContent = "删除TA全部";
    delUserBtn.title = `删除「${m.user}」的全部消息`;
    delUserBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteUserMessages(m.user);
    });
    wrap.appendChild(delBtn);
    wrap.appendChild(delUserBtn);
    return wrap;
  }

  // 按 id 删除单条消息
  async function deleteMessagesByIds(ids) {
    if (!currentRoom || !adminPassword) return;
    const idList = ids.filter((i) => i != null).map(Number);
    if (!idList.length) return;
    if (!confirm("确定删除这条消息吗？")) return;
    try {
      await api(`/api/admin/rooms/${currentRoom.code}/messages/delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: adminPassword, ids: idList }),
      });
    } catch (e) {
      showToast(e.message);
      exitAdminMode();
    }
  }

  // 删除某个用户的所有消息
  async function deleteUserMessages(user) {
    if (!currentRoom || !adminPassword) return;
    if (!confirm(`确定删除用户「${user}」的全部消息吗？`)) return;
    try {
      await api(`/api/admin/rooms/${currentRoom.code}/messages/delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: adminPassword, user }),
      });
    } catch (e) {
      showToast(e.message);
      exitAdminMode();
    }
  }

  // 移除本地消息节点（按 id 或按用户）
  function removeMessageEls(filter) {
    messagesEl.querySelectorAll(".msg").forEach((el) => {
      if (filter(el)) el.remove();
    });
  }

  function addSystemMsg(text) {
    const div = document.createElement("div");
    div.className = "msg system";
    div.textContent = text;
    messagesEl.appendChild(div);
    scrollBottom();
  }

  function addHistoryDivider(text) {
    const div = document.createElement("div");
    div.className = "history-divider";
    div.textContent = text;
    messagesEl.appendChild(div);
  }

  function scrollBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // ---------- Toast 提示 ----------
  let toastTimer = null;
  function showToast(msg) {
    let el = $("toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "toast";
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add("show");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 2400);
  }

  // ---------- 入房公告弹窗 ----------
  const noticeModal = $("notice-modal");
  function showNotice() {
    noticeModal.classList.remove("hidden");
  }
  function closeNotice() {
    noticeModal.classList.add("hidden");
  }
  $("notice-confirm").addEventListener("click", closeNotice);
  noticeModal.addEventListener("click", (e) => {
    if (e.target === noticeModal) closeNotice();
  });

  // ---------- 发送 ----------
  function send() {
    const text = chatInput.value.trim();
    if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ text }));
    chatInput.value = "";
    chatInput.focus();
  }

  btnSend.addEventListener("click", send);
  chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") send();
  });

  // ---------- 修改昵称 / 房间名 弹窗 ----------
  const editModal = $("edit-modal");
  const editTitle = $("edit-title");
  const editInput = $("edit-input");
  const editError = $("edit-error");
  let editMode = ""; // "nick" | "room"

  function openEdit(mode) {
    editMode = mode;
    if (mode === "nick") {
      editTitle.textContent = "修改昵称";
      editInput.maxLength = 36;
      editInput.value = myNickname;
    } else {
      editTitle.textContent = "修改房间名";
      editInput.maxLength = 30;
      editInput.value = currentRoom ? currentRoom.name : "";
    }
    editError.textContent = "";
    editModal.classList.remove("hidden");
    editInput.focus();
  }

  function closeEdit() {
    editModal.classList.add("hidden");
  }

  btnEditNick.addEventListener("click", () => openEdit("nick"));
  btnEditRoom.addEventListener("click", () => openEdit("room"));
  $("edit-cancel").addEventListener("click", closeEdit);
  editModal.addEventListener("click", (e) => {
    if (e.target === editModal) closeEdit();
  });

  async function confirmEdit() {
    const value = editInput.value.trim();
    if (!value) {
      editError.textContent = "内容不能为空";
      return;
    }
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      editError.textContent = "连接已断开，无法修改";
      return;
    }
    if (editMode === "nick") {
      if (value === myNickname) {
        editError.textContent = "昵称未改变";
        return;
      }
      if (isForbiddenName(value)) {
        editError.textContent = "昵称不能为游客/Guest 或包含该字样";
        return;
      }
      ws.send(JSON.stringify({ type: "rename", name: value }));
      closeEdit();
      addSystemMsg("正在修改昵称…");
    } else {
      ws.send(JSON.stringify({ type: "renameRoom", name: value }));
      closeEdit();
      addSystemMsg("正在修改房间名…");
    }
  }

  $("edit-confirm").addEventListener("click", confirmEdit);
  editInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") confirmEdit();
  });

  // ---------- 管理员功能 ----------
  const adminModal = $("admin-modal");
  const adminLoginView = $("admin-login-view");
  const adminPanelView = $("admin-panel-view");
  const adminPass = $("admin-pass");
  const adminError = $("admin-error");
  const adminPanelError = $("admin-panel-error");
  const adminRoomLabel = $("admin-room-label");
  const adminAnnounceInput = $("admin-announce-input");

  function openAdminModal() {
    if (isAdmin) {
      showAdminPanel();
    } else {
      showAdminLogin();
    }
    adminModal.classList.remove("hidden");
  }

  function showAdminLogin() {
    adminLoginView.classList.remove("hidden");
    adminPanelView.classList.add("hidden");
    adminError.textContent = "";
    setTimeout(() => adminPass.focus(), 50);
  }

  function showAdminPanel() {
    adminLoginView.classList.add("hidden");
    adminPanelView.classList.remove("hidden");
    adminPanelError.textContent = "";
    adminRoomLabel.textContent = currentRoom ? `${currentRoom.name}（${currentRoom.code}）` : "—";
    if (isAdmin) updateAdminButtons();
    updateRoomStatus();
    setTimeout(() => adminAnnounceInput.focus(), 50);
  }

  function closeAdminModal() {
    adminModal.classList.add("hidden");
    adminPass.value = "";
    adminError.textContent = "";
    adminPanelError.textContent = "";
  }

  async function adminLogin() {
    const pass = adminPass.value.trim();
    if (!pass) return (adminError.textContent = "请输入管理员密码");
    btnAdmin.disabled = true;
    adminError.textContent = "";
    try {
      await api("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pass }),
      });
      adminPassword = pass;
      isAdmin = true;
      showAdminPanel();
      updateAdminButtons();
      showToast("已进入管理员模式");
    } catch (e) {
      adminError.textContent = e.message;
    } finally {
      btnAdmin.disabled = false;
    }
  }

  async function publishAnnounce() {
    const text = adminAnnounceInput.value.trim();
    if (!text) return (adminPanelError.textContent = "公告内容不能为空");
    if (!currentRoom) return;
    const btn = $("admin-announce");
    btn.disabled = true;
    adminPanelError.textContent = "";
    try {
      await api(`/api/admin/rooms/${currentRoom.code}/announce`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: adminPassword, text }),
      });
      adminAnnounceInput.value = "";
      closeAdminModal();
      showToast("公告已发布");
    } catch (e) {
      adminPanelError.textContent = e.message;
      if (e.message.includes("密码")) exitAdminMode();
    } finally {
      btn.disabled = false;
    }
  }

  function exitAdminMode() {
    isAdmin = false;
    adminPassword = "";
    updateAdminButtons();
    closeAdminModal();
    // 移除所有管理员操作按钮
    messagesEl.querySelectorAll(".admin-actions").forEach((el) => el.remove());
  }

  // 查询并展示当前房间的关闭状态
  async function updateRoomStatus() {
    const statusEl = $("admin-room-status");
    const closeBtn = $("admin-close-room");
    const openBtn = $("admin-open-room");
    if (!currentRoom || !adminPassword) return;
    try {
      const info = await api(`/api/admin/rooms/${currentRoom.code}`, {
        method: "GET",
        headers: { "x-admin-password": adminPassword },
      });
      const closed = !!info.closed;
      statusEl.textContent = closed
        ? "该房间已被关闭，普通用户无法进入、无法发送消息"
        : "正常开放中";
      statusEl.classList.toggle("danger-text", closed);
      closeBtn.classList.toggle("hidden", closed);
      openBtn.classList.toggle("hidden", !closed);
    } catch (e) {
      statusEl.textContent = "—";
      if (e.message.includes("密码")) exitAdminMode();
    }
  }

  // 关闭房间（管理员）
  async function closeRoom() {
    if (!currentRoom) return;
    if (!confirm(`确定要关闭房间「${currentRoom.name}」吗？\n关闭后所有用户将被移出，且无法再进入。`)) return;
    const btn = $("admin-close-room");
    btn.disabled = true;
    adminPanelError.textContent = "";
    try {
      await api(`/api/admin/rooms/${currentRoom.code}/close`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: adminPassword }),
      });
      closeAdminModal();
      showToast("房间已关闭，所有用户已被移出");
      await updateRoomStatus();
    } catch (e) {
      adminPanelError.textContent = e.message;
      if (e.message.includes("密码")) exitAdminMode();
    } finally {
      btn.disabled = false;
    }
  }

  // 重新打开房间（管理员）
  async function openRoom() {
    if (!currentRoom) return;
    const btn = $("admin-open-room");
    btn.disabled = true;
    adminPanelError.textContent = "";
    try {
      await api(`/api/admin/rooms/${currentRoom.code}/open`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: adminPassword }),
      });
      closeAdminModal();
      showToast("房间已重新打开");
      await updateRoomStatus();
      // 房间已开放，自动重新进入
      connect(currentRoom.code);
    } catch (e) {
      adminPanelError.textContent = e.message;
      if (e.message.includes("密码")) exitAdminMode();
    } finally {
      btn.disabled = false;
    }
  }

  // 重置房间（管理员）：踢出所有在线用户并清空全部聊天记录（含系统通知）
  async function resetRoom() {
    if (!currentRoom) return;
    if (!confirm(`确定要重置房间「${currentRoom.name}」吗？\n将踢出所有在线用户，并删除全部聊天记录（含系统通知）。此操作不可撤销。`)) return;
    const btn = $("admin-reset-room");
    btn.disabled = true;
    adminPanelError.textContent = "";
    try {
      const result = await api(`/api/admin/rooms/${currentRoom.code}/reset`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: adminPassword }),
      });
      closeAdminModal();
      showToast(`房间已重置：踢出 ${result.kicked} 人，清空 ${result.cleared} 条记录`);
      await updateRoomStatus();
      // 管理员本人随后会被 roomReset 消息移出，这里主动重新进入空房间
      connect(currentRoom.code);
    } catch (e) {
      adminPanelError.textContent = e.message;
      if (e.message.includes("密码")) exitAdminMode();
    } finally {
      btn.disabled = false;
    }
  }

  // 进入/退出管理员模式时，更新消息操作按钮的显示
  function updateAdminButtons() {
    messagesEl.querySelectorAll(".msg").forEach((el) => {
      const existing = el.querySelector(".admin-actions");
      if (existing) existing.remove();
      if (isAdmin && el.dataset.msgId) {
        const user = el.dataset.user || "";
        el.appendChild(
          makeAdminActions({ id: Number(el.dataset.msgId), user })
        );
      }
    });
  }

  btnAdmin.addEventListener("click", openAdminModal);
  $("admin-cancel").addEventListener("click", closeAdminModal);
  $("admin-login").addEventListener("click", adminLogin);
  $("admin-announce").addEventListener("click", publishAnnounce);
  $("admin-close-room").addEventListener("click", closeRoom);
  $("admin-open-room").addEventListener("click", openRoom);
  $("admin-reset-room").addEventListener("click", resetRoom);
  $("admin-exit").addEventListener("click", exitAdminMode);
  adminPass.addEventListener("keydown", (e) => { if (e.key === "Enter") adminLogin(); });
  adminAnnounceInput.addEventListener("keydown", (e) => { if (e.key === "Enter") publishAnnounce(); });
  adminModal.addEventListener("click", (e) => { if (e.target === adminModal) closeAdminModal(); });

  // ---------- 退出 ----------
  btnLeave.addEventListener("click", () => {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (ws) {
      ws.onclose = null; // 阻止自动重连
      ws.close();
      ws = null;
    }
    currentRoom = null;
    myNickname = "";
    clearSession();
    // 退出时重置管理员状态
    if (isAdmin) exitAdminMode();
    else closeAdminModal();
    toggleScreen(true);
    setError();
  });

  // ---------- 回车提交 & 默认焦点 ----------
  nicknameEl.addEventListener("keydown", (e) => { if (e.key === "Enter") switchTab("join"); });
  roomCodeEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") btnJoin.click();
    // 实时清理并大写房间号输入
    setTimeout(() => { roomCodeEl.value = cleanCode(roomCodeEl.value); }, 0);
  });
  roomNameEl.addEventListener("keydown", (e) => { if (e.key === "Enter") btnCreate.click(); });

  // ---------- 随机用户名 ----------
  function randomNickname() {
    // 生成标准 UUID v4 作为默认用户名
    if (window.crypto && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    // 兜底：无 crypto.randomUUID 时用 Math.random 构造
    const hex = () => Math.floor(Math.random() * 16).toString(16);
    const s = Array.from({ length: 36 }, () => hex());
    s[8] = s[13] = s[18] = s[23] = "-";
    s[14] = "4";
    s[19] = ["8", "9", "a", "b"][Math.floor(Math.random() * 4)];
    return s.join("");
  }

  // ---------- 页面加载：显示大厅，预填随机用户名 ----------
  function autoRestore() {
    // 优先恢复上次的昵称，否则分配随机用户名（uuid 片段形式）
    const session = loadSession();
    // 上次昵称若存在且未被禁止则恢复，否则分配随机 UUID
    let nick = (session && session.nickname) || "";
    if (!nick || isForbiddenName(nick)) nick = randomNickname();
    myNickname = nick;
    nicknameEl.value = nick;
    // 停留在大厅：用户可以点击"进入默认房间"、搜索在线房间、创建房间或按房间号加入
    toggleScreen(true);
    setError();
    // 加载在线房间列表（默认展示）
    searchRooms();
  }

  nicknameEl.focus();
  autoRestore();
})();
