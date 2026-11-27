#!/usr/bin/env node
// webhub — unified CLI for Web AI Hub: multi-account dedicated Chrome manager, live concurrency
// & MCP monitor, task dispatch (Gemini & ChatGPT web), trace audit, cancellation, and service control.
//
//   webhub ps [--json] [--probe] [--account NAME]    live concurrency, accounts, tabs, in-flight MCP, jobs/agents
//   webhub top [--interval 2] [--probe]              live refreshing monitor (Ctrl-C to stop)
//   webhub watch [task_id] [--args]                  live colored event stream
//   webhub trace <task_id> [--json]                  full chronological MCP audit + diffs + final report
//   webhub account [list|add <name>|remove <name>|enable <name>|disable <name>|default <name>]
//     add flags: [--sites gemini,chatgpt] [--port PORT] [--label LABEL] [--concurrency N] [--daily-limit N]
//     remove flags: [--purge] [--force]
//   webhub run [flags] "任务"                        dispatch to --site gemini|chatgpt (also: webhub "任务")
//     flags: --site gemini|chatgpt --account NAME|auto (-a) --cwd DIR -f FILE --chat URL
//            --model LABEL --effort N --allow-pro --dry-run --no-wait --keep-tab --timeout SEC --from NAME --no-operator
//   webhub ask [--backend SPEC] [--model M] [--effort E] [--session NAME|--chat URL] [--cwd DIR] [--json] [-f FILE|-] "prompt"
//     one prompt -> one answer on stdout (stdin works too). SPEC: web:gemini[:MODEL[:EFFORT]] | web:chatgpt[:MODEL] |
//     gateway[:MODEL] | claude | codex | <agent backend> | alias (neon, carbon, hydrogen, gpt, config.models). Exit 0/2/3/4/5.
//   webhub swarm plan "goal" [--planner SPEC] [--workers a,b] [--max-tasks N] [--run] [--wait]   plan with a model, then run it
//   webhub swarm start plan.json [--concurrency N] [--retries N] [--wait] | swarm run [--backend a,b] "p1" "p2" ...
//   webhub swarm list | status <id> [--watch] [--answers] [--json] | result <id> [--wait] | cancel <id> | retry <id> [task..] | resume <id>
//   webhub session list | show <name> | rm <name>          named conversations used by ask --session
//   webhub targets                                       backends, gateways and model aliases you can use
//   webhub list | result <id> [--wait]
//   webhub cancel <task_id>                          cancel task, kill its local jobs, close its tabs
//   webhub kill <job_id|agent_id>                    kill a running shell job or local agent
//   webhub approve <id> | deny <id>
//   webhub limit [clear [gemini|chatgpt]] [--account NAME]
//   webhub browser up|down|show|status [--check]|tabs [--probe]|open [gemini|chatgpt|monitor]|focus <tid>|close <tid> [--account NAME|--all]
//   webhub browser mode [embedded|chrome] [--account NAME]   embedded = pages inside the Web AI Hub app (default); chrome = dedicated Chrome
//   webhub browser import-login [chatgpt] [--account NAME]   copy the ChatGPT login of the dedicated Chrome into the embedded browser
//   webhub browser login-external gemini|chatgpt [--account NAME]   sign in in a Chrome window (Google blocks embedded sign-in) and copy the session into the embedded browser
//   webhub login [gemini|chatgpt] [--account NAME]
//   webhub goal ...
//   webhub install|uninstall|start|stop|restart|status|url|secrets|logs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');
const { Renderer, col } = await import(path.join(SRC, 'render.js'));
const { STATE_DIR, loadConfig } = await import(path.join(SRC, 'config.js'));
const accountsMod = await import(path.join(SRC, 'accounts.js'));

function readJson(p, d = {}) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } }
const cfg = { admin_host: '127.0.0.1', admin_port: 8782, ...loadConfig() };
const secrets = readJson(path.join(STATE_DIR, 'secrets.json'));
const API = `http://${cfg.admin_host}:${cfg.admin_port}/api`;

let apiRetrySec = 0;
async function tryApi(p, { method = 'GET', body } = {}) {
  const until = Date.now() + apiRetrySec * 1000;
  for (;;) {
    try {
      const r = await fetch(API + p, {
        method,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${secrets.admin_token || ''}` },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await r.text();
      let j; try { j = JSON.parse(text); } catch { j = { raw: text }; }
      if (!r.ok) throw Object.assign(new Error(j.error || text || r.statusText), { status: r.status, body: j });
      return j;
    } catch (e) {
      if (e.status) throw e;
      if (Date.now() < until) { await new Promise((res) => setTimeout(res, 3000)); continue; }
      return { __unreachable: true, error: e };
    }
  }
}

async function api(p, opts = {}) {
  const res = await tryApi(p, opts);
  if (res?.__unreachable) {
    const e = res.error;
    console.error(`webhub: MCP server not reachable at ${API} (${e.cause?.code || e.message}). Start it: webhub start`);
    process.exit(5);
  }
  return res;
}

function trunc(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
function pad(s, n) { s = String(s || ''); return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length); }

function formatPs(s, filterAccount = null) {
  const lines = [];
  const tun = s.tunnel?.mcp_url || '未启动';
  const br = s.browser || {};
  const brTxt = br.running ? `已运行（共 ${br.tab_count} 个标签页）` : '未启动';
  lines.push(`${col.bold(`网页 AI 控制台 v${s.server.version}`)}  PID ${s.server.pid}  ${col.gray(`公网隧道: ${tun}`)}`);
  lines.push(`浏览器   ${br.running ? col.green(brTxt) : col.yellow(brTxt)}  ${col.gray(`默认账号=${s.web?.default_account || 'default'} 满槽/限流自动切换=${s.web?.auto_failover !== false ? '开启' : '关闭'}`)}`);

  const accts = (s.accounts || []).filter((a) => !filterAccount || a.name === filterAccount);
  if (accts.length) {
    lines.push('');
    lines.push(col.bold(`账号与浏览器 (${accts.length})`));
    for (const a of accts) {
      const tags = [a.is_default ? '默认' : null, a.enabled ? null : '停用'].filter(Boolean).join(',');
      const b = a.browser;
      const bPort = b?.port ?? a.port;
      const bStr = b?.running ? col.green(`${b.mode === 'embedded' ? 'App内嵌' : '在线'}:${bPort} (${b.tab_count}页)`) : col.gray(`未开:${a.port}`);
      const siteParts = [];
      for (const sn of ['gemini', 'chatgpt']) {
        const q = a.quota?.[sn];
        if (!q || !q.supported) continue;
        const runN = q.running?.length || 0;
        const limN = q.concurrency ?? a.concurrency;
        const capN = q.daily_limit || '∞';
        const paused = q.limit ? col.red(' 限流暂停') : '';
        siteParts.push(`${sn} 并发${runN}/${limN} 今日${q.used_today}/${capN}${paused}`);
      }
      lines.push(`  ${pad(a.name + (tags ? '*' : ''), 13)} ${bStr.padEnd(b?.running ? 26 : 19)} ${siteParts.join('  ')}${tags ? col.gray(`  [${tags}]`) : ''}`);
    }
  } else {
    const sites = s.web?.sites || {};
    const bySite = s.slots?.by_site || {};
    const cap = s.web?.daily_limit || '∞';
    for (const name of ['gemini', 'chatgpt']) {
      const runN = (bySite[name]?.running || []).length;
      const limN = bySite[name]?.limit ?? s.slots?.limit ?? 3;
      const qN = (bySite[name]?.queued || []).length;
      const today = sites[name]?.used_today ?? 0;
      const lim = sites[name]?.limit;
      const pause = lim ? col.red(` 暂停至 ${lim.until}`) : '';
      lines.push(`${pad(name, 8)} 并发 ${runN}/${limN} · 排队 ${qN} · 今日 ${today}/${cap}${pause}`);
    }
  }

  const tabs = (br.tabs || []).filter((tb) => !filterAccount || (tb.account || 'default') === filterAccount);
  lines.push('');
  lines.push(col.bold(`打开中的标签页 (${tabs.length})`));
  if (!tabs.length) {
    lines.push(col.gray('  (暂无)'));
  } else {
    for (const tb of tabs) {
      const stageCol = ['generating', 'sending', 'tool_running'].includes(tb.stage)
        ? col.cyan(tb.stage)
        : ['waiting_confirm', 'rate_limited', 'auth_required'].includes(tb.stage)
          ? col.yellow(tb.stage)
          : col.gray(tb.stage);
      const taskPart = tb.task_id ? col.magenta(pad(tb.task_id, 14)) : col.gray(pad('—', 14));
      const modelPart = tb.model ? col.gray(`[${trunc(tb.model, 18)}] `) : '';
      lines.push(`  ${pad(tb.account || 'default', 10)} ${pad(tb.site, 8)} ${pad(tb.mode, 7)} ${pad(tb.stage, 15).replace(tb.stage, stageCol)} ${taskPart} ${modelPart}${trunc(tb.title || tb.url, 48)} ${col.gray(tb.target_id.slice(0, 8))}`);
    }
  }

  const inflight = s.in_flight || [];
  lines.push('');
  lines.push(col.bold(`执行中的 MCP 工具 (${inflight.length})`));
  if (!inflight.length) {
    lines.push(col.gray('  (暂无)'));
  } else {
    for (const c of inflight) {
      lines.push(`  ${col.cyan(pad(c.tool, 15))} ${pad(c.task_id, 14)} ${pad(c.client, 10)} ${pad(`${c.elapsed_sec}s`, 7)} ${trunc(c.summary, 60)}`);
    }
  }

  const runJobs = s.jobs?.running || [];
  const runAgents = (s.agents?.recent || []).filter((a) => a.status === 'running');
  lines.push('');
  lines.push(col.bold(`运行中的本地进程 (命令 ${runJobs.length} · 代理 ${runAgents.length})`));
  if (!runJobs.length && !runAgents.length) {
    lines.push(col.gray('  (暂无)'));
  } else {
    for (const j of runJobs) {
      lines.push(`  ${col.yellow('job')} ${pad(j.job_id, 14)} pid=${pad(j.pid, 7)} ${pad(j.task_id || '—', 14)} ${pad(`${j.elapsed_sec}s`, 7)} ${trunc(j.command, 50)} ${col.gray(`(${j.cwd})`)}`);
    }
    for (const a of runAgents) {
      lines.push(`  ${col.magenta('agent')} ${pad(a.id, 12)} ${pad(a.backend, 7)} pid=${pad(a.pid, 7)} ${pad(a.task_id || '—', 14)} ${trunc(a.prompt_preview, 50)}`);
    }
  }

  const swarms = (s.swarms || []).filter((w) => w.status === 'running' || Date.now() - Date.parse(w.ended || w.updated || 0) < 3600e3);
  if (swarms.length) {
    lines.push('');
    lines.push(col.bold(`蜂群 (${swarms.filter((w) => w.status === 'running').length} 个运行中)`));
    for (const w of swarms) {
      const c = Object.entries(w.counts || {}).map(([k, v]) => `${k} ${v}`).join(' · ');
      lines.push(`  ${col.cyan(pad(w.id, 12))} ${pad(w.status, 9)} ${pad(c, 34)} ${trunc(w.title, 50)}${w.status === 'running' && !w.runner_alive ? col.red('  (调度进程不在: swarm resume)') : ''}`);
    }
  }

  const isTaskActive = (t) => ['queued', 'starting', 'dispatched', 'running'].includes(t.status)
    || (t.status === 'active' && Date.now() - Date.parse(t.last_activity || t.created || 0) < 30 * 60 * 1000);
  const allTasks = (s.tasks || []).filter((t) => !filterAccount || (t.account || 'default') === filterAccount);
  const active = allTasks.filter(isTaskActive);
  const recent = allTasks.filter((t) => !isTaskActive(t)).slice(0, 6);
  const shown = [...active, ...recent];
  lines.push('');
  lines.push(col.bold(`近期任务 (进行中 ${active.length} · 共 ${allTasks.length})`));
  if (!shown.length) {
    lines.push(col.gray('  (暂无)'));
  } else {
    for (const t of shown) {
      const stg = t.driver?.stage ? `/${t.driver.stage}` : '';
      const files = t.files_changed?.length ? ` ${t.files_changed.length}f` : '';
      const mod = t.driver?.model ? ` [${trunc(t.driver.model, 16)}]` : '';
      lines.push(`  ${pad(t.id, 15)} ${pad(t.account || 'default', 10)} ${pad(t.site || 'gemini', 8)} ${pad(t.status + stg, 20)} ${pad(`${t.tool_calls}c${files}`, 8)} ${trunc(t.title, 42)}${col.gray(mod)}`);
    }
  }
  return lines.join('\n');
}

async function runTrace(taskId, asJson) {
  const t = await api(`/tasks/${encodeURIComponent(taskId)}`);
  const evs = await api(`/events?task_id=${encodeURIComponent(taskId)}&limit=5000`);
  if (asJson) {
    console.log(JSON.stringify({ task: t, events: evs }, null, 2));
    return;
  }
  console.log(`${col.bold(t.title)}  [${t.id}]`);
  console.log(`site=${t.site || 'gemini'}  account=${t.account || 'default'}  origin=${t.origin}  status=${t.status}${t.driver?.stage ? `  stage=${t.driver.stage}` : ''}${t.driver?.model ? `  model=${t.driver.model}` : ''}`);
  console.log(`from=${t.from}  calls=${t.tool_calls}  denied=${t.denied_calls}${t.cwd ? `  cwd=${t.cwd}` : ''}${t.chat_url ? `  chat=${t.chat_url}` : ''}`);
  if (t.files_changed?.length) console.log(`files changed: ${t.files_changed.join(', ')}`);
  if (t.conflicts?.length) console.log(col.red(`conflicts: ${t.conflicts.map((c) => `${c.path}: ${c.message}`).join('; ')}`));
  console.log('');
  const r = new Renderer({ showArgs: false, compact: false });
  for (const ev of evs) r.event(ev);
  if (t.final) {
    console.log('\n' + col.bold('--- FINAL ---'));
    console.log(t.final.content || t.final.summary);
  }
}

async function* sseEvents(url) {
  for (;;) {
    let res;
    try { res = await fetch(url, { headers: { accept: 'text/event-stream' } }); } catch (e) {
      process.stderr.write(col.yellow(`[watch] server unreachable (${e.cause?.code || e.message}); retrying in 3s\n`));
      await new Promise((r) => setTimeout(r, 3000)); continue;
    }
    const dec = new TextDecoder(); let buf = '';
    try {
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          let ev = 'message', data = '';
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) ev = line.slice(6).trim();
            else if (line.startsWith('data:')) data += line.slice(5).trim();
          }
          if (data) yield { event: ev, data: JSON.parse(data) };
        }
      }
    } catch { /* dropped */ }
    process.stderr.write(col.yellow('[watch] stream ended; reconnecting\n'));
    await new Promise((r) => setTimeout(r, 1500));
    const u = new URL(url); u.searchParams.set('since', String(lastSeq)); u.searchParams.set('backlog', '100000'); url = u.toString();
  }
}
let lastSeq = 0;

async function watch(taskId, opts) {
  const r = new Renderer({ showArgs: opts.args, compact: opts.compact });
  const u = new URL(API + '/stream');
  if (taskId) u.searchParams.set('task_id', taskId);
  u.searchParams.set('backlog', String(opts.backlog ?? (taskId ? 100000 : 300)));
  console.log(col.gray(`watching ${taskId || 'all tasks'} — ${API.replace('/api', '/')} — Ctrl-C to stop`));
  for await (const { event, data } of sseEvents(u.toString())) {
    if (event === 'ready') { console.log(col.gray('──── live ────')); continue; }
    if (data.seq <= lastSeq) continue;
    lastSeq = data.seq;
    r.event(data);
  }
}

function printFinal(t) {
  const f = t.final;
  if (!f) return;
  if (f.source === 'page') console.log(f.content);
  else console.log(f.content ? `${f.summary}\n\n${f.content}` : f.summary);
  const extra = [];
  if (f.source === 'page') extra.push('answer: last reply on the page (the model did not call report)');
  if (f.tests) extra.push(`tests: ${f.tests}`);
  const calls = t.tool_calls ? `${t.tool_calls} tool calls${t.denied_calls ? `, ${t.denied_calls} denied` : ''}` : '';
  if (calls) extra.push(calls);
  if (t.tool_summary?.length) extra.push(`what it did on this computer:\n${t.tool_summary.map((x) => '  ' + x).join('\n')}`);
  if (t.files_changed?.length) extra.push(`files changed:\n${t.files_changed.map((x) => '  ' + x).join('\n')}`);
  if (t.conflicts?.length) extra.push(`conflicts:\n${t.conflicts.map((c) => `  ${c.path}: ${c.message}`).join('\n')}`);
  if (t.chat_url) extra.push(`chat: ${t.chat_url}`);
  if (t.account && t.account !== 'default') extra.push(`account: ${t.account}`);
  extra.push(`task: ${t.id}`);
  console.log('\n---\n' + extra.join('\n'));
}

async function waitFinal(id, timeoutSec, { quiet = false } = {}) {
  const deadline = Date.now() + timeoutSec * 1000;
  let t = await api(`/tasks/${id}`);
  while (!t.final && Date.now() < deadline && !['failed', 'abandoned', 'interrupted', 'cancelled'].includes(t.status)) {
    t = await api(`/tasks/${id}/wait?wait=50&reports=${t.reports.length}`);
    if (!quiet) for (const rep of t.reports.slice(-1)) if (rep.status === 'progress' && rep !== waitFinal._last?.[id]) { process.stderr.write(col.gray(`[progress] ${rep.summary}\n`)); (waitFinal._last ||= {})[id] = rep; }
  }
  return t;
}

async function handleAccountCmd(sub, rest, flags) {
  if (!sub || sub === 'list') {
    const res = await tryApi('/accounts');
    const list = res?.__unreachable
      ? accountsMod.resolveAccounts(loadConfig()).map((a) => ({ ...a, browser: null, quota: null }))
      : res.accounts;
    if (flags.json) {
      console.log(JSON.stringify(res?.__unreachable ? { default_account: accountsMod.defaultAccountName(loadConfig()), accounts: list } : res, null, 2));
      return;
    }
    for (const a of list) {
      const tags = [a.is_default ? 'default' : null, a.enabled ? 'enabled' : 'disabled'].filter(Boolean).join(', ');
      const br = a.browser ? (a.browser.running ? `${a.browser.mode} (${a.browser.tab_count}t)` : 'down') : 'unknown';
      const today = a.quota ? Object.entries(a.quota).filter(([, q]) => q.supported).map(([s, q]) => `${s}:${q.used_today}/${q.daily_limit || '∞'}`).join(' ') : '';
      console.log(`${pad(a.name, 14)} ${pad(`[${tags}]`, 20)} ${pad(a.cdp_url, 23)} sites=${pad(a.sites.join(','), 15)} c=${a.concurrency} br=${br}${today ? `  today(${today})` : ''}  ${a.profile_dir}`);
    }
    return;
  }
  if (sub === 'add') {
    const name = rest[0];
    if (!name) { console.error('usage: webhub account add <name> [--sites gemini,chatgpt] [--port N] [--label TEXT] [--concurrency N] [--daily-limit N]'); process.exit(2); }
    const payload = {
      name,
      ...(flags.label !== undefined ? { label: flags.label } : {}),
      ...(flags.sites !== undefined ? { sites: flags.sites } : {}),
      ...(flags.port !== undefined ? { port: Number(flags.port) } : {}),
      ...(flags.concurrency !== undefined ? { concurrency: Number(flags.concurrency) } : {}),
      ...(flags.dailyLimit !== undefined ? { daily_limit: Number(flags.dailyLimit) } : {}),
    };
    const res = await tryApi('/accounts', { method: 'POST', body: payload });
    let acct;
    if (res?.__unreachable) {
      const le = await import(path.join(SRC, 'login-external.js'));
      const cfgNow = loadConfig();
      try { acct = await le.withLoginLock(cfgNow, { account: String(name).toLowerCase(), site: 'account-edit' }, async () => accountsMod.upsertAccountInConfig(cfgNow, name, payload)); } catch (e) { console.error(`webhub: ${e.message}`); process.exit(1); }
    } else acct = res.account;
    console.log(`account "${acct.name}" ready (CDP ${acct.cdp_url}, sites ${acct.sites.join(',')}, profile ${acct.profile_dir})`);
    console.log(`Next: sign in once with: ${acct.sites.map((s) => `webhub login ${s} --account ${acct.name}`).join('  |  ')}`);
    return;
  }
  if (sub === 'remove' || sub === 'rm' || sub === 'delete') {
    const name = rest[0];
    if (!name) { console.error('usage: webhub account remove <name> [--purge] [--force]'); process.exit(2); }
    const q = new URLSearchParams();
    if (flags.purge) q.set('purge', '1');
    if (flags.force) q.set('force', '1');
    const qs = q.toString() ? `?${q.toString()}` : '';
    const le = await import(path.join(SRC, 'login-external.js'));
    let res = await tryApi(`/accounts/${encodeURIComponent(name)}${qs}`, { method: 'DELETE' });
    if (res?.__unreachable) {
      const cfgNow = loadConfig();
      const doRemove = async () => {
        const { stopDedicated } = await import(path.join(SRC, 'browser.js'));
        await stopDedicated(accountsMod.cfgForAccount(cfgNow, name), name).catch(() => {});
        const removed = accountsMod.removeAccountFromConfig(cfgNow, name);
        if (flags.purge && removed.profile_dir) fs.rmSync(removed.profile_dir, { recursive: true, force: true });
        return { purged: flags.purge ? await le.purgeAccountLogin(cfgNow, removed.name, { locked: true }).catch((e) => ({ profile: false, partition: false, error: e.message })) : null };
      };
      try { res = await le.withLoginLock(cfgNow, { account: String(name).toLowerCase(), purge: !!flags.purge }, doRemove); } catch (e) { console.error(`webhub: ${e.message}`); process.exit(1); }
    }
    const pg = res?.purged;
    const pgOk = !flags.purge || !!(pg && pg.profile && pg.partition); // unknown counts as not cleared
    console.log(`removed account "${name}"${flags.purge ? (pgOk ? ' (profile purged)' : ' (dedicated profile purged; see warning)') : ' (profile kept)'}`);
    if (flags.purge && !pgOk) console.error(`warning: sign-in leftovers not confirmed cleared — sign-in profile ${pg?.profile ? 'removed' : 'NOT removed'}, app partition ${pg?.partition ? 'cleared' : (pg?.app_running ? 'NOT cleared' : 'NOT cleared (the Web AI Hub app is not running; its stored cookies for this account remain until it is cleared)')}${pg?.error ? `: ${pg.error}` : ''}`);
    return;
  }
  if (sub === 'enable' || sub === 'disable') {
    const name = rest[0];
    if (!name) { console.error(`usage: webhub account ${sub} <name>`); process.exit(2); }
    const enabled = sub === 'enable';
    const res = await tryApi(`/accounts/${encodeURIComponent(name)}/toggle`, { method: 'POST', body: { enabled } });
    if (res?.__unreachable) accountsMod.setAccountEnabledInConfig(loadConfig(), name, enabled);
    console.log(`account "${name}" ${enabled ? 'enabled' : 'disabled'}`);
    return;
  }
  if (sub === 'default') {
    const name = rest[0];
    if (!name) { console.error('usage: webhub account default <name>'); process.exit(2); }
    const res = await tryApi('/accounts/default', { method: 'POST', body: { name } });
    if (res?.__unreachable) accountsMod.setDefaultAccountInConfig(loadConfig(), name);
    console.log(`default account set to "${name}"`);
    return;
  }
  console.error('usage: webhub account [list|add <name>|remove <name>|enable <name>|disable <name>|default <name>]');
  process.exit(2);
}

// ---------------- argv ----------------
const argv = process.argv.slice(2);
const flags = {
  args: false, compact: false, wait: true, timeout: null, json: false, probe: false, interval: 2,
  from: process.env.WEBHUB_FROM || process.env.GEMWEB_FROM || os.userInfo().username,
  driver: process.env.GEMWEB_DRIVER || undefined,
};
const pos = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '-f' || a === '--file') flags.file = argv[++i];
  else if (a === '--chat') flags.chat = argv[++i];
  else if (a === '--from') flags.from = argv[++i];
  else if (a === '--timeout') flags.timeout = Number(argv[++i]);
  else if (a === '--title') flags.title = argv[++i];
  else if (a === '--model') flags.model = argv[++i];
  else if (a === '--effort') flags.effort = argv[++i];
  else if (a === '--allow-pro') flags.allowPro = true;
  else if (a === '--dry-run') flags.dryRun = true;
  else if (a === '--date') flags.date = argv[++i];
  else if (a === '--backlog') flags.backlog = Number(argv[++i]);
  else if (a === '--interval') flags.interval = Math.max(0.5, Number(argv[++i]) || 2);
  else if (a === '--json') flags.json = true;
  else if (a === '--probe') flags.probe = true;
  else if (a === '--args') flags.args = true;
  else if (a === '--compact') flags.compact = true;
  else if (a === '--no-wait') flags.wait = false;
  else if (a === '--wait') flags.waitResult = true;
  else if (a === '--keep-tab') flags.keepTab = true;
  else if (a === '--no-operator') flags.noOperator = true;
  else if (a === '--force') flags.force = true;
  else if (a === '--check') flags.check = true;
  else if (a === '--purge') flags.purge = true;
  else if (a === '--all') flags.all = true;
  else if (a === '--driver') flags.driver = argv[++i];
  else if (a === '--browser') flags.browser = argv[++i];
  else if (a === '--cwd') flags.cwd = path.resolve(argv[++i]);
  else if (a === '-a' || a === '--account') { flags.account = argv[++i]; if (!flags.account || flags.account.startsWith('-')) { console.error('webhub: --account needs an account name'); process.exit(2); } }
  else if (a.startsWith('--account=')) { flags.account = a.slice(10); if (!flags.account) { console.error('webhub: --account needs an account name'); process.exit(2); } }
  else if (a === '--sites') flags.sites = argv[++i];
  else if (a === '--port') flags.port = argv[++i];
  else if (a === '--label') flags.label = argv[++i];
  else if (a === '--concurrency') flags.concurrency = argv[++i];
  else if (a === '--daily-limit') flags.dailyLimit = argv[++i];
  else if (a === '--backend' || a === '-b') flags.backend = argv[++i];
  else if (a === '--session' || a === '-s') flags.session = argv[++i];
  else if (a === '--result-file') flags.resultFile = argv[++i];
  else if (a === '--watch') flags.watch = true;
  else if (a === '--answers') flags.answers = true;
  else if (a === '--planner') flags.planner = argv[++i];
  else if (a === '--workers') flags.workers = argv[++i];
  else if (a === '--max-tasks') flags.maxTasks = Number(argv[++i]);
  else if (a === '--run') flags.run = true;
  else if (a === '--synth') flags.synth = argv[++i];
  else if (a === '--fallback') flags.fallback = argv[++i];
  else if (a === '--retries') flags.retries = Number(argv[++i]);
  else if (a === '--goal') flags.goal = argv[++i];
  else if (a === '--operator') flags.operator = true;
  else if (a === '--system') flags.system = argv[++i];
  else if (a === '--site') { flags.site = argv[++i]; if (!['gemini', 'chatgpt'].includes(flags.site)) { console.error('webhub: --site is gemini or chatgpt'); process.exit(2); } }
  else if (a === '-h' || a === '--help') {
    const src = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n');
    console.log(src.slice(1, src.findIndex((l) => l.startsWith('import'))).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    process.exit(0);
  } else pos.push(a);
}

const cmd = pos[0];
const SERVICE_CMDS = new Set(['install', 'uninstall', 'start', 'stop', 'restart', 'status', 'url', 'secrets', 'logs', 'named', 'quick']);

try {
  if (!cmd && !flags.file) {
    const s = await api('/state' + (flags.probe ? '?probe=1' : ''));
    console.log(flags.json ? JSON.stringify(s, null, 2) : formatPs(s, flags.account || null));
  } else if (SERVICE_CMDS.has(cmd)) {
    const r = spawnSync(path.join(HERE, 'gwmcp'), argv, { stdio: 'inherit' });
    process.exit(r.status ?? 1);
  } else if (cmd === 'account') {
    await handleAccountCmd(pos[1], pos.slice(2), flags);
  } else if (cmd === 'ps') {
    const s = await api('/state' + (flags.probe ? '?probe=1' : ''));
    if (!s.swarms) { const sw = await import(path.join(SRC, 'swarm.js')); s.swarms = sw.listSwarms().slice(0, 10).map((x) => sw.swarmSummary(x)); }
    console.log(flags.json ? JSON.stringify(s, null, 2) : formatPs(s, flags.account || null));
  } else if (cmd === 'top') {
    let running = true;
    process.on('SIGINT', () => { running = false; process.exit(0); });
    process.on('SIGTERM', () => { running = false; process.exit(0); });
    while (running) {
      const s = await api('/state' + (flags.probe ? '?probe=1' : ''));
      process.stdout.write('\x1b[2J\x1b[H' + formatPs(s, flags.account || null) + `\n\n${col.gray(`refreshing every ${flags.interval}s — Ctrl-C to exit`)}`);
      await new Promise((r) => setTimeout(r, flags.interval * 1000));
    }
  } else if (cmd === 'watch') {
    await watch(pos[1], flags);
  } else if (cmd === 'trace') {
    if (!pos[1]) { console.error('usage: webhub trace <task_id> [--json]'); process.exit(2); }
    await runTrace(pos[1], flags.json);
  } else if (cmd === 'list') {
    const ts = await api('/tasks');
    for (const t of ts.slice(0, 30)) console.log(`${t.id.padEnd(15)} ${(t.account || 'default').padEnd(10)} ${(t.site || 'gemini').padEnd(8)} ${t.status.padEnd(12)} ${String(t.tool_calls).padStart(3)} calls  ${(t.from || '').padEnd(12)} ${t.title}`);
  } else if (cmd === 'cancel') {
    if (!pos[1]) { console.error('usage: webhub cancel <task_id>'); process.exit(2); }
    const r = await api(`/tasks/${encodeURIComponent(pos[1])}/cancel`, { method: 'POST', body: {} });
    console.log(`cancelled ${r.task_id}: killed ${r.killed_jobs?.length || 0} job(s), closed ${r.closed_tabs || 0} tab(s)`);
  } else if (cmd === 'kill') {
    if (!pos[1]) { console.error('usage: webhub kill <job_id|agent_id>'); process.exit(2); }
    const id = pos[1];
    if (id.startsWith('ag_')) {
      const r = await api(`/agents/${encodeURIComponent(id)}/stop`, { method: 'POST', body: {} });
      console.log(r.ok ? `stopped agent ${id}` : `agent ${id} not running`);
    } else {
      const r = await api(`/jobs/${encodeURIComponent(id)}/kill`, { method: 'POST', body: {} });
      console.log(r.ok ? `killed job ${id}` : `job ${id} not running`);
    }
  } else if (cmd === 'approve' || cmd === 'deny') {
    if (!pos[1]) { console.error('usage: webhub approve|deny <confirm_id>'); process.exit(2); }
    const r = await api(`/confirm/${pos[1]}`, { method: 'POST', body: { approve: cmd === 'approve' } });
    console.log(r.ok ? `${cmd}d ${pos[1]}` : `no pending approval ${pos[1]}`);
  } else if (cmd === 'limit') {
    if (pos[1] === 'clear') {
      const r = await api('/web-limit/clear', { method: 'POST', body: { site: pos[2] || flags.site, account: flags.account || null } });
      console.log(r.ok ? 'usage-limit pause cleared' : 'no usage-limit pause was set');
    } else {
      const s = await api('/state');
      for (const a of (s.accounts || [])) {
        if (flags.account && a.name !== flags.account) continue;
        for (const [name, q] of Object.entries(a.quota || {})) {
          if (!q.supported) continue;
          console.log(`[${a.name}] ${name}: today ${q.used_today}/${q.daily_limit || '∞'} tasks sent; ${q.limit ? `paused until ${q.limit.until}: ${q.limit.notice}` : 'no usage-limit pause'}`);
        }
      }
    }
  } else if (cmd === 'browser') {
    const sub = pos[1] || 'status';
    if (sub === 'tabs') {
      const q = new URLSearchParams();
      if (flags.probe) q.set('probe', '1');
      if (flags.account) q.set('account', flags.account);
      const br = await api('/browser/tabs' + (q.toString() ? `?${q.toString()}` : ''));
      if (flags.json) { console.log(JSON.stringify(br, null, 2)); }
      else {
        console.log(`browser: ${br.running ? `${br.mode} · ${br.tab_count} total tabs` : 'down'}`);
        for (const tb of br.tabs || []) {
          console.log(`  ${tb.target_id.slice(0, 10)}  ${pad(tb.account || 'default', 10)} ${pad(tb.site, 8)} ${pad(tb.mode, 7)} ${pad(tb.stage, 15)} ${pad(tb.task_id || '—', 14)} ${tb.title || tb.url}`);
        }
      }
    } else if (sub === 'open') {
      const target = pos[2] || 'monitor';
      const body = /^https?:\/\//i.test(target) ? { url: target } : { site: target };
      if (flags.account) body.account = flags.account;
      const r = await api('/browser/open', { method: 'POST', body });
      console.log(`opened ${r.url} in [${r.account || 'default'}] (tab ${r.target_id || '?'})`);
    } else if (sub === 'focus') {
      if (!pos[2]) { console.error('usage: webhub browser focus <target_id>'); process.exit(2); }
      const br = await api('/browser/tabs');
      const hit = (br.tabs || []).find((t) => (t.target_id === pos[2] || t.target_id.startsWith(pos[2])) && (!flags.account || t.account === flags.account));
      if (!hit) { console.error(`tab "${pos[2]}" not found`); process.exit(2); }
      await api('/browser/focus', { method: 'POST', body: { target_id: hit.target_id, account: hit.account } });
      console.log(`focused ${hit.target_id} [${hit.account || 'default'}] (${hit.title || hit.url})`);
    } else if (sub === 'close') {
      if (!pos[2]) { console.error('usage: webhub browser close <target_id>'); process.exit(2); }
      const br = await api('/browser/tabs');
      const hit = (br.tabs || []).find((t) => (t.target_id === pos[2] || t.target_id.startsWith(pos[2])) && (!flags.account || t.account === flags.account));
      if (!hit) { console.error(`tab "${pos[2]}" not found`); process.exit(2); }
      await api('/browser/close', { method: 'POST', body: { target_id: hit.target_id, account: hit.account } });
      console.log(`closed ${hit.target_id} [${hit.account || 'default'}]`);
    } else {
      const { loginCli } = await import(path.join(SRC, 'login.js'));
      const fwd = pos.slice(1);
      if (flags.force) fwd.push('--force');
      if (flags.check) fwd.push('--check');
      if (flags.all) fwd.push('--all');
      if (flags.account) fwd.push('--account', flags.account);
      if (flags.site) fwd.push('--site', flags.site);
      if (flags.timeout) fwd.push('--timeout', String(flags.timeout));
      process.exit(await loginCli(fwd, { cfg: loadConfig(), api, account: flags.account || null }));
    }
  } else if (cmd === 'login') {
    const { loginCli } = await import(path.join(SRC, 'login.js'));
    const fwd = ['login', ...pos.slice(1)];
    if (flags.force) fwd.push('--force');
    if (flags.account) fwd.push('--account', flags.account);
    process.exit(await loginCli(fwd, { cfg: loadConfig(), api, account: flags.account || null }));
  } else if (cmd === 'goal') {
    const { goalCli } = await import(path.join(SRC, 'goals.js'));
    process.exit(await goalCli(pos.slice(1), { argv, api, cfg: loadConfig(), gemwebPath: path.join(HERE, 'gemweb.mjs') }));
  } else if (cmd === 'ask') {
    const { askCli } = await import(path.join(SRC, 'ask.js'));
    process.exit(await askCli(pos.slice(1), flags));
  } else if (cmd === 'swarm') {
    const { swarmCli } = await import(path.join(SRC, 'swarm.js'));
    process.exit(await swarmCli(pos.slice(1), flags));
  } else if (cmd === 'session' || cmd === 'sessions') {
    const { sessionCli } = await import(path.join(SRC, 'sessions.js'));
    process.exit(await sessionCli(pos.slice(1), flags));
  } else if (cmd === 'targets' || cmd === 'models') {
    const { aliases } = await import(path.join(SRC, 'targets.js'));
    const { agentCfg } = await import(path.join(SRC, 'agents.js'));
    const c = loadConfig();
    const out = { web: ['web:gemini[:MODEL[:low|medium|high]]', 'web:chatgpt[:MODEL[:EFFORT]]'], gateway: Object.keys(c.gateways || {}).length ? Object.keys(c.gateways).map((g) => `gateway${g === 'default' ? '' : '@' + g}:MODEL`) : (process.env.TABSWARM_GATEWAY_URL ? ['gateway:MODEL'] : []), agents: Object.keys(agentCfg(c).commands).filter((b) => agentCfg(c).backends.includes(b)), aliases: aliases(c) };
    console.log(flags.json ? JSON.stringify(out, null, 2) : Object.entries(out).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') || '(none configured)' : Object.entries(v).map(([a, b]) => `${a} → ${b}`).join(', ')}`).join('\n'));
  } else if (cmd === '__drive') {
    apiRetrySec = 90;
    const t = await api(`/tasks/${pos[1]}`);
    const { drive } = await import(path.join(SRC, 'driver.js'));
    process.exit(await drive({ id: t.id, task: t.prompt, cwd: t.cwd || null, site: t.site || flags.site || 'gemini', account: t.account || flags.account || null, flags, api, waitFinal, printFinal, cfg: loadConfig(), timeoutSec: flags.timeout || 1800 }));
  } else if (cmd === 'result') {
    if (!pos[1]) { console.error('usage: webhub result <task_id> [--wait]'); process.exit(2); }
    const t = flags.waitResult ? await waitFinal(pos[1], flags.timeout || 1800) : await api(`/tasks/${pos[1]}`);
    if (!t.final) { console.error(`webhub: no final report yet (status ${t.status})`); process.exit(4); }
    t.tool_summary = await (await import(path.join(SRC, 'driver.js'))).toolSummary(api, t.id);
    printFinal(t); process.exit(t.final.status === 'final' ? 0 : 3);
  } else {
    const taskWords = cmd === 'run' ? pos.slice(1) : pos;
    const task = flags.file ? fs.readFileSync(flags.file, 'utf8') : taskWords.join(' ');
    if (!task.trim()) { console.error('webhub: empty task (see webhub --help)'); process.exit(2); }
    apiRetrySec = 90;
    const { dispatch } = await import(path.join(SRC, 'driver.js'));
    const code = await dispatch({ task, flags, api, waitFinal, printFinal, cfg: loadConfig(), secrets });
    process.exit(code);
  }
} catch (e) {
  console.error(`webhub: ${e.message}`);
  process.exit(e.status === 404 ? 2 : 1);
}
