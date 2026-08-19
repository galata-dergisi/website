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
const serverSetupPath = path.join(repoRoot, 'ops/setup-server.sh');
const productionServerPath = path.join(repoRoot, 'cmd/galata-server/main.go');
const developmentServerPath = path.join(repoRoot, 'cmd/galata-dev/main.go');
const retiredCaptchaProduct = ['re', 'captcha'].join('');

const forbiddenPaths = [
  'server/',
  'client/vendor/turnjs/',
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
if (!/MaxConcurrent:\s*8,/.test(productionServer)) {
  failures.push('production contribution concurrency cap is not eight');
}
const developmentServer = fs.readFileSync(developmentServerPath, 'utf8');
if (/MaxConcurrent:/.test(developmentServer)) {
  failures.push('development contribution concurrency must use the unlimited default');
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

if (!fs.existsSync(productionNginxPath) || !fs.existsSync(sharedNginxPath)) {
  failures.push('production nginx configuration is missing');
} else {
  const productionNginx = `${fs.readFileSync(sharedNginxPath, 'utf8')}\n${fs.readFileSync(productionNginxPath, 'utf8')}`;
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
      label: 'contribution request limit',
      pattern: /^\s*client_max_body_size 52m;\s*$/m,
    },
    {
      label: 'streamed contribution requests',
      pattern: /^\s*proxy_request_buffering off;\s*$/m,
    },
    {
      label: 'tunnel visitor address with local fallback',
      pattern: new RegExp([
        String.raw`^map \$http_cf_connecting_ip \$galata_client_address \{`,
        String.raw`\s*\n\s*default \$http_cf_connecting_ip;`,
        String.raw`\s*\n\s*"" \$remote_addr;\s*\n\}$`,
      ].join(''), 'm'),
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
      label: 'exact contribution POST limiter key',
      pattern: new RegExp([
        String.raw`^map "\$request_method:\$uri" \$galata_contribution_client_key \{`,
        String.raw`\s*\n\s*default "";`,
        String.raw`\s*\n\s*"POST:/katkida-bulunun" \$galata_client_address;\s*\n\}$`,
      ].join(''), 'm'),
    },
    {
      label: 'one-request-per-minute contribution zone',
      pattern: /^limit_req_zone \$galata_contribution_client_key zone=galata_contribution_rate:10m rate=1r\/m;$/m,
    },
    {
      label: 'contribution connection zone',
      pattern: /^limit_conn_zone \$galata_contribution_client_key zone=galata_contribution_connections:10m;$/m,
    },
    {
      label: 'balanced contribution request burst',
      pattern: /^\s*limit_req zone=galata_contribution_rate burst=4 nodelay;\s*$/m,
    },
    {
      label: 'one concurrent contribution per client',
      pattern: /^\s*limit_conn galata_contribution_connections 1;\s*$/m,
    },
    {
      label: 'request-limit 429 status',
      pattern: /^\s*limit_req_status 429;\s*$/m,
    },
    {
      label: 'connection-limit 429 status',
      pattern: /^\s*limit_conn_status 429;\s*$/m,
    },
    {
      label: 'notice-level request-limit logging',
      pattern: /^\s*limit_req_log_level notice;\s*$/m,
    },
    {
      label: 'notice-level connection-limit logging',
      pattern: /^\s*limit_conn_log_level notice;\s*$/m,
    },
    {
      label: 'notice-enabled nginx error log',
      pattern: /^\s*error_log \/var\/log\/nginx\/galatadergisi\.org\/error\.log notice;\s*$/m,
    },
    {
      label: 'throttled JSON response',
      pattern: new RegExp([
        String.raw`return 429 '\{"ok":false,"code":"submission_throttled",`,
        String.raw`"message":"Çok fazla gönderi işleniyor\. `,
        String.raw`Lütfen bir dakika sonra tekrar deneyin\."\}';`,
      ].join('')),
    },
    {
      label: 'throttled named error response',
      pattern: /^\s*error_page 429 = @contribution_throttled;\s*$/m,
    },
    {
      label: 'throttled named location',
      pattern: /^\s*location @contribution_throttled \{\s*$/m,
    },
    {
      label: 'throttled Retry-After header',
      pattern: /^\s*add_header Retry-After "60" always;\s*$/m,
    },
    {
      label: 'throttled no-store header',
      pattern: /^\s*add_header Cache-Control "no-store" always;\s*$/m,
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
      label: 'enabled limiter dry-run mode',
      pattern: /\blimit_(?:req|conn)_dry_run\s+on;/,
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

if (!fs.existsSync(devNginxPath)) {
  failures.push('dev nginx configuration is missing');
} else {
  const devNginx = fs.readFileSync(devNginxPath, 'utf8');
  const devBoundary = fs.existsSync(sharedNginxPath)
    ? `${fs.readFileSync(sharedNginxPath, 'utf8')}\n${devNginx}`
    : devNginx;
  [
    [/server_name dev\.galatadergisi\.org;/, 'exact dev hostname'],
    [/X-Robots-Tag "noindex, nofollow, noarchive"/, 'dev noindex header'],
    [/location = \/robots\.txt \{[\s\S]*Disallow: \//, 'dev robots crawl denial'],
    [/proxy_pass http:\/\/galata_dev_server;/, 'isolated dev upstream'],
    [/galata_dev_contribution_rate/, 'isolated dev request limit'],
    [/\/var\/www\/dev\.galatadergisi\.org\/public/, 'isolated dev media root'],
    [/listen 127\.0\.0\.1:8080;/, 'loopback Cloudflare Tunnel origin listener'],
    [/location = \/healthz \{[\s\S]*Cache-Control "no-store, no-cache, must-revalidate"/, 'non-cacheable dev health'],
  ].forEach(([pattern, label]) => {
    if (!pattern.test(devNginx)) failures.push(`dev nginx configuration lacks ${label}`);
  });
  if (/\bauth_basic\b/.test(devBoundary)) {
    failures.push('dev nginx configuration contains origin basic authentication');
  }
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
