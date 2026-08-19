import assert from 'node:assert/strict';
import test from 'node:test';

import {
  homeHistoryState,
  initialIssueHistoryActions,
  issueHistoryState,
  readerIssueFallbackTitle,
  readerIssueRoute,
  READER_HISTORY_ACTION,
  shouldReturnToHome,
  updateReaderHistory,
} from '../client/lib/reader-history.mjs';

class FakeHistory {
  constructor(state, url) {
    this.entries = [{ state, title: '', url }];
    this.index = 0;
  }

  get state() {
    return this.entries[this.index].state;
  }

  pushState(state, title, url) {
    this.entries.splice(this.index + 1, Infinity, { state, title, url });
    this.index += 1;
  }

  replaceState(state, title, url) {
    this.entries[this.index] = { state, title, url };
  }

  back() {
    if (this.index > 0) this.index -= 1;
  }
}

test('builds stable fallback issue routes and titles without SEO metadata', () => {
  assert.equal(readerIssueRoute(47, 1), '/dergiler/sayi47');
  assert.equal(readerIssueRoute('47', '8'), '/dergiler/sayi47/8');
  assert.equal(
    readerIssueRoute(47, 8, '#ses-47-reading'),
    '/dergiler/sayi47/8#ses-47-reading',
  );
  assert.equal(
    readerIssueFallbackTitle(47, 'Mart - Nisan 2022'),
    'Sayı 47, Mart - Nisan 2022 | Galata Dergisi',
  );
});

test('homepage to issue pushes an entry and Back returns to the managed homepage', () => {
  const history = new FakeHistory(homeHistoryState(), '/');
  updateReaderHistory(
    history,
    READER_HISTORY_ACTION.PUSH,
    issueHistoryState(47, 1, { returnToHome: true }),
    'Issue 47',
    '/dergiler/sayi47',
  );

  assert.equal(history.entries.length, 2);
  assert.deepEqual(history.state, {
    galataView: 'issue', issue: 47, page: 1, returnToHome: true,
  });
  history.back();
  assert.deepEqual(history.state, homeHistoryState());
});

test('initial SEO navigation replaces the issue entry even when it resolves first', () => {
  const history = new FakeHistory(homeHistoryState(), '/');
  const actions = initialIssueHistoryActions(READER_HISTORY_ACTION.PUSH);

  updateReaderHistory(
    history,
    actions.route,
    issueHistoryState(47, 1, { returnToHome: true }),
    'Issue 47',
    '/dergiler/sayi47',
  );
  updateReaderHistory(
    history,
    actions.seo,
    issueHistoryState(47, 8, { previousState: history.state }),
    'Issue 47, page 8',
    '/dergiler/sayi47/8',
  );

  assert.equal(history.entries.length, 2);
  assert.deepEqual(history.state, {
    galataView: 'issue', issue: 47, page: 8, returnToHome: true,
  });
  history.back();
  assert.deepEqual(history.state, homeHistoryState());
});

test('initial history policy preserves replace and popstate actions', () => {
  assert.deepEqual(initialIssueHistoryActions(READER_HISTORY_ACTION.REPLACE), {
    route: READER_HISTORY_ACTION.REPLACE,
    seo: READER_HISTORY_ACTION.REPLACE,
  });
  assert.deepEqual(initialIssueHistoryActions(READER_HISTORY_ACTION.NONE), {
    route: READER_HISTORY_ACTION.NONE,
    seo: READER_HISTORY_ACTION.NONE,
  });
});

test('reloading an issue preserves only its existing homepage return target', () => {
  const fromHomepage = issueHistoryState(47, 1, { returnToHome: true });
  assert.deepEqual(
    issueHistoryState(47, 1, {
      previousState: fromHomepage,
      returnToHome: false,
    }),
    fromHomepage,
  );

  assert.deepEqual(
    issueHistoryState(47, 1, {
      previousState: issueHistoryState(46, 1, { returnToHome: true }),
      returnToHome: false,
    }),
    { galataView: 'issue', issue: 47, page: 1, returnToHome: false },
  );
  assert.deepEqual(
    issueHistoryState(47, 1, { previousState: null, returnToHome: false }),
    { galataView: 'issue', issue: 47, page: 1, returnToHome: false },
  );
});

test('page turns and track selections replace without losing returnToHome', () => {
  const history = new FakeHistory(
    issueHistoryState(47, 1, { returnToHome: true }),
    '/dergiler/sayi47',
  );
  const replaceIssue = (page, url) => updateReaderHistory(
    history,
    READER_HISTORY_ACTION.REPLACE,
    issueHistoryState(47, page, { previousState: history.state }),
    'Issue 47',
    url,
  );

  replaceIssue(8, '/dergiler/sayi47/8');
  replaceIssue(8, '/dergiler/sayi47/8#recording');
  assert.equal(history.entries.length, 1);
  assert.equal(history.state.returnToHome, true);
  assert.equal(history.state.page, 8);
});

test('switching issues pushes a distinct issue-level entry', () => {
  const history = new FakeHistory(
    issueHistoryState(46, 3, { returnToHome: true }),
    '/dergiler/sayi46/3',
  );
  updateReaderHistory(
    history,
    READER_HISTORY_ACTION.PUSH,
    issueHistoryState(47, 5, { returnToHome: false }),
    'Issue 47',
    '/dergiler/sayi47/5',
  );

  assert.equal(history.entries.length, 2);
  assert.deepEqual(history.state, {
    galataView: 'issue', issue: 47, page: 5, returnToHome: false,
  });
});

test('popstate application does not create or replace an entry', () => {
  const state = issueHistoryState(47, 5, { returnToHome: false });
  const history = new FakeHistory(state, '/dergiler/sayi47/5');
  assert.equal(updateReaderHistory(
    history,
    READER_HISTORY_ACTION.NONE,
    issueHistoryState(47, 8, { previousState: history.state }),
    'Issue 47',
    '/dergiler/sayi47/8',
  ), false);
  assert.equal(history.entries.length, 1);
  assert.equal(history.state, state);
});

test('close reuses an immediate homepage or pushes home for a direct issue', () => {
  const fromHome = issueHistoryState(47, 1, { returnToHome: true });
  const direct = issueHistoryState(47, 1, { returnToHome: false });
  assert.equal(shouldReturnToHome(fromHome), true);
  assert.equal(shouldReturnToHome(direct), false);

  const history = new FakeHistory(direct, '/dergiler/sayi47');
  updateReaderHistory(
    history,
    READER_HISTORY_ACTION.PUSH,
    homeHistoryState(),
    'Home',
    '/',
  );
  assert.equal(history.entries.length, 2);
  assert.deepEqual(history.state, homeHistoryState());
  history.back();
  assert.deepEqual(history.state, direct);
});
