'use strict';
'require view';
'require form';
'require rpc';
'require ui';

var callStatus    = rpc.declare({ object: 'komari', method: 'getStatus' });
var callLog       = rpc.declare({ object: 'komari', method: 'getLog', params: [ 'lines' ] });
var callProbe     = rpc.declare({ object: 'komari', method: 'probeServer' });
var callAction    = rpc.declare({ object: 'komari', method: 'serviceAction', params: [ 'action' ] });
var callCheck     = rpc.declare({ object: 'komari', method: 'checkUpdate' });
var callInstall   = rpc.declare({ object: 'komari', method: 'startInstall', params: [ 'version', 'url', 'digest', 'size' ] });
var callJob       = rpc.declare({ object: 'komari', method: 'getJob' });
var callBegin     = rpc.declare({ object: 'komari', method: 'uploadBegin', params: [ 'size' ] });
var callChunk     = rpc.declare({ object: 'komari', method: 'uploadChunk', params: [ 'seq', 'data' ] });
var callEnd       = rpc.declare({ object: 'komari', method: 'uploadEnd' });
var callAbort     = rpc.declare({ object: 'komari', method: 'uploadAbort' });
var callSetToken  = rpc.declare({ object: 'komari', method: 'setToken', params: [ 'token' ] });

/* uhttpd 转发到 ubus 的单次 JSON-RPC 载荷有大小上限（base64 超过约 64KB 会被拒绝），
   分块取 24KB 原始数据（base64 约 32KB），留出余量。 */
var CHUNK = 24 * 1024;

function fmtSize(n) {
	if (n == null || n < 0)
		return '—';
	if (n >= 1048576)
		return (n / 1048576).toFixed(1) + ' MB';
	if (n >= 1024)
		return (n / 1024).toFixed(1) + ' KB';
	return n + ' B';
}

function fmtDate(s) {
	if (!s)
		return '—';
	var d = new Date(s);
	if (isNaN(d.getTime()))
		return s;
	var p = function(n) { return n < 10 ? '0' + n : '' + n; };
	return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
		p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

function ensureOk(r) {
	if (r && r.ok === false)
		throw new Error(r.error || '操作失败');
	return r;
}

function confirmAction(title, text, fn) {
	ui.showModal(title, [
		E('p', {}, text),
		E('div', { 'class': 'right' }, [
			E('button', { 'class': 'btn', 'click': ui.hideModal }, '取消'),
			E('button', {
				'class': 'cbi-button cbi-button-action important',
				'click': function() { ui.hideModal(); fn(); }
			}, '确定')
		])
	]);
}

/* 卡片：标题 + 右侧动作区（版式对齐 luci-app-lucky 的服务卡片）
   children 支持单个节点或节点数组，必须展开后交给 E()，否则会被字符串化 */
function card(title, children, rightNode) {
	var head = E('div', {
		'style': 'display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px'
	}, [
		E('h3', { 'style': 'margin:0;padding:0;border:0;font-size:15px' }, title),
		rightNode || E('span', {})
	]);

	var kids = Array.isArray(children) ? children : [ children ];

	return E('div', {
		'class': 'cbi-section',
		'style': 'padding:16px;margin-bottom:16px;border:1px solid rgba(127,127,127,.25);border-radius:6px'
	}, [ head ].concat(kids));
}

/* 键值网格：小号灰标签在上、值在下，自适应两列（同 lucky 的服务概览） */
function kvGrid(items) {
	return E('div', {
		'style': 'display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px 24px;' +
			'padding:12px 14px;border-radius:4px;background:rgba(127,127,127,.07)'
	}, items.map(function(it) {
		return E('div', {}, [
			E('div', { 'style': 'font-size:12px;line-height:1.6;opacity:.62' }, it[0]),
			E('div', { 'style': 'font-weight:600;line-height:1.5;word-break:break-all' }, it[1])
		]);
	}));
}

function pill(text, ok) {
	return E('span', {
		'style': 'display:inline-flex;align-items:center;gap:6px;padding:2px 10px;border-radius:12px;' +
			'font-size:12px;font-weight:600;white-space:nowrap;' +
			(ok ? 'background:rgba(46,125,50,.12);color:#2e7d32' : 'background:rgba(198,40,40,.12);color:#c62828')
	}, [ E('span', { 'style': 'font-size:10px' }, '●'), text ]);
}

return view.extend({
	load: function() {
		return callStatus();
	},

	render: function(status) {
		var self = this;
		this.updateInfo = null;
		this.jobTimer = null;
		this.n = {};

		function cell() { return E('span', {}, '—'); }
		var n = this.n;

		n.bin = cell();
		n.ver = cell();
		n.ep = cell();
		n.probe = cell();
		n.lastconn = cell();
		n.lasterr = cell();
		n.updCur = cell();
		n.updLatest = cell();
		n.updDate = cell();
		n.updSize = cell();
		n.updDigest = cell();
		n.updMsg = E('div', { 'class': 'cbi-value-description', 'style': 'margin-top:10px' }, '');
		n.log = E('pre', {
			'style': 'max-height:280px;overflow:auto;font-size:12px;line-height:1.45;white-space:pre-wrap;' +
				'word-break:break-all;margin:0;padding:10px;background:rgba(127,127,127,.07);border-radius:4px'
		}, '加载中…');
		n.pillWrap = E('span', {});

		/* ---------- 服务状态 ---------- */
		var btnRestart = E('button', { 'class': 'cbi-button', 'click': ui.createHandlerFn(this, 'onAction', 'restart') }, '重启');
		var btnProbe = E('button', { 'class': 'cbi-button', 'click': ui.createHandlerFn(this, 'onProbe') }, '测试连接');
		var btnRefresh = E('button', { 'class': 'cbi-button', 'click': ui.createHandlerFn(this, 'refresh') }, '刷新');

		var statusCard = card('服务状态', [
			kvGrid([
				[ '二进制', n.bin ],
				[ '版本', n.ver ],
				[ '服务端地址', n.ep ],
				[ '服务端探测', n.probe ],
				[ '最近一次连接成功', n.lastconn ],
				[ '最近错误', n.lasterr ]
			]),
			E('div', { 'style': 'margin-top:14px;display:flex;flex-wrap:wrap;gap:8px' },
				[ btnRestart, btnProbe, btnRefresh ]),
			E('p', { 'class': 'cbi-value-description', 'style': 'margin:10px 0 0' },
				'进程运行不代表已连接服务端，请以「最近一次连接成功」与「服务端探测」为准。')
		], n.pillWrap);

		/* ---------- 更新与安装 ---------- */
		n.btnInstall = E('button', {
			'class': 'cbi-button cbi-button-action important',
			'disabled': true,
			'click': ui.createHandlerFn(this, 'onInstall')
		}, '安装此版本');
		n.btnCheck = E('button', { 'class': 'cbi-button', 'click': ui.createHandlerFn(this, 'onCheck') }, '检查更新');
		n.btnUpload = E('button', { 'class': 'cbi-button', 'click': function() { self.n.file.click(); } }, '手动上传二进制');
		n.file = E('input', { 'type': 'file', 'style': 'display:none', 'change': ui.createHandlerFn(this, 'onFileSelected') });
		n.jobBox = E('div', { 'style': 'margin-top:12px;display:none' }, [
			E('div', { 'class': 'cbi-progressbar', 'title': '0%' }, [ E('div', { 'style': 'width:0%' }) ]),
			E('div', { 'class': 'cbi-value-description' }, '')
		]);

		var updateCard = card('更新与安装', [
			kvGrid([
				[ '当前已装版本', n.updCur ],
				[ '最新版本', n.updLatest ],
				[ '发布时间', n.updDate ],
				[ '资产大小', n.updSize ],
				[ 'SHA256', n.updDigest ],
				[ '二进制来源', E('span', {}, 'GitHub Release（安装前校验 SHA256）') ]
			]),
			E('div', { 'style': 'margin-top:14px;display:flex;flex-wrap:wrap;gap:8px' },
				[ n.btnCheck, n.btnInstall, n.btnUpload, n.file ]),
			n.updMsg,
			n.jobBox
		]);

		/* ---------- 日志 ---------- */
		var logCard = card('最近日志', [
			n.log,
			E('div', { 'style': 'margin-top:10px' },
				E('button', { 'class': 'cbi-button', 'click': ui.createHandlerFn(this, 'refreshLog') }, '刷新日志'))
		]);

		var root = E('div', {}, [
			E('h2', {}, 'Komari Agent'),
			E('div', { 'class': 'cbi-map-descr', 'style': 'margin-bottom:16px' },
				'集中管理：运行状态、二进制安装与更新、连接参数、日志。'),
			statusCard,
			updateCard
		]);

		/* ---------- 设置表单（同一页内） ---------- */
		var m = new form.Map('komari_agent', '', '');
		this.map = m;
		this.buildForm(m);

		this.applyStatus(status);
		this.refreshLog();
		window.setInterval(L.bind(this.refresh, this), 10000);

		return Promise.resolve(m.render()).then(function(formNode) {
			var h = formNode.querySelector('h2');
			if (h && !h.textContent.trim())
				h.parentNode.removeChild(h);
			var d = formNode.querySelector('.cbi-map-descr');
			if (d && !d.textContent.trim())
				d.parentNode.removeChild(d);

			/* 让表单的各个 section 与上方卡片视觉一致（同 lucky 的卡片版式） */
			formNode.querySelectorAll('.cbi-section').forEach(function(sec) {
				sec.style.padding = '16px';
				sec.style.marginBottom = '16px';
				sec.style.border = '1px solid rgba(127,127,127,.25)';
				sec.style.borderRadius = '6px';
			});
			formNode.querySelectorAll('.cbi-section h3').forEach(function(t) {
				t.style.margin = '0 0 12px';
				t.style.padding = '0';
				t.style.border = '0';
				t.style.fontSize = '15px';
			});

			root.appendChild(formNode);
			root.appendChild(logCard);
			return root;
		});
	},

	buildForm: function(m) {
		var s, o;

		s = m.section(form.NamedSection, 'agent', 'komari_agent', '连接设置');
		s.addremove = false;

		o = s.option(form.Flag, 'enabled', '启用服务', '开机自启并保持运行；关闭则停止进程。');
		o.rmempty = false;
		o.default = '0';

		o = s.option(form.Value, 'endpoint', '服务端地址', 'Komari 面板地址，例如 https://komari.example.com');
		o.placeholder = 'https://komari.example.com';
		o.rmempty = false;
		o.validate = function(section_id, value) {
			if (value == null || value === '')
				return true;
			if (!/^https?:\/\/[^\s]+$/.test(value))
				return '必须是以 http:// 或 https:// 开头的地址';
			return true;
		};

		/* 不绑定 UCI 选项（token_new 不落盘）：留空=保持原值，填写则经 rpcd 写入 */
		o = s.option(form.Value, 'token_new', 'Agent Token',
			'已保存的 Token 不回显（文件权限 600）。留空表示保持不变，输入新值则覆盖。');
		o.password = true;
		o.placeholder = '留空保持不变';
		o.optional = true;
		o.cfgvalue = function() { return ''; };
		o.write = function(section_id, value) {
			if (value == null || value === '')
				return;
			return callSetToken(value).then(ensureOk);
		};

		o = s.option(form.Value, 'interval', '上报间隔（秒）', '数据采集与上报间隔，默认 3 秒。');
		o.datatype = 'range(1,60)';
		o.default = '3';

		o = s.option(form.Flag, 'disable_web_ssh', '禁用远程控制',
			'开启后（默认）面板无法对本机执行 Web 终端、远程命令与文件管理。关闭等于把 root 权限交给面板管理员。');
		o.default = '1';
		o.rmempty = false;

		o = s.option(form.Flag, 'ignore_unsafe_cert', '忽略 TLS 证书错误',
			'仅在服务端使用自签名证书且明确知情时开启。');
		o.default = '0';
		o.rmempty = false;

		s = m.section(form.NamedSection, 'agent', 'komari_agent', '采集范围');
		s.addremove = false;

		o = s.option(form.Value, 'include_nics', '仅统计网卡', '逗号分隔，支持通配符；路由器 WAN 为 pppoe-wan。');
		o.placeholder = 'pppoe-wan';
		o.rmempty = true;

		o = s.option(form.Value, 'exclude_nics', '排除网卡', '逗号分隔，支持通配符，例如 lo。');
		o.placeholder = 'lo';
		o.rmempty = true;

		o = s.option(form.Value, 'include_mountpoints', '仅统计挂载点', '分号（;）分隔；默认仅根文件系统 /。');
		o.placeholder = '/';
		o.rmempty = true;

		s = m.section(form.NamedSection, 'agent', 'komari_agent', '高级');
		s.addremove = false;

		o = s.option(form.Value, 'reconnect_interval', '重连间隔（秒）', '断线重连间隔，默认 5 秒。');
		o.datatype = 'range(2,120)';
		o.default = '5';

		o = s.option(form.Value, 'max_retries', '最大重试次数', '连续失败达到该次数后转入 HTTP 降级上报模式。');
		o.datatype = 'range(1,20)';
		o.default = '3';
	},

	applyStatus: function(st) {
		var n = this.n;
		if (!st)
			return;

		var newPill = pill(st.running ? ('运行中' + (st.pid ? '（PID ' + st.pid + '）' : '')) : '已停止', !!st.running);
		n.pillWrap.parentNode.replaceChild(newPill, n.pillWrap);
		n.pillWrap = newPill;

		n.bin.textContent = st.binary_exists ? '已安装（' + fmtSize(st.binary_size) + '）' : '未安装';
		n.bin.style.color = st.binary_exists ? '' : '#c62828';
		n.ver.textContent = st.version || (st.binary_exists ? '未知（启动后从日志读取）' : '—');
		n.ep.textContent = st.endpoint || '未配置';
		n.lastconn.textContent = st.last_connect || '暂无记录';
		n.lasterr.textContent = st.last_error || '暂无';
		n.updCur.textContent = st.binary_exists ? (st.version || '未知') : '未安装';

		n.log.textContent = (st.log_tail && st.log_tail.length) ? st.log_tail.join('\n') : '（暂无日志）';

		if (st.job && (st.job.phase === 'downloading' || st.job.phase === 'verifying' ||
			st.job.phase === 'installing' || st.job.phase === 'starting'))
			this.startJobPolling();
	},

	refresh: function() {
		var self = this;
		return L.resolveDefault(callStatus(), null).then(function(st) {
			self.applyStatus(st);
		});
	},

	refreshLog: function() {
		var self = this;
		return L.resolveDefault(callLog(60), null).then(function(r) {
			if (r && r.lines)
				self.n.log.textContent = r.lines.length ? r.lines.join('\n') : '（暂无日志）';
		});
	},

	onAction: function(action) {
		var self = this;
		var doIt = function() {
			return callAction(action).then(function(r) {
				ensureOk(r);
				ui.addNotification(null, E('p', {}, '操作成功：' + action), 'info');
				return self.refresh().then(function() { return self.refreshLog(); });
			}).catch(function(e) {
				ui.addNotification(null, E('p', {}, '操作失败：' + (e.message || e)), 'danger');
			});
		};
		if (action === 'stop' || action === 'restart')
			confirmAction('确认操作', action === 'stop' ? '确定要停止 Komari Agent 吗？' : '确定要重启 Komari Agent 吗？', doIt);
		else
			doIt();
	},

	onProbe: function() {
		var self = this;
		this.n.probe.textContent = '检测中…';
		return callProbe().then(function(r) {
			self.n.probe.textContent = r && r.ok
				? '可达' + (r.server_version ? '（服务端 ' + r.server_version + '）' : '（/ping 正常）')
				: '不可达：' + ((r && r.error) || '未知错误');
			self.n.probe.style.color = r && r.ok ? '#2e7d32' : '#c62828';
		}).catch(function(e) {
			self.n.probe.textContent = '检测失败：' + (e.message || e);
			self.n.probe.style.color = '#c62828';
		});
	},

	onCheck: function() {
		var self = this;
		this.n.updMsg.textContent = '正在查询 GitHub Releases…';
		return callCheck().then(function(r) {
			self.updateInfo = r;
			self.n.updLatest.textContent = r.latest || '—';
			self.n.updDate.textContent = fmtDate(r.published);
			self.n.updSize.textContent = fmtSize(r.size);
			self.n.updDigest.textContent = r.digest ? (r.digest.substr(0, 16) + '…') : '未提供';

			var msg;
			if (!r.ok) {
				msg = '检查失败：' + (r.error || '未知错误');
				self.n.btnInstall.disabled = true;
			}
			else if (!r.digest) {
				msg = '最新版本 ' + r.latest + ' 未提供 SHA256 摘要，出于安全考虑不支持自动安装，请手动上传。';
				self.n.btnInstall.disabled = true;
			}
			else {
				if (r.has_update === false)
					msg = '已是最新版本（' + r.installed + '），仍可强制重装。';
				else if (r.installed)
					msg = '发现新版本：' + r.installed + ' → ' + r.latest;
				else
					msg = '尚未安装 Agent，可安装 ' + r.latest;
				self.n.btnInstall.disabled = false;
			}
			self.n.updMsg.textContent = msg;
		}).catch(function(e) {
			self.n.updMsg.textContent = '检查失败：' + (e.message || e);
		});
	},

	onInstall: function() {
		var self = this;
		var r = this.updateInfo;
		if (!r || !r.ok || !r.digest || !r.url)
			return;

		confirmAction('确认安装', '将下载 ' + r.latest + '（' + fmtSize(r.size) + '）并安装到 /usr/bin/komari-agent，完成后自动重启服务。继续？', function() {
			self.n.btnInstall.disabled = true;
			self.n.updMsg.textContent = '正在启动安装任务…';
			return callInstall(r.latest, r.url, r.digest, r.size).then(function(res) {
				ensureOk(res);
				self.startJobPolling();
			}).catch(function(e) {
				self.n.btnInstall.disabled = false;
				self.n.updMsg.textContent = '安装失败：' + (e.message || e);
			});
		});
	},

	startJobPolling: function() {
		var self = this;
		if (this.jobTimer)
			return;
		this.n.jobBox.style.display = '';
		this.jobTimer = window.setInterval(function() {
			callJob().then(function(j) {
				self.renderJob(j);
				if (j.phase === 'done' || j.phase === 'error' || j.phase === 'idle') {
					window.clearInterval(self.jobTimer);
					self.jobTimer = null;
					window.setTimeout(function() { self.n.jobBox.style.display = 'none'; }, 4000);
					if (j.phase === 'done')
						ui.addNotification(null, E('p', {}, '安装完成，当前版本：' + (j.version || '未知')), 'info');
					self.refresh();
				}
			}).catch(function() {});
		}, 1200);
	},

	renderJob: function(j) {
		var box = this.n.jobBox;
		var pct = 0;
		if (j.total > 0 && j.bytes > 0)
			pct = Math.min(100, Math.round(j.bytes * 100 / j.total));
		if (j.phase === 'verifying' || j.phase === 'installing')
			pct = Math.max(pct, 96);
		if (j.phase === 'done')
			pct = 100;
		box.firstChild.title = pct + '%';
		box.firstChild.firstChild.style.width = pct + '%';
		box.lastChild.textContent = (j.message || j.phase) +
			(j.phase === 'downloading' && j.total ? '（' + fmtSize(j.bytes) + ' / ' + fmtSize(j.total) + '）' : '');
		box.lastChild.style.color = j.phase === 'error' ? '#c62828' : '';
	},

	onFileSelected: function(ev) {
		var self = this;
		var file = ev.target.files && ev.target.files[0];
		ev.target.value = '';
		if (!file)
			return;
		if (file.size < 1048576) {
			ui.addNotification(null, E('p', {}, '文件过小，不是有效的 Agent 二进制'), 'danger');
			return;
		}

		confirmAction('确认上传', '将上传 ' + file.name + '（' + fmtSize(file.size) + '）并安装为 Komari Agent 二进制。继续？', function() {
			self.n.jobBox.style.display = '';
			self.n.jobBox.lastChild.textContent = '准备上传…';
			return callBegin(file.size).then(ensureOk).then(function() {
				return self.uploadLoop(file, 0);
			}).then(function() {
				self.n.jobBox.lastChild.textContent = '上传完成，正在校验并安装…';
				return callEnd();
			}).then(ensureOk).then(function(r) {
				self.n.jobBox.lastChild.textContent = '安装完成';
				ui.addNotification(null, E('p', {}, '二进制已安装' + (r && r.size ? '（' + fmtSize(r.size) + '）' : '')), 'info');
				return self.refresh();
			}).catch(function(e) {
				self.n.jobBox.lastChild.textContent = '上传/安装失败';
				self.n.jobBox.lastChild.style.color = '#c62828';
				L.resolveDefault(callAbort(), null);
				ui.addNotification(null, E('p', {}, '上传失败：' + (e.message || e)), 'danger');
			});
		});
	},

	uploadLoop: function(file, offset) {
		var self = this;
		var seq = Math.floor(offset / CHUNK);
		return file.slice(offset, offset + CHUNK).arrayBuffer().then(function(buf) {
			var bytes = new Uint8Array(buf);
			var bin = '';
			for (var i = 0; i < bytes.length; i++)
				bin += String.fromCharCode(bytes[i]);
			return callChunk(seq, window.btoa(bin));
		}).then(ensureOk).then(function() {
			var next = offset + CHUNK;
			var pct = Math.min(100, Math.round(Math.min(next, file.size) * 100 / file.size));
			self.n.jobBox.firstChild.title = pct + '%';
			self.n.jobBox.firstChild.firstChild.style.width = pct + '%';
			self.n.jobBox.lastChild.textContent = '上传中 ' + fmtSize(Math.min(next, file.size)) + ' / ' + fmtSize(file.size);
			if (next < file.size)
				return self.uploadLoop(file, next);
		});
	},

	handleSave: function(ev) {
		var self = this;
		return this.map.save().then(function() {
			return ui.changes.apply(true);
		}).then(function() {
			return L.resolveDefault(callAction('sync'), null);
		}).then(function() {
			return self.refresh();
		});
	},

	handleSaveApply: function(ev, mode) {
		var self = this;
		return this.map.save().then(function() {
			return ui.changes.apply(mode == '0');
		}).then(function() {
			return L.resolveDefault(callAction('apply'), null);
		}).then(function() {
			return self.refresh().then(function() { return self.refreshLog(); });
		});
	}
});
