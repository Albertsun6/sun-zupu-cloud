// ============================================================
// users.js —— 用户管理(仅 admin)。type=module,在 app.js 之后加载,裸引用其全局。
// 经 window.ADMIN(db.js)调 CF 函数 /api/admin-users(service_role 在服务端;前端只发意图)。
// ============================================================
const { $, el, esc, state } = window;

function roleLabel(r){ return r==="admin"?"管理员":r==="editor"?"可编辑":"只读"; }

function ensureMask(id){
  let m=document.getElementById(id);
  if(!m){ m=document.createElement("div"); m.className="mask"; m.id=id; m.innerHTML='<div class="modal" style="width:min(460px,100%)"></div>'; document.body.appendChild(m);
    m.onclick=e=>{ if(e.target===m) m.classList.remove("open"); }; }
  return m;
}
function uMsg(t, isErr){ const m=document.getElementById("uMsg"); if(m){ m.className=isErr?"err":"hint"; m.textContent=t; } }

async function renderUsers(){
  const box=document.getElementById("usersBox"); if(!box) return;
  if(!state.isAdmin){ box.innerHTML="<p class='note'>需要管理员(admin)权限。</p>"; return; }
  box.innerHTML=`<div class="panel">
    <div class="dsec-h">👤 用户管理 <button class="btn btn-sm btn-primary" id="uNew">+ 新建用户</button> <button class="btn btn-sm" id="uReload">刷新</button></div>
    <p class="hint">管理登录账号与权限。角色:<b>管理员</b>(可管用户+编辑数据)/ <b>可编辑</b> / <b>只读</b>。「纪要」开关单独控制谁能进纪要菜单。改完对方<b>需重新登录</b>才生效。账号由管理员在此创建(已关闭公开注册)。</p>
    <div id="uMsg" class="hint"></div>
    <div id="uList">加载中…</div></div>`;
  $("#uNew").onclick=openUserCreate;
  $("#uReload").onclick=loadUsers;
  await loadUsers();
}

async function loadUsers(){
  const list=document.getElementById("uList"); if(!list) return;
  try{
    const users=await window.ADMIN.listUsers();
    state._users=users;
    list.innerHTML=userTable(users);
    bindRows();
  }catch(e){ list.innerHTML=`<p class="err">加载失败:${esc(e.message)}</p>`; }
}

function userTable(users){
  const me=state.user&&state.user.id;
  const rows=users.map(u=>{
    const isSelf=u.id===me;
    const roleSel=`<select class="u-role" data-id="${esc(u.id)}" ${isSelf?"disabled title='不能改自己的角色'":""}>`+
      ["admin","editor","viewer"].map(r=>`<option value="${r}" ${u.role===r?"selected":""}>${roleLabel(r)}</option>`).join("")+`</select>`;
    const adminImplied=u.role==="admin";
    const minToggle=`<label class="switch"><input type="checkbox" class="u-min" data-id="${esc(u.id)}" ${(adminImplied||u.perms.includes("minutes"))?"checked":""} ${adminImplied?"disabled title='管理员默认可见纪要'":""}> 纪要</label>`;
    const status=u.disabled?`<span class="pill pill-warn">已停用</span>`:`<span class="pill pill-ok">启用</span>`;
    const last=u.last_sign_in_at?new Date(u.last_sign_in_at).toLocaleString("zh-CN"):"—";
    const acts=`<button class="btn btn-sm u-pw" data-id="${esc(u.id)}">改密</button>`+
      (u.disabled?`<button class="btn btn-sm u-enable" data-id="${esc(u.id)}">启用</button>`
                 :`<button class="btn btn-sm u-disable" data-id="${esc(u.id)}" ${isSelf?"disabled":""}>停用</button>`)+
      `<button class="btn btn-sm btn-danger u-del" data-id="${esc(u.id)}" ${isSelf?"disabled":""}>删除</button>`;
    return `<tr><td>${esc(u.email)}${isSelf?" <span class='hint'>(我)</span>":""}</td><td>${roleSel}</td><td>${minToggle}</td><td>${status}</td><td class="hint">${esc(last)}</td><td class="u-acts">${acts}</td></tr>`;
  }).join("");
  return `<table class="utable"><thead><tr><th>邮箱</th><th>角色</th><th>纪要权限</th><th>状态</th><th>最近登录</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table>`;
}

async function act(fn, okMsg){
  uMsg("处理中…");
  try{ const r=await fn(); uMsg("✅ "+(okMsg||(r&&r.note)||"完成")); }
  catch(e){ uMsg("失败:"+e.message, true); }
  await loadUsers();
}
function bindRows(){
  document.querySelectorAll(".u-role").forEach(s=> s.onchange=()=> act(()=>window.ADMIN.setRole(s.dataset.id,s.value), "角色已更新(对方需重新登录生效)"));
  document.querySelectorAll(".u-min").forEach(c=> c.onchange=()=> act(()=>window.ADMIN.setPerms(c.dataset.id, c.checked?["minutes"]:[]), "纪要权限已更新(对方需重新登录生效)"));
  document.querySelectorAll(".u-pw").forEach(b=> b.onclick=()=> openResetPw(b.dataset.id));
  document.querySelectorAll(".u-disable").forEach(b=> b.onclick=()=>{ const u=findU(b.dataset.id); if(confirm("停用账号 "+(u?u.email:"")+"?对方将无法登录(可再启用)。")) act(()=>window.ADMIN.disable(b.dataset.id),"已停用"); });
  document.querySelectorAll(".u-enable").forEach(b=> b.onclick=()=> act(()=>window.ADMIN.enable(b.dataset.id),"已启用"));
  document.querySelectorAll(".u-del").forEach(b=> b.onclick=()=>{ const u=findU(b.dataset.id); if(confirm("彻底删除账号 "+(u?u.email:"")+"?不可恢复。")) act(()=>window.ADMIN.del(b.dataset.id),"已删除"); });
}
function findU(id){ return (state._users||[]).find(x=>x.id===id); }

function openUserCreate(){
  const m=ensureMask("userCreateMask");
  m.querySelector(".modal").innerHTML=`<h2>新建用户</h2>
    <div class="field"><label for="nu_email">邮箱</label><input id="nu_email" type="email" autocomplete="off" placeholder="user@example.com"></div>
    <div class="field"><label for="nu_pw">初始密码(至少 6 位)</label><input id="nu_pw" type="text" autocomplete="off" placeholder="告知对方,首次登录后可自行改密"></div>
    <div class="field"><label for="nu_role">角色</label><select id="nu_role"><option value="viewer">只读</option><option value="editor">可编辑</option><option value="admin">管理员</option></select></div>
    <div class="field"><label class="switch"><input type="checkbox" id="nu_min"> 允许查看「纪要」</label></div>
    <div class="err" id="nu_err"></div>
    <div class="modal-foot"><span class="spacer"></span><button class="btn" id="nu_cancel">取消</button><button class="btn btn-primary" id="nu_ok">创建</button></div>`;
  m.classList.add("open"); setTimeout(()=>{ const e=document.getElementById("nu_email"); if(e)e.focus(); },50);
  document.getElementById("nu_cancel").onclick=()=>m.classList.remove("open");
  document.getElementById("nu_ok").onclick=async()=>{
    const email=(document.getElementById("nu_email").value||"").trim();
    const pw=document.getElementById("nu_pw").value||"";
    const role=document.getElementById("nu_role").value;
    const perms=document.getElementById("nu_min").checked?["minutes"]:[];
    const err=document.getElementById("nu_err");
    if(!email||pw.length<6){ err.textContent="请填邮箱,且密码至少 6 位"; return; }
    try{ err.textContent="创建中…"; await window.ADMIN.createUser(email,pw,role,perms); m.classList.remove("open"); await loadUsers(); uMsg("✅ 已创建 "+email); }
    catch(e){ err.textContent="失败:"+e.message; }
  };
}

function openResetPw(id){
  const u=findU(id); const m=ensureMask("pwResetMask");
  m.querySelector(".modal").innerHTML=`<h2>重置密码</h2><p class="hint">为 <b>${esc(u?u.email:"")}</b> 设置新密码(至少 6 位)。对方下次用新密码登录。</p>
    <div class="field"><label for="rp_pw">新密码</label><input id="rp_pw" type="text" autocomplete="off"></div><div class="err" id="rp_err"></div>
    <div class="modal-foot"><span class="spacer"></span><button class="btn" id="rp_cancel">取消</button><button class="btn btn-primary" id="rp_ok">保存</button></div>`;
  m.classList.add("open"); setTimeout(()=>{ const e=document.getElementById("rp_pw"); if(e)e.focus(); },50);
  document.getElementById("rp_cancel").onclick=()=>m.classList.remove("open");
  document.getElementById("rp_ok").onclick=async()=>{
    const pw=document.getElementById("rp_pw").value||"", err=document.getElementById("rp_err");
    if(pw.length<6){ err.textContent="密码至少 6 位"; return; }
    try{ err.textContent="保存中…"; await window.ADMIN.resetPassword(id,pw); m.classList.remove("open"); uMsg("✅ 已为 "+(u?u.email:"")+" 重置密码"); }
    catch(e){ err.textContent="失败:"+e.message; }
  };
}

window.renderUsers = renderUsers;
