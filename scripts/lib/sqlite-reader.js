// Copyright 2026 Mehmet Baker
//
// Read-only SQLite access for build tooling on the pinned Node 24 runtime.

function openReadOnly(databasePath) {
  const { DatabaseSync } = require('node:sqlite');
  const database = new DatabaseSync(databasePath, {
    readOnly: true,
    enableForeignKeyConstraints: true,
  });

  return {
    all(sql, ...params) {
      return database.prepare(sql).all(...params);
    },
    get(sql, ...params) {
      return database.prepare(sql).get(...params);
    },
    close() {
      database.close();
    },
  };
}

module.exports = {
  openReadOnly,
};
