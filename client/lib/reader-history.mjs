// Copyright 2026 Mehmet Baker

export const READER_HISTORY_ACTION = Object.freeze({
  PUSH: 'push',
  REPLACE: 'replace',
  NONE: 'none',
});

export function initialIssueHistoryActions(action) {
  return {
    route: action,
    seo: action === READER_HISTORY_ACTION.NONE
      ? READER_HISTORY_ACTION.NONE
      : READER_HISTORY_ACTION.REPLACE,
  };
}

export function readerIssueRoute(issue, page, hash = '') {
  const issueNumber = Number(issue);
  const pageNumber = Number(page);
  const pathname = pageNumber === 1
    ? `/dergiler/sayi${issueNumber}`
    : `/dergiler/sayi${issueNumber}/${pageNumber}`;
  return `${pathname}${hash}`;
}

export function readerIssueFallbackTitle(issue, publishDateText) {
  return `Sayı ${Number(issue)}, ${publishDateText} | Galata Dergisi`;
}

export function homeHistoryState() {
  return { galataView: 'home' };
}

export function isHomeHistoryState(state) {
  return Boolean(state && state.galataView === 'home');
}

export function isIssueHistoryState(state, issue = null) {
  if (!state || state.galataView !== 'issue') return false;
  return issue === null || Number(state.issue) === Number(issue);
}

export function issueHistoryState(issue, page, options = {}) {
  const previousState = options.previousState;
  const preserveReturnTarget = isIssueHistoryState(previousState, issue);
  return {
    galataView: 'issue',
    issue: Number(issue),
    page: Number(page),
    returnToHome: preserveReturnTarget
      ? Boolean(previousState.returnToHome)
      : Boolean(options.returnToHome),
  };
}

export function shouldReturnToHome(state) {
  return isIssueHistoryState(state) && state.returnToHome === true;
}

export function updateReaderHistory(history, action, state, title, url) {
  if (action === READER_HISTORY_ACTION.NONE) return false;
  if (action === READER_HISTORY_ACTION.PUSH) {
    history.pushState(state, title, url);
    return true;
  }
  if (action === READER_HISTORY_ACTION.REPLACE) {
    history.replaceState(state, title, url);
    return true;
  }
  throw new Error(`Unknown reader history action: ${action}`);
}
