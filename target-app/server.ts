import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface Account {
  type: string;
  accountId: string;
}

interface SavingsDetail {
  balance: string;
  currency: string;
  status: string;
}

interface Member {
  id: string;
  name: string;
  accounts: Account[];
  savings: SavingsDetail;
}

const MEMBERS: Record<string, Member> = {
  '00123': {
    id: '00123',
    name: 'Ava Thompson',
    accounts: [
      { type: 'Checking', accountId: 'C-1001' },
      { type: 'Savings', accountId: 'S-2001' },
    ],
    savings: { balance: '4231.50', currency: 'USD', status: 'Active' },
  },
  '00456': {
    id: '00456',
    name: 'Marcus Lee',
    accounts: [
      { type: 'Checking', accountId: 'C-1002' },
      { type: 'Savings', accountId: 'S-2002' },
    ],
    savings: { balance: '812.09', currency: 'USD', status: 'Active' },
  },
  '00789': {
    id: '00789',
    name: 'Priya Natarajan',
    accounts: [
      { type: 'Checking', accountId: 'C-1003' },
      { type: 'Savings', accountId: 'S-2003' },
    ],
    savings: { balance: '15320.77', currency: 'USD', status: 'Frozen' },
  },
  '00500': {
    id: '00500',
    name: 'Jordan Reyes',
    accounts: [
      { type: 'Checking', accountId: 'C-1005' },
      { type: 'Savings', accountId: 'S-2005' },
    ],
    savings: { balance: '2200.00', currency: 'USD', status: 'Active' },
  },
  '00600': {
    id: '00600',
    name: 'Sam Okafor',
    accounts: [
      { type: 'Checking', accountId: 'C-1006' },
      { type: 'Savings', accountId: 'S-2006' },
    ],
    savings: { balance: '990.15', currency: 'USD', status: 'Active' },
  },
  '00700': {
    id: '00700',
    name: 'Riley Chen',
    accounts: [
      { type: 'Checking', accountId: 'C-1007' },
      { type: 'Savings', accountId: 'S-2007' },
    ],
    savings: { balance: '5310.40', currency: 'USD', status: 'Active' },
  },
};

const reauthenticated = new Set<string>();
const savingsLoadAttempts = new Map<string, number>();

export function resetFaultStateForTests(): void {
  reauthenticated.clear();
  savingsLoadAttempts.clear();
}

function sessionExpiredPage(id: string): string {
  return page(
    'Session Expired',
    `<h1>Session Expired</h1>
<p>Please sign in again to continue.</p>
<a href="/member/${escapeHtml(id)}?reauth=1">Sign in again</a>`,
  );
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)}</title>
</head>
<body>
${body}
</body>
</html>`;
}

function parseMode(): string {
  const flagIndex = process.argv.findIndex((arg) => arg === '--mode');
  if (flagIndex !== -1 && process.argv[flagIndex + 1]) {
    return process.argv[flagIndex + 1] as string;
  }
  const inline = process.argv.find((arg) => arg.startsWith('--mode='));
  if (inline) {
    return inline.split('=')[1] ?? 'semantic';
  }
  return 'semantic';
}

function createApp(appMode: string): express.Express {
  const legacy = appMode === 'legacy';
  const NOISE = legacy ? randomBytes(3).toString('hex') : '';

  const app = express();

  app.get('/', (_req, res) => {
    const searchField = legacy
      ? `<span>Member ID</span>
  <input name="memberId" type="text" id="f-${NOISE}" class="ipt-${NOISE}" />`
      : `<label for="memberId">Member ID</label>
  <input id="memberId" name="memberId" type="text" />`;

    res.type('html').send(
      page(
        'Member Search',
        `<h1>Member Search</h1>
<form action="/search" method="get">
  ${searchField}
  <button type="submit"${legacy ? ` id="btn-${NOISE}" class="act-${NOISE}"` : ''}>Search</button>
</form>`,
      ),
    );
  });

  app.get('/search', (req, res) => {
    const memberId = typeof req.query.memberId === 'string' ? req.query.memberId : '';
    const member = Object.prototype.hasOwnProperty.call(MEMBERS, memberId)
      ? MEMBERS[memberId]
      : undefined;

    const rows = member
      ? `<tr><td>${escapeHtml(member.id)}</td><td><a href="/member/${escapeHtml(member.id)}">${escapeHtml(member.name)}</a></td></tr>`
      : '';

    const body = member
      ? `<h1>Search Results</h1>
<table${legacy ? ` id="results-${NOISE}"` : ''}>
  <thead><tr><th>Member ID</th><th>Name</th></tr></thead>
  <tbody>${rows}</tbody>
</table>`
      : `<h1>Search Results</h1>
<p>No members found for ID "${escapeHtml(memberId)}".</p>`;

    res.type('html').send(page('Search Results', body));
  });

  app.get('/member/:id', (req, res) => {
    const { id } = req.params;
    const member = Object.prototype.hasOwnProperty.call(MEMBERS, id) ? MEMBERS[id] : undefined;

    if (!member) {
      res.status(404).type('html').send(page('Member Not Found', `<h1>Member Not Found</h1><p>No member with ID "${escapeHtml(id)}".</p>`));
      return;
    }

    if (id === '00500') {
      if (req.query.reauth === '1') reauthenticated.add(id);
      if (!reauthenticated.has(id)) {
        res.type('html').send(sessionExpiredPage(id));
        return;
      }
    }

    const accountItems = member.accounts
      .map((account) => {
        if (account.type === 'Savings') {
          return `<li><a href="/member/${escapeHtml(member.id)}/savings">${escapeHtml(account.type)} - ${escapeHtml(account.accountId)}</a></li>`;
        }
        return `<li>${escapeHtml(account.type)} - ${escapeHtml(account.accountId)}</li>`;
      })
      .join('\n    ');

    const body = `<h1>Member: ${escapeHtml(member.name)} (${escapeHtml(member.id)})</h1>
<h2>Accounts</h2>
<ul>
    ${accountItems}
</ul>`;

    res.type('html').send(page(`Member ${member.id}`, body));
  });

  app.get('/member/:id/savings', (req, res) => {
    const { id } = req.params;
    const member = Object.prototype.hasOwnProperty.call(MEMBERS, id) ? MEMBERS[id] : undefined;

    if (!member) {
      res.status(404).type('html').send(page('Member Not Found', `<h1>Member Not Found</h1><p>No member with ID "${escapeHtml(id)}".</p>`));
      return;
    }

    if (id === '00500' && !reauthenticated.has(id)) {
      res.type('html').send(sessionExpiredPage(id));
      return;
    }

    if (id === '00600') {
      const attempts = (savingsLoadAttempts.get(id) ?? 0) + 1;
      savingsLoadAttempts.set(id, attempts);
      if (attempts <= 2) {
        res
          .type('html')
          .send(
            page(
              'Savings Account',
              `<h1>Savings Account</h1>\n<p id="loading-indicator">Loading account details, please wait...</p>`,
            ),
          );
        return;
      }
    }

    const errorBanner =
      id === '00700'
        ? '<div role="alert">Application Error: unable to confirm the last transaction</div>\n'
        : '';

    const savingsValues = legacy
      ? `<table id="savings-${NOISE}">
  <tbody>
    <tr><td>Balance</td><td>${escapeHtml(member.savings.balance)}</td></tr>
    <tr><td>Currency</td><td>${escapeHtml(member.savings.currency)}</td></tr>
    <tr><td>Status</td><td>${escapeHtml(member.savings.status)}</td></tr>
  </tbody>
</table>`
      : `<dl>
  <dt>Balance</dt><dd>${escapeHtml(member.savings.balance)}</dd>
  <dt>Currency</dt><dd>${escapeHtml(member.savings.currency)}</dd>
  <dt>Status</dt><dd>${escapeHtml(member.savings.status)}</dd>
</dl>`;

    const body = `<h1>Savings Account</h1>
${errorBanner}<h2>${escapeHtml(member.name)} (${escapeHtml(member.id)})</h2>
${savingsValues}`;

    res.type('html').send(page('Savings Account', body));
  });

  app.get('/control', (_req, res) => {
    res.sendFile(join(__dirname, 'control.html'));
  });

  return app;
}

const mode = parseMode();

switch (mode) {
  case 'semantic':
  case 'legacy':
    break;
  default:
    console.error(`Unsupported --mode "${mode}". Only "semantic" and "legacy" are implemented.`);
    process.exit(1);
}

const app = createApp(mode);

export { app, createApp };

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const PORT = Number(process.env.PORT) || 3000;
  app.listen(PORT, () => {
    console.log(`target-app listening on http://localhost:${PORT} (mode: ${mode})`);
  });
}
