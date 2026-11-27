// Dangerous-command policy. Returns the strictest verdict among all matching rules.
//   deny    -> always refused
//   confirm -> dangerous_policy "auto": runs after a safety snapshot (src/safety.js), logged;
//              "confirm": needs approval on the local status page; "deny": refused
//   allow   -> runs (still inside the sandbox)

const HARD_DENY = [
  [/(^|[\s;&|(`$])sudo(\s|$)/, 'sudo'],
  [/(^|[\s;&|(`$])(su|doas)\s/, 'switch user'],
  [/(^|[\s;&|(])mkfs(\.|\s)/, 'mkfs'],
  [/\bdd\b[^\n]*\bof=\/dev\//, 'dd to a device'],
  [/(^|[\s;&|(])(shutdown|reboot|halt)(\s|$)/, 'shutdown/reboot'],
  [/(^|[\s;&|(])(csrutil|nvram|spctl|bless)(\s|$)/, 'system security settings'],
  [/\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[rR][a-zA-Z]*\s+(-[a-zA-Z]+\s+)*(\/|~|\$HOME|\/\*|~\/\*?)(\s|$)/, 'rm -r on / or home'],
  [/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, 'fork bomb'],
  [/\bchmod\s+(-R\s+)?[0-7]*777\s+\/(\s|$)/, 'chmod 777 /'],
  [/security\s+(find|dump|export)-/, 'keychain access'],
];

const CONFIRM = [
  [/\brm\s+((-[a-zA-Z]*[rR][a-zA-Z]*)|(--recursive))/, 'recursive rm'],
  [/\brm\s+(-[a-zA-Z]*f[a-zA-Z]*)/, 'forced rm'],
  [/\bgit\s+(-C\s+\S+\s+)?push\b/, 'git push'],
  [/\bgit\s+(-C\s+\S+\s+)?reset\s+--hard\b/, 'git reset --hard'],
  [/\bgit\s+(-C\s+\S+\s+)?clean\s+-[a-zA-Z]*f/, 'git clean -f'],
  [/\bgit\s+(-C\s+\S+\s+)?(branch\s+-D|push\s+--force|checkout\s+--\s+\.|restore\s+\.|stash\s+(drop|clear))/, 'destructive git'],
  [/\bgit\s+(-C\s+\S+\s+)?config\s+--(global|system)\b/, 'git global config'],
  [/(^|[\s;&|(])(launchctl|systemctl|service|scutil|networksetup|pfctl|defaults\s+(write|delete)|pmset|diskutil|hdiutil|kextload|crontab|chsh|dscl|sysadminctl|softwareupdate|installer)(\s|$)/, 'system configuration'],
  [/(^|[\s;&|(])(kill|killall|pkill)(\s|$)/, 'kill processes'],
  [/(>|tee\s+(-a\s+)?)\s*\/(etc|Library|System|usr|bin|sbin|private\/etc|opt\/homebrew\/etc)\//, 'write to system path'],
  [/\b(curl|wget)\b[^|\n]*\|\s*(sudo\s+)?(ba|z|fi)?sh\b/, 'pipe download to shell'],
  [/(^|[\s;&|(])(brew|port)\s+(install|uninstall|remove|upgrade|services)/, 'package manager change'],
  [/(^|[\s;&|(])npm\s+(-g|i\s+-g|install\s+-g|publish)/, 'global npm / publish'],
  [/(^|[\s;&|(])pip3?\s+install\b(?![^\n]*(--user|-t\s|--target|venv|\.venv))/, 'pip install outside a venv'],
  [/(^|[\s;&|(])(ssh|scp|sftp|rsync)\s/, 'remote shell / copy'],
  [/(^|[\s;&|(])(chmod|chown)\s+-R\b/, 'recursive permission change'],
  [/(^|[\s;&|(])(docker|podman)\s+(rm|rmi|system\s+prune|volume\s+rm)/, 'container removal'],
  [/\bfind\b[^\n]*\s-delete\b/, 'find -delete'],
  [/(^|[\s;&|(])(osascript|open)\s/, 'GUI automation / open apps'],
  [/\bcloudflared\b|\btailscale\b/, 'tunnel / network exposure'],
];

export function classifyCommand(cmd) {
  const reasons = [];
  let level = 'allow';
  const text = String(cmd || '');
  for (const [re, why] of HARD_DENY) if (re.test(text)) { level = 'deny'; reasons.push(why); }
  if (level !== 'deny') {
    for (const [re, why] of CONFIRM) if (re.test(text)) { level = 'confirm'; reasons.push(why); }
  }
  return { level, reasons };
}
