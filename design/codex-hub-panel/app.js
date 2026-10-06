(() => {
  const workspace = document.querySelector("#workspace");
  const tray = document.querySelector("#selection-tray");
  const modal = document.querySelector("#modal");
  const modalContent = document.querySelector("#modal-content");
  const toastElement = document.querySelector("#toast");
  const names = { inbox:"收件箱", sources:"来源", tasks:"待办", archive:"归档" };
  const modeNames = { feed:"信息流", list:"清单", report:"报告" };
  const paths = {
    refresh:'<path d="M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-2l2 3M4 16l2 3a7 7 0 0 0 12-2"/>',
    search:'<circle cx="10.8" cy="10.8" r="6.8"/><path d="m16 16 4.5 4.5"/>',
    read:'<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m4 6 8 6 8-6"/>',
    check:'<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
    tick:'<path d="m5 12 4 4 10-11"/>',
    archive:'<path d="M3 6h6l2 3h10v11H3V6Z"/>',
    attach:'<path d="m9 17 8-8a3 3 0 0 0-4-4L5 13a5 5 0 0 0 7 7l8-8M8 14l7-7"/>',
    back:'<path d="m14 6-6 6 6 6"/>',
    close:'<path d="m6 6 12 12M6 18 18 6"/>',
    task:'<path d="M14 3H5v18h14V8l-5-5ZM14 3v5h5M9 14h6M12 11v6"/>',
    copy:'<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>'
  };
  const icon = (name) => `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">${paths[name]}</svg>`;
  const escape = (value) => String(value).replace(/[&<>"']/g, (char) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[char]);
  let data = structuredClone(HubDemoData);
  const state = { nav:"inbox", filter:"all", source:"all", search:"", activeId:"e1", version:null,
    selected:new Map([["e1",3]]), reading:false, sourceId:null, taskFilter:"all" };
  let toastTimer;
  const sourceOf = (entry) => data.sources.find((source) => source.id === entry.source);
  const latest = (entry) => entry.versions[0];
  const currentEntry = () => data.entries.find((entry) => entry.id === state.activeId);
  const currentVersion = (entry) => entry.versions.find((version) => version.version === state.version) ?? latest(entry);
  const selectedEntries = () => [...state.selected.entries()].map(([id,version]) => ({entry:data.entries.find((item) => item.id === id),version})).filter((item) => item.entry);
  function bodyHtml(body) {
    return body.split(/\n\n/).map((chunk) => {
      const lines = chunk.split("\n");
      if(lines[0].startsWith("## ")) return `<h2>${escape(lines.shift().slice(3))}</h2>` + (lines.length ? bodyHtml(lines.join("\n")) : "");
      if(lines.every((line) => line.startsWith("- "))) return `<ul>${lines.map((line) => `<li>${escape(line.slice(2))}</li>`).join("")}</ul>`;
      if(lines.every((line) => /^\d+\. /.test(line))) return `<ol>${lines.map((line) => `<li>${escape(line.replace(/^\d+\. /,""))}</li>`).join("")}</ol>`;
      return `<p>${lines.map(escape).join("<br>")}</p>`;
    }).join("");
  }
  function toast(message) {
    clearTimeout(toastTimer);toastElement.textContent=message;toastElement.classList.add("show");
    toastTimer=setTimeout(() => toastElement.classList.remove("show"),2500);
  }
  function visibleEntries() {
    const search=state.search.trim().toLocaleLowerCase();
    return data.entries.filter((entry) => entry.archived === (state.nav === "archive")
      && (state.source === "all" || entry.source === state.source)
      && (state.filter !== "unread" || entry.readVersion < latest(entry).version)
      && (state.filter !== "important" || entry.important)
      && (!search || `${entry.title} ${latest(entry).body} ${sourceOf(entry).name}`.toLocaleLowerCase().includes(search)));
  }
  function entryRow(entry) {
    return `<div class="entry-row ${state.activeId===entry.id?"selected":""}">
      <input type="checkbox" data-select="${entry.id}" aria-label="选择：${escape(entry.title)}" ${state.selected.has(entry.id)?"checked":""}>
      <button class="row-open" data-open="${entry.id}" aria-label="打开：${escape(entry.title)}"><strong>${escape(entry.title)}</strong>
      <span class="row-meta">${escape(sourceOf(entry).name)} · ${entry.date}</span><span class="row-summary">${escape(entry.summary)}</span></button></div>`;
  }
  function controlsHtml(entries) {
    return `<div class="list-controls"><div class="list-title"><h1>${names[state.nav]}</h1><span class="record-count">${entries.length} 条记录</span></div>
      <div class="search-row"><label class="search-field">${icon("search")}<input id="search" type="search" placeholder="搜索标题或内容" aria-label="搜索标题或内容" value="${escape(state.search)}"></label>
      <select id="source-filter" aria-label="来源筛选"><option value="all">全部来源</option>${data.sources.map((source) => `<option value="${source.id}" ${state.source===source.id?"selected":""}>${source.name}</option>`).join("")}</select></div>
      <div class="filters" aria-label="阅读筛选">${[["all","全部"],["unread","未读"],["important","重要"]].map(([id,label]) => `<button data-filter="${id}" class="${state.filter===id?"active":""}" aria-pressed="${state.filter===id}">${label}</button>`).join("")}</div></div>`;
  }
  function readerHtml(entry, report=false) {
    if(!entry) return `<div class="empty-state"><strong>没有匹配的记录</strong>试试其他来源或筛选条件。</div>`;
    const version=currentVersion(entry);
    return `${report?"":`<button class="back-button" data-back>${icon("back")}返回列表</button>`}
      <div class="reader-top"><div class="reader-meta">${sourceOf(entry).name} · ${version.date}</div>
      <div class="reader-actions"><button data-action="read">${icon("read")}${entry.readVersion>=version.version?"已读":"标记已读"}</button>
      <button data-action="done" aria-pressed="${entry.done}">${icon("check")}${entry.done?"恢复":"完成"}</button>
      <button data-action="archive">${icon("archive")}${entry.archived?"取消归档":"归档"}</button>
      <label class="version-control"><select id="version" aria-label="历史版本">${entry.versions.map((item) => `<option value="${item.version}" ${version.version===item.version?"selected":""}>版本 ${item.version}</option>`).join("")}</select></label></div></div>
      <h1 class="entry-title">${escape(entry.title)}</h1><p class="version-note">版本 ${version.version} · ${version.version===latest(entry).version?"最新版本":"历史版本"}</p>
      <article class="article-body">${bodyHtml(version.body)}</article>
      <div class="article-create"><button class="button green-outline" data-new-task="${entry.id}">${icon("task")}创建待办</button></div>`;
  }
  function renderInbox() {
    const entries=visibleEntries();
    if(!entries.some((entry) => entry.id===state.activeId)){state.activeId=entries[0]?.id??null;state.version=null;}
    workspace.className="workspace";workspace.dataset.reading=String(state.reading);
    workspace.innerHTML=`<section class="list-pane" aria-label="条目列表">${controlsHtml(entries)}<div class="entry-list">${entries.map(entryRow).join("")||'<div class="empty-state"><strong>这里暂时没有记录</strong>可以更换筛选条件。</div>'}</div></section><section class="reader-pane" aria-label="条目详情">${readerHtml(currentEntry())}</section>`;
  }
  function renderSources() {
    workspace.className="workspace full";delete workspace.dataset.reading;
    if(state.sourceId){renderSourceBoard();return;}
    workspace.innerHTML=`<section class="full-view"><div class="view-heading"><div><h1>来源</h1><p>每个来源保留自己的记录与展示方式。</p></div></div>
      ${data.sources.map((source) => `<div class="source-row"><span class="source-symbol">${source.name.slice(0,1)}</span><div class="source-copy"><strong>${source.name}</strong><p>${source.description}${source.active?"":" · 已停用"}</p></div><span class="source-layout">${modeNames[source.mode]}</span><button class="button small" data-source="${source.id}" aria-label="查看来源：${source.name}">查看</button></div>`).join("")}</section>`;
  }
  function renderSourceBoard() {
    const source=data.sources.find((item) => item.id===state.sourceId);
    const entries=data.entries.filter((entry) => entry.source===source.id&&!entry.archived);
    if(!entries.some((entry) => entry.id===state.activeId)){state.activeId=entries[0]?.id??null;state.version=null;}
    const heading=`<div class="board-heading"><button class="icon-button" data-source-back aria-label="返回来源">${icon("back")}</button><div class="board-title"><h1>${source.name}</h1><p>${source.description}</p></div><label class="layout-label">展示方式<select id="layout">${Object.entries(modeNames).map(([id,name]) => `<option value="${id}" ${source.mode===id?"selected":""}>${name}</option>`).join("")}</select></label></div>`;
    let body;
    if(source.mode==="report") body=`<div class="report-card">${readerHtml(currentEntry(),true)}</div>`;
    else if(source.mode==="list") body=entries.map((entry) => `<details class="list-entry" ${entry.id===state.activeId?"open":""}><summary>${escape(entry.title)}</summary><div class="row-meta">${entry.date} · 版本 ${latest(entry).version}</div><label class="select-row"><input type="checkbox" data-select="${entry.id}" aria-label="选择：${escape(entry.title)}" ${state.selected.has(entry.id)?"checked":""}>选择这条记录</label><article class="article-body">${bodyHtml(latest(entry).body)}</article><button class="button green-outline small" data-new-task="${entry.id}">${icon("task")}创建待办</button></details>`).join("");
    else body=entries.map((entry) => `<div class="list-entry"><div class="row-meta">${entry.date}</div><label class="select-row"><input type="checkbox" data-select="${entry.id}" aria-label="选择：${escape(entry.title)}" ${state.selected.has(entry.id)?"checked":""}>选择这条记录</label><h2>${escape(entry.title)}</h2><article class="article-body">${bodyHtml(latest(entry).body)}</article><button class="button green-outline small" data-new-task="${entry.id}">${icon("task")}创建待办</button></div>`).join("");
    workspace.innerHTML=`<section class="full-view">${heading}${entries.length?body:'<div class="empty-state">这个来源还没有记录。</div>'}</section>`;
  }
  function renderTasks() {
    const tasks=data.tasks.filter((task) => state.taskFilter==="all"||(state.taskFilter==="done"?task.done:!task.done));
    workspace.className="workspace full";delete workspace.dataset.reading;
    workspace.innerHTML=`<section class="full-view"><div class="view-heading"><div><h1>待办</h1><p>从记录中提取下一步，逐项跟进。</p></div><button class="button green-outline" data-new-task="">${icon("task")}新增待办</button></div>
      <div class="filters task-filters">${[["all","全部"],["open","未完成"],["done","已完成"]].map(([id,label]) => `<button class="${state.taskFilter===id?"active":""}" data-task-filter="${id}" aria-pressed="${state.taskFilter===id}">${label}</button>`).join("")}</div>
      ${tasks.map((task) => `<div class="task-row ${task.done?"done":""}"><input type="checkbox" data-task="${task.id}" aria-label="完成待办：${escape(task.title)}" ${task.done?"checked":""}><div class="task-copy"><strong>${escape(task.title)}</strong><p>${data.sources.find((source) => source.id===task.source)?.name??"手动记录"}${task.due?` · 截止 ${task.due}`:""}</p></div><button class="text-button" data-delete-task="${task.id}" aria-label="删除待办：${escape(task.title)}">删除</button></div>`).join("")||'<div class="empty-state"><strong>没有待办</strong>可以从条目中创建下一步。</div>'}</section>`;
  }
  function renderTray() {
    const selected=selectedEntries();
    tray.innerHTML=`<span class="selection-mark">${icon("tick")}</span><div class="selection-copy"><strong>已选 ${selected.length} 条</strong><span>${selected.length?escape(selected.map((item) => item.entry.title).join("、")):"选择记录，再带入当前聊天"}</span></div><button class="button primary" id="bring-to-chat" ${selected.length?"":"disabled"}>${icon("attach")}带入聊天</button><button class="text-button" id="clear-selection" ${selected.length?"":"disabled"}>清空</button>`;
  }
  function render() {
    document.querySelectorAll("[data-nav]").forEach((button) => button.setAttribute("aria-current",button.dataset.nav===state.nav?"page":"false"));
    if(state.nav==="sources")renderSources();else if(state.nav==="tasks")renderTasks();else renderInbox();
    renderTray();
  }
  function dialogShell(title,body,actions) {
    modalContent.innerHTML=`<header class="dialog-head"><h2 id="dialog-title">${title}</h2><button class="icon-button" data-close-dialog aria-label="关闭">${icon("close")}</button></header><div class="dialog-body">${body}</div><footer class="dialog-actions">${actions}</footer>`;
    if(!modal.open)modal.showModal();
  }
  function contextText() {
    return selectedEntries().map(({entry,version}) => {
      const snapshot=entry.versions.find((item) => item.version===version)??latest(entry);
      return `# ${entry.title}\n来源：${sourceOf(entry).name}\n条目：${entry.id} · 版本 ${snapshot.version}\n\n${snapshot.body}`;
    }).join("\n\n---\n\n");
  }
  function showContext() {
    const selected=selectedEntries();
    dialogShell("带入当前聊天",`<p>已选 ${selected.length} 条记录。引用包含来源、正文与版本。</p>${selected.map(({entry,version}) => {
      const snapshot=entry.versions.find((item) => item.version===version)??latest(entry);
      return `<article class="context-item"><h3>${escape(entry.title)}</h3><div class="row-meta">${sourceOf(entry).name} · 版本 ${snapshot.version}</div><div class="context-content">${escape(snapshot.body)}</div></article>`;
    }).join("")}<p class="subtle-link">模板仅预览引用内容，接入插件后交给当前 Codex 对话。</p>`,
    `<button class="button" data-close-dialog>返回</button><button class="button primary" id="copy-context">${icon("copy")}复制引用</button>`);
  }
  function showTaskForm(entryId) {
    const entry=data.entries.find((item) => item.id===entryId);
    dialogShell("创建待办",`<form id="task-form"><label class="form-field">待办标题<input id="task-title" name="title" aria-label="待办标题" required maxlength="180" placeholder="写下具体的下一步"></label><label class="form-field">来源<select name="source" aria-label="待办来源">${data.sources.map((source) => `<option value="${source.id}" ${source.id===(entry?.source??"manual")?"selected":""}>${source.name}</option>`).join("")}</select></label><label class="form-field">截止日期（可选）<input name="due" type="date" aria-label="截止日期"></label><input name="entryId" type="hidden" value="${entry?.id??""}"></form>`,
      `<button class="button" data-close-dialog>取消</button><button class="button primary" type="submit" form="task-form">创建待办</button>`);
    document.querySelector("#task-title").focus();
  }
  function showManagement() {
    dialogShell("管理",`<div class="management-note">总管身份可管理全部来源。这里的操作只影响本次示例。</div>${data.sources.map((source) => `<div class="management-row"><div class="source-copy"><strong>${source.name}</strong><p>${modeNames[source.mode]} · ${source.active?"已启用":"已停用"}</p></div>${source.id!=="manual"?`<button class="button small" data-toggle-source="${source.id}">${source.active?"停用":"启用"}</button>`:""}</div>`).join("")}`,
      `<button class="button" id="reset-demo">恢复示例</button><button class="button primary" data-close-dialog>完成</button>`);
  }
  document.querySelector(".main-tabs").addEventListener("click",(event) => {
    const button=event.target.closest("[data-nav]");if(!button)return;
    state.nav=button.dataset.nav;state.sourceId=null;state.reading=false;state.search="";state.source="all";state.filter="all";state.version=null;render();
  });
  document.querySelector(".brand").addEventListener("click",(event) => {event.preventDefault();state.nav="inbox";state.reading=false;state.sourceId=null;render();});
  document.querySelector("#refresh").addEventListener("click",() => {render();toast("示例视图已刷新");});
  document.querySelector("#manage").addEventListener("click",showManagement);
  workspace.addEventListener("click",(event) => {
    const open=event.target.closest("[data-open]");
    if(open){state.activeId=open.dataset.open;state.version=null;state.reading=true;render();return;}
    const filter=event.target.closest("[data-filter]");if(filter){state.filter=filter.dataset.filter;state.reading=false;render();return;}
    if(event.target.closest("[data-back]")){state.reading=false;render();return;}
    const source=event.target.closest("[data-source]");if(source){state.sourceId=source.dataset.source;state.version=null;render();return;}
    if(event.target.closest("[data-source-back]")){state.sourceId=null;render();return;}
    const newTask=event.target.closest("[data-new-task]");if(newTask){showTaskForm(newTask.dataset.newTask);return;}
    const taskFilter=event.target.closest("[data-task-filter]");if(taskFilter){state.taskFilter=taskFilter.dataset.taskFilter;render();return;}
    const deletion=event.target.closest("[data-delete-task]");if(deletion){data.tasks=data.tasks.filter((task) => task.id!==deletion.dataset.deleteTask);render();toast("示例待办已删除");return;}
    const action=event.target.closest("[data-action]");if(!action)return;
    const entry=currentEntry();if(!entry)return;
    if(action.dataset.action==="read"){entry.readVersion=Math.max(entry.readVersion,currentVersion(entry).version);toast("已标记当前版本为已读");}
    if(action.dataset.action==="done"){entry.done=!entry.done;toast(entry.done?"条目已完成":"条目已恢复为未完成");}
    if(action.dataset.action==="archive"){entry.archived=!entry.archived;state.reading=false;toast(entry.archived?"条目已归档，可在归档中恢复":"条目已移回收件箱");}
    render();
  });
  workspace.addEventListener("change",(event) => {
    const target=event.target;
    if(target.matches("[data-select]")){const entry=data.entries.find((item) => item.id===target.dataset.select);if(target.checked)state.selected.set(entry.id,entry.id===state.activeId?currentVersion(entry).version:latest(entry).version);else state.selected.delete(entry.id);renderTray();return;}
    if(target.id==="source-filter"){state.source=target.value;state.reading=false;render();}
    if(target.id==="version"){state.version=Number(target.value);const entry=currentEntry();if(state.selected.has(entry.id))state.selected.set(entry.id,state.version);render();}
    if(target.id==="layout"){data.sources.find((source) => source.id===state.sourceId).mode=target.value;render();}
    if(target.matches("[data-task]")){data.tasks.find((task) => task.id===target.dataset.task).done=target.checked;render();}
  });
  workspace.addEventListener("input",(event) => {
    if(event.target.id!=="search")return;
    state.search=event.target.value;const caret=event.target.selectionStart;renderInbox();
    const search=document.querySelector("#search");search.focus();if(search.type!=="search")search.setSelectionRange(caret,caret);
  });
  tray.addEventListener("click",(event) => {
    if(event.target.closest("#bring-to-chat"))showContext();
    if(event.target.closest("#clear-selection")){state.selected.clear();render();}
  });
  modal.addEventListener("click",async(event) => {
    if(event.target.closest("[data-close-dialog]")){modal.close();return;}
    const toggle=event.target.closest("[data-toggle-source]");if(toggle){const source=data.sources.find((item) => item.id===toggle.dataset.toggleSource);source.active=!source.active;showManagement();render();return;}
    if(event.target.closest("#reset-demo")){data=structuredClone(HubDemoData);Object.assign(state,{nav:"inbox",filter:"all",source:"all",search:"",activeId:"e1",version:null,selected:new Map([["e1",3]]),reading:false,sourceId:null,taskFilter:"all"});modal.close();render();toast("已恢复示例");return;}
    if(event.target.closest("#copy-context")){try{await navigator.clipboard.writeText(contextText());toast("引用内容已复制，可粘贴到聊天");}catch{toast("复制不可用，可以直接选取预览中的内容");}}
  });
  modal.addEventListener("submit",(event) => {
    if(event.target.id!=="task-form")return;event.preventDefault();const values=new FormData(event.target);const title=String(values.get("title")).trim();if(!title)return;
    data.tasks.unshift({id:`t-${Date.now()}`,title,source:String(values.get("source")),due:String(values.get("due")),entryId:String(values.get("entryId")),done:false});modal.close();render();toast("待办已创建，可在待办页查看");
  });
  document.addEventListener("keydown",(event) => {if((event.ctrlKey||event.metaKey)&&event.key==="k"&&!modal.open){event.preventDefault();state.nav="inbox";state.reading=false;render();document.querySelector("#search").focus();}});
  render();
})();
