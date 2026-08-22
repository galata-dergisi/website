#!/usr/bin/env node
// Copyright 2026 Mehmet Baker
//
// Fail closed if the retired Node application or timed fallback returns.

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const self = path.relative(repoRoot, __filename);
const packageJson = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
);

function gitFiles(args) {
  const output = childProcess.execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return output.split('\0').filter(Boolean);
}

const deleted = new Set(gitFiles(['ls-files', '--deleted', '-z']));
const tracked = [
  ...gitFiles(['ls-files', '-z']).filter((filename) => !deleted.has(filename)),
  ...gitFiles(['ls-files', '--others', '--exclude-standard', '-z']),
];
const failures = [];
const productionNginxPath = path.join(
  repoRoot,
  'ops/nginx/galatadergisi.org.conf',
);
const sharedNginxPath = path.join(repoRoot, 'ops/nginx/galata-shared.conf');
const devNginxPath = path.join(repoRoot, 'ops/nginx/dev.galatadergisi.org.conf');
const securityHeadersPath = path.join(
  repoRoot,
  'ops/nginx/galata-security-headers.conf',
);
const productionCspPath = path.join(
  repoRoot,
  'ops/nginx/galata-production-csp.conf',
);
const devCspPath = path.join(repoRoot, 'ops/nginx/galata-dev-csp.conf');
const nginxLogrotatePath = path.join(repoRoot, 'ops/logrotate/galata-nginx');
const serverSetupPath = path.join(repoRoot, 'ops/setup-server.sh');
const productionServerPath = path.join(repoRoot, 'cmd/galata-server/main.go');
const developmentServerPath = path.join(repoRoot, 'cmd/galata-dev/main.go');
const retiredCaptchaProduct = ['re', 'captcha'].join('');

const forbiddenPaths = [
  'server/',
  'client/vendor/turnjs/',
  'client/pages/contribute/',
  'client/lib/contribution-file-policy.mjs',
  'internal/contributions/',
  'ops/zap/check-turnstile-contract.sh',
  '.github/workflows/deploy-client.yml',
  'config.example.js',
];
forbiddenPaths.forEach((forbidden) => {
  const matched = tracked.some((filename) => (
    forbidden.endsWith('/')
      ? filename.startsWith(forbidden)
      : filename === forbidden
  ));
  if (matched) failures.push(`retired path is tracked: ${forbidden}`);
});

const runtimeDependencies = Object.keys(packageJson.dependencies || {}).sort();
if (
  runtimeDependencies.length !== 1
  || runtimeDependencies[0] !== 'svelte'
) {
  failures.push('package.json runtime dependencies must contain only Svelte');
}

[
  'server',
  'start',
  'start:dev',
  'start:dev-svc',
  'dev-svc',
  'seo:report',
  'seo:summary',
  'seo:apply',
].forEach((command) => {
  if (packageJson.scripts && packageJson.scripts[command]) {
    failures.push(`retired package command exists: ${command}`);
  }
});

const productionServer = fs.readFileSync(productionServerPath, 'utf8');
const developmentServer = fs.readFileSync(developmentServerPath, 'utf8');
if (/internal\/contributions|TURNSTILE|CONTRIBUTIONS_DIR/.test(
  `${productionServer}\n${developmentServer}`,
)) {
  failures.push('retired submission runtime remains in a Go server');
}

const forbiddenSource = [
  { label: 'Express import', pattern: /require\(['"]express['"]\)|from ['"]express['"]/ },
  { label: 'Google Drive client', pattern: /require\(['"]googleapis['"]\)|from ['"]googleapis['"]/ },
  { label: 'SMTP client', pattern: /require\(['"]nodemailer['"]\)|from ['"]nodemailer['"]/ },
  { label: 'Multer import', pattern: /require\(['"]multer['"]\)|from ['"]multer['"]/ },
  { label: 'runtime UUID import', pattern: /require\(['"]uuid['"]\)|from ['"]uuid['"]/ },
  {
    label: 'jQuery CDN dependency',
    pattern: /cdnjs\.cloudflare\.com\/ajax\/libs\/jquery\//i,
    frontendOnly: true,
  },
  {
    label: 'global jQuery usage',
    pattern: /(?:\bwindow\.|\bglobalThis\.)jQuery\b|\bjQuery\s*(?:\(|\.)/,
    frontendOnly: true,
  },
  {
    label: 'retired Turn.js import',
    pattern: /(?:import\s+[^;]*?from\s+|import\s*\(|require\s*\()?["'][^"']*(?:vendor\/turnjs\/turn|turn(?:\.min)?\.js)["']/,
    frontendOnly: true,
  },
  {
    label: 'timed cutover language',
    pattern: /\b(?:7|14|seven|fourteen)[- ]days?\b/i,
  },
  { label: 'legacy rollback language', pattern: /\brollback window\b|\blegacy Node server\b/i },
  { label: 'Node server entrypoint', pattern: /server\/server\.js/ },
  {
    label: 'retired CAPTCHA integration',
    pattern: new RegExp(retiredCaptchaProduct, 'i'),
  },
];

tracked.filter((filename) => (
  filename !== self
  && filename !== 'package-lock.json'
  && /\.(?:html|js|mjs|json|md|py|sh|svelte|ya?ml)$/.test(filename)
)).forEach((filename) => {
  const content = fs.readFileSync(path.join(repoRoot, filename), 'utf8');
  forbiddenSource.forEach(({ label, pattern, frontendOnly }) => {
    if (frontendOnly && !filename.startsWith('client/')) return;
    if (pattern.test(content)) failures.push(`${label}: ${filename}`);
  });
});

if (
  !fs.existsSync(productionNginxPath)
  || !fs.existsSync(sharedNginxPath)
  || !fs.existsSync(securityHeadersPath)
  || !fs.existsSync(productionCspPath)
) {
  failures.push('production nginx configuration is missing');
} else {
  const productionNginx = [
    sharedNginxPath,
    securityHeadersPath,
    productionCspPath,
    productionNginxPath,
  ].map((filename) => fs.readFileSync(filename, 'utf8')).join('\n');
  [
    {
      label: 'loopback Go upstream',
      pattern: /^\s*server 127\.0\.0\.1:3000;\s*$/m,
    },
    {
      label: 'Go application proxy',
      pattern: /^\s*proxy_pass http:\/\/galata_server;\s*$/m,
    },
    {
      label: 'external magazine image location',
      pattern: /^\s*location ~ \^\/images\/sayi\[0-9\]\+\/ \{\s*$/m,
    },
    {
      label: 'external magazine audio mapping',
      pattern: /^\s*alias \/var\/www\/galatadergisi\.org\/public\/audio\/\$magazine_index\/\$audio_file;\s*$/m,
    },
    {
      label: 'loopback Cloudflare Tunnel origin listener',
      pattern: /^\s*listen 127\.0\.0\.1:8080;\s*$/m,
    },
    {
      label: 'HTTPS application-facing forwarded scheme',
      pattern: /^\s*proxy_set_header X-Forwarded-Proto https;\s*$/m,
    },
    {
      label: 'notice-enabled nginx error log',
      pattern: /^\s*error_log \/var\/log\/nginx\/galatadergisi\.org\/error\.log notice;\s*$/m,
    },
    {
      label: 'disabled nginx access logging',
      pattern: /^\s*access_log off;\s*$/m,
    },
    {
      label: 'centralized security headers',
      pattern: /include \/etc\/nginx\/snippets\/galata-security-headers\.conf;/,
    },
    {
      label: 'report-only production CSP',
      pattern: /add_header Content-Security-Policy-Report-Only "default-src 'none';/,
    },
    {
      label: 'stripped Cloudflare visitor address',
      pattern: /^\s*proxy_set_header CF-Connecting-IP "";\s*$/m,
    },
    {
      label: 'stripped Cloudflare IPv6 visitor address',
      pattern: /^\s*proxy_set_header CF-Connecting-IPv6 "";\s*$/m,
    },
    {
      label: 'stripped Cloudflare pseudo-IPv4 address',
      pattern: /^\s*proxy_set_header CF-Pseudo-IPv4 "";\s*$/m,
    },
    {
      label: 'stripped enterprise visitor address',
      pattern: /^\s*proxy_set_header True-Client-IP "";\s*$/m,
    },
    {
      label: 'stripped standardized forwarded address',
      pattern: /^\s*proxy_set_header Forwarded "";\s*$/m,
    },
    {
      label: 'stripped real visitor address',
      pattern: /^\s*proxy_set_header X-Real-IP "";\s*$/m,
    },
    {
      label: 'stripped forwarded visitor address',
      pattern: /^\s*proxy_set_header X-Forwarded-For "";\s*$/m,
    },
  ].forEach(({ label, pattern }) => {
    if (!pattern.test(productionNginx)) {
      failures.push(`production nginx configuration lacks ${label}`);
    }
  });

  [
    { label: 'retired Node upstream', pattern: /upstream\s+nodejs\b|proxy_pass\s+http:\/\/nodejs/i },
    { label: 'retired SPA rewrite', pattern: /rewrite\s+\^\s+\/index\.html\s+break;/i },
    {
      label: 'disk-served embedded application assets',
      pattern: /location\s+~\*\s+\\\.\([^\n]*css[^\n]*js[^\n]*\)/i,
    },
    {
      label: 'access-log-changing real-IP rewrite',
      pattern: /\b(?:real_ip_header|set_real_ip_from)\b/,
    },
    {
      label: 'enabled nginx access log',
      pattern: /^\s*access_log\s+(?!off;)[^;]+;/m,
    },
    {
      label: 'enabled limiter dry-run mode',
      pattern: /\blimit_(?:req|conn)_dry_run\s+on;/,
    },
    {
      label: 'retired submission proxy configuration',
      pattern: /client_max_body_size\s+52m|proxy_request_buffering\s+off|galata_(?:dev_)?contribution/,
    },
    {
      label: 'origin TLS configuration',
      pattern: /ssl_certificate|\/etc\/letsencrypt|listen\s+443/,
    },
  ].forEach(({ label, pattern }) => {
    if (pattern.test(productionNginx)) {
      failures.push(`${label} exists in production nginx configuration`);
    }
  });
}

if (!fs.existsSync(devNginxPath) || !fs.existsSync(devCspPath)) {
  failures.push('dev nginx configuration is missing');
} else {
  const devNginx = fs.readFileSync(devNginxPath, 'utf8');
  const devBoundary = fs.existsSync(sharedNginxPath)
    ? [sharedNginxPath, securityHeadersPath, devCspPath]
      .map((filename) => fs.readFileSync(filename, 'utf8'))
      .concat(devNginx).join('\n')
    : devNginx;
  [
    [/server_name dev\.galatadergisi\.org;/, 'exact dev hostname'],
    [/X-Robots-Tag "noindex, nofollow, noarchive"/, 'dev noindex header'],
    [/location = \/robots\.txt \{[\s\S]*Disallow: \//, 'dev robots crawl denial'],
    [/proxy_pass http:\/\/galata_dev_server;/, 'isolated dev upstream'],
    [/\/var\/www\/dev\.galatadergisi\.org\/public/, 'isolated dev media root'],
    [/listen 127\.0\.0\.1:8080;/, 'loopback Cloudflare Tunnel origin listener'],
    [/location = \/healthz \{[\s\S]*Cache-Control "no-store, no-cache, must-revalidate"/, 'non-cacheable dev health'],
    [/include \/etc\/nginx\/snippets\/galata-dev-csp\.conf;/, 'dev CSP include'],
    [/Content-Security-Policy-Report-Only "default-src 'none';/, 'report-only dev CSP'],
  ].forEach(([pattern, label]) => {
    if (!pattern.test(devBoundary)) failures.push(`dev nginx configuration lacks ${label}`);
  });
  if (/\bauth_basic\b/.test(devBoundary)) {
    failures.push('dev nginx configuration contains origin basic authentication');
  }
  if (!/^\s*access_log off;\s*$/m.test(devBoundary)) {
    failures.push('dev nginx configuration lacks disabled nginx access logging');
  }
  if (/^\s*access_log\s+(?!off;)[^;]+;/m.test(devBoundary)) {
    failures.push('enabled nginx access log exists in dev nginx configuration');
  }
}

if (!fs.existsSync(nginxLogrotatePath)) {
  failures.push('nginx error-log rotation policy is missing');
} else {
  const nginxLogrotate = fs.readFileSync(nginxLogrotatePath, 'utf8');
  [
    [
      /^\/var\/log\/nginx\/galatadergisi\.org\/error\.log \/var\/log\/nginx\/dev\.galatadergisi\.org\/error\.log \{$/m,
      'both nginx error logs',
    ],
    [/^\s*daily\s*$/m, 'daily nginx error-log rotation'],
    [/^\s*rotate 30\s*$/m, 'thirty nginx error-log rotations'],
    [/^\s*maxage 30\s*$/m, 'thirty-day nginx error-log maximum age'],
    [/^\s*compress\s*$/m, 'compressed nginx error logs'],
    [/^\s*delaycompress\s*$/m, 'delayed nginx error-log compression'],
    [/^\s*missingok\s*$/m, 'missing nginx error-log tolerance'],
    [/^\s*notifempty\s*$/m, 'empty nginx error-log suppression'],
    [/^\s*create 0640 www-data adm\s*$/m, 'restricted nginx error-log permissions'],
    [/^\s*sharedscripts\s*$/m, 'shared nginx post-rotation hook'],
    [/kill -USR1 "\$\(cat \/run\/nginx\.pid\)"/, 'nginx log-reopen signal'],
  ].forEach(([pattern, label]) => {
    if (!pattern.test(nginxLogrotate)) failures.push(`nginx logrotate policy lacks ${label}`);
  });
}

if (!fs.existsSync(serverSetupPath)) {
  failures.push('Ubuntu server setup script is missing');
} else {
  const serverSetup = fs.readFileSync(serverSetupPath, 'utf8');
  [
    {
      label: 'Ubuntu 26.04 preflight',
      pattern: /\[ "\$\{VERSION_ID:-\}" = 26\.04 \]/,
    },
    {
      label: 'fresh SSH connections',
      pattern: /ControlMaster=no[^\n]*ControlPath=none[^\n]*ControlPersist=no/,
    },
    {
      label: 'signed stable cloudflared APT repository',
      pattern: /https:\/\/pkg\.cloudflare\.com\/cloudflared any main/,
    },
    {
      label: 'root SSH denial',
      pattern: /^PermitRootLogin no$/m,
    },
    {
      label: 'key-only SSH authentication',
      pattern: /^AuthenticationMethods publickey$/m,
    },
    {
      label: 'minimum token-file-capable cloudflared version',
      pattern: /dpkg --compare-versions "\$version" ge 2025\.4\.0/,
    },
    {
      label: 'non-remediating CIS audit',
      pattern: /usg audit cis_level1_server/,
    },
    {
      label: 'inactive application service condition',
      pattern: /ConditionFileIsExecutable=\/opt\/galata\/current\/galata-server/,
    },
    {
      label: 'prompted administrator username',
      pattern: /printf 'Administrator username: '/,
    },
    {
      label: 'administrator username validation',
      pattern: /validate_admin_user\(\)/,
    },
  ].forEach(({ label, pattern }) => {
    if (!pattern.test(serverSetup)) failures.push(`server setup lacks ${label}`);
  });

  [
    { label: 'disabled SSH host-key checking', pattern: /StrictHostKeyChecking=no/ },
    { label: 'destructive UFW reset', pattern: /ufw(?:\s+--force)?\s+reset/ },
    { label: 'automatic CIS remediation', pattern: /usg\s+fix/ },
    { label: 'Cloudflare address-range lookup', pattern: /cloudflare\.com\/ips-v[46]/ },
    { label: 'inbound HTTPS firewall allow', pattern: /ufw allow from[^\n]*port 443/ },
    { label: 'production nginx vhost activation', pattern: /sites-enabled\/galatadergisi\.org/ },
    { label: 'hard-coded administrator username', pattern: /ADMIN_USER=mehmet/ },
  ].forEach(({ label, pattern }) => {
    if (pattern.test(serverSetup)) failures.push(`${label} exists in server setup`);
  });

  const runtimeFoundation = serverSetup.indexOf('  install_runtime_foundation\n');
  const finalSSHPolicy = serverSetup.indexOf('  install_final_ssh_policy\n');
  if (
    runtimeFoundation === -1
    || finalSSHPolicy === -1
    || finalSSHPolicy < runtimeFoundation
  ) {
    failures.push('server setup does not leave root SSH denial as the final mutation');
  }
}

if (failures.length) {
  failures.forEach((failure) => process.stderr.write(`${failure}\n`));
  process.exit(1);
}

process.stdout.write('Runtime boundary verified: Go is the only application server.\n');
